/**
 * tools/capture-card.mjs — paint the showcase card image, docs/desktop.png.
 *
 * The front page builds each card at 2:1 (see thaumapolis.github.io's
 * tools/make_thumbs.py: THUMB_ASPECT). A card cropped out of a full-page
 * screenshot is what this replaces: the golden is 1280x860, so a 2:1 centre crop
 * of it landed on the middle of the help text and showed the reader a stretched
 * fragment of a paragraph. The card should show the game.
 *
 * So this captures the CANVAS at 2:1, not the page: the stage is sized to a 2.00
 * aspect, a floor is generated, the player is walked off the entrance tile, and
 * the clip is the canvas alone. Nothing else is on screen, so no caption needs
 * hiding.
 *
 * What the frame cannot contain is explored-but-unlit space. The renderer keeps no
 * map: `visibleSet` is recomputed from line of sight to the player on every draw
 * (see the comment above it in render.js -- remembering monsters was rejected on
 * purpose), so the picture is one lit disc around the player plus fog. Do not
 * describe the output as showing explored rooms; it does not, and no walk makes it
 * so. Measured on the 56x44 window this captures: the sight radius lights about 8%
 * of it, and a lit torch about 25%.
 *
 * Deterministic: fixed seed; reduced motion removes the bar-width transition that
 * makes ridgeline's own goldens depend on capture timing.
 *
 *   node tools/capture-card.mjs
 *
 * Re-run after anything that changes the view, or the card silently shows a stale
 * or cropped-away render.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = process.env.PLAYWRIGHT_ENTRY;
if (!entry) {
  process.stderr.write('PLAYWRIGHT_ENTRY is not set. Run under `nix develop`, or via ./tools/toolchain.sh\n');
  process.exit(1);
}
const { firefox } = await import(entry);

// The card aspect, matched to the front page. 1400x700 keeps the capture above
// the display size (~581 CSS px wide) so the card is a downscale, never an upscale.
const CARD_W = 1400;
const CARD_H = 700;
const SEED = 'card-capture-1';

const browser = await firefox.launch();
const context = await browser.newContext({
  viewport: { width: CARD_W, height: 1200 },
  deviceScaleFactor: 2,
  reducedMotion: 'reduce',
});
const page = await context.newPage();
page.on('pageerror', (e) => {
  process.stderr.write(`page error: ${e.message}\n`);
  process.exitCode = 1;
});
await page.goto(`file://${ROOT}/index.html`, { waitUntil: 'load' });
await page.waitForFunction(() => window.ridgeline && window.ridgeline.state);

await page.evaluate(({ seed, w, h }) => {
  const stage = document.getElementById('stage');
  stage.style.width = `${w}px`;
  stage.style.height = `${h}px`;
  window.ridgeline.start(seed);
}, { seed: SEED, w: CARD_W, h: CARD_H });
await page.waitForTimeout(300);

// Walk the player off the entrance tile, so the frame is not pinned to the spot
// the run begins on. It deliberately does NOT aim to reveal the dungeon: with no
// persistent map there is nothing for a walk to reveal.
await page.evaluate(() => {
  for (const k of ['s', 's', 'e', 'e', 's', 's', 'e', 'e', 'n', 'e', 'e', 's', 's', 's', 'w', 'w', 's', 'e', 'e', 'e']) {
    window.ridgeline.moveBy(k);
  }
});
await page.waitForTimeout(200);

const canvas = page.locator('#game');
const box = await canvas.boundingBox();
if (!box) {
  process.stderr.write('canvas has no box; nothing to capture\n');
  process.exit(1);
}
const ratio = box.width / box.height;
if (Math.abs(ratio - CARD_W / CARD_H) > 0.02) {
  process.stderr.write(`captured canvas is ${box.width}x${box.height} (ratio ${ratio.toFixed(3)}), not 2:1\n`);
  process.exit(1);
}

mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
await canvas.screenshot({ path: path.join(ROOT, 'docs', 'desktop.png') });
// Report where the capture landed. The pose is scripted, so this is the record of
// what the card actually shows; if it ever says `phase: dead` the walk walked into
// a monster and the card is a death screen with the overlay off-frame.
const pose = await page.evaluate(() => {
  const s = window.ridgeline.state;
  return { phase: s.phase, floor: s.floorNumber, pos: `${s.player.x},${s.player.y}`, turn: s.turn };
});
process.stdout.write(
  `wrote docs/desktop.png (${Math.round(box.width)}x${Math.round(box.height)} CSS) ` +
  `phase=${pose.phase} floor=${pose.floor} player=${pose.pos} turn=${pose.turn}\n`,
);

process.exit(process.exitCode ?? 0);
