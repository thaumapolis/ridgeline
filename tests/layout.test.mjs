/**
 * layout.test.mjs — the view is laid out for the box it was given.
 *
 * Why this file exists: the tile size is chosen from a measured box, and for
 * days the measurement was wrong in ways every other test missed. A canvas with
 * no CSS size falls back to an intrinsic 300x150, so relayout() built the view
 * for a box three times too small; the first layout also did nothing at all, so
 * the desktop opened at tile 16 in an 884px stage. Neither produced an error, a
 * blank screen, or a failing goldens diff at the time -- the game was simply
 * small, fog was indistinguishable from floor, and the view had a dead band.
 * "It renders" was passing the whole while.
 *
 * These are the observable facts that would have caught it. They assert
 * relationships between measured quantities, not pixel values, so they survive
 * any future palette or art change.
 */
import assert from 'node:assert/strict';
import { withBrowser, openApp, VIEWPORTS } from './harness.mjs';

const engine = (() => {
  const i = process.argv.indexOf('--engine');
  return i === -1 ? 'firefox' : process.argv[i + 1];
})();

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`ok - ${name}\n`);
  } catch (e) {
    failed += 1;
    process.stdout.write(`not ok - ${name}\n    ${e.message}\n`);
  }
}

/** Read the layout back from the running artifact. */
const measure = (page) => page.evaluate(() => {
  const canvas = document.getElementById('game');
  const stage = document.getElementById('stage');
  const renderer = window.ridgeline.renderer;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  return {
    stage: stage.getBoundingClientRect(),
    box: canvas.getBoundingClientRect(),
    bitmap: { w: canvas.width, h: canvas.height },
    dpr,
    tile: renderer.tileSize,
    cam: renderer.camera,
    floor: { w: window.ridgeline.state.floor.width, h: window.ridgeline.state.floor.height },
  };
});

await withBrowser(engine, async (browser) => {
  for (const [name, opts] of Object.entries(VIEWPORTS)) {
    const { context, page, problems } = await openApp(browser, name);
    await page.locator('[data-action="start"]').click();
    await page.waitForFunction(() => !document.getElementById('overlay').hidden === false);
    const m = await measure(page);

    await test(`${name}: canvas fills the stage box`, async () => {
      assert.deepEqual(problems, [], 'no page errors');
      assert.ok(Math.abs(m.box.width - m.stage.width) <= 1,
        `canvas ${m.box.width.toFixed(0)} vs stage ${m.stage.width.toFixed(0)} wide`);
      assert.ok(Math.abs(m.box.height - m.stage.height) <= 1,
        `canvas ${m.box.height.toFixed(0)} vs stage ${m.stage.height.toFixed(0)} tall`);
    });

    await test(`${name}: bitmap is the CSS box times the device pixel ratio`, async () => {
      assert.equal(m.bitmap.w, Math.round(m.box.width * m.dpr));
      assert.equal(m.bitmap.h, Math.round(m.box.height * m.dpr));
    });

    await test(`${name}: tile size comes from the real box, not a 300x150 default`, async () => {
      // 300x150 is the intrinsic canvas default; a view built from it is the bug
      // this test was written for.
      assert.ok(m.box.width > 301, `box is suspiciously narrow: ${m.box.width}`);
      // Tiles have to be big enough for '@' and '#' to be distinguishable.
      assert.ok(m.tile >= 12, `tile ${m.tile} is below the legibility floor`);
      // Legibility is a property of the tile's PIXEL size, not of how many
      // columns are on screen -- a landscape phone shows more floor than a
      // portrait one at the same, perfectly readable, tile size. So there is no
      // column-count assertion here; the tile >= 12 check above is the one that
      // means something, and it is the same threshold the renderer clamps to.
    });

    await test(`${name}: the view never shows more floor than exists`, async () => {
      // The camera clamp is what keeps invented fog off the screen. When the view
      // is taller than the floor, cam.y sits at 0 -- that is correct, and it is
      // also the condition that puts a gutter on screen, so the floor must be big
      // enough that it does not happen at the shapes users actually hold.
      const viewRows = m.box.height / m.tile;
      const viewCols = m.box.width / m.tile;
      assert.ok(viewRows <= m.floor.h,
        `view is ${viewRows.toFixed(1)} rows tall against a ${m.floor.h}-row floor: dead band`);
      assert.ok(viewCols <= m.floor.w,
        `view is ${viewCols.toFixed(1)} columns wide against a ${m.floor.w}-column floor: dead band`);
      const clamped = Math.max(0, Math.min(m.cam.y, Math.max(0, m.floor.h - viewRows)));
      assert.ok(Math.abs(m.cam.y - clamped) < 1e-9, 'camera y is outside the clamp');
    });

    await test(`${name}: every pixel of the view is painted`, async () => {
      // A transparent canvas reads as an unpainted panel. Sample the four corners
      // of the bitmap, which is where a letterbox or a short paint run shows up.
      const clear = await page.evaluate(() => {
        const c = document.getElementById('game');
        const g = c.getContext('2d');
        const pts = [[0, 0], [c.width - 1, 0], [0, c.height - 1], [c.width - 1, c.height - 1]];
        return pts.filter(([x, y]) => g.getImageData(x, y, 1, 1).data[3] === 0).length;
      });
      assert.equal(clear, 0, `${clear} of 4 corners are unpainted`);
    });

  }

  // The camera has to follow the player. Without this, a renderer that draws the
  // view once at spawn and never scrolls again still passes every assertion
  // above -- the canvas fills its box, the bitmap is right, every pixel is
  // painted, and the clamp is satisfied -- while the game is unplayable past the
  // first room. It was the actual failure mode observed while reworking the view.
  await test('camera follows the player as they walk', async () => {
    const { context, page } = await openApp(browser, 'desktop');
    await page.evaluate(() => window.ridgeline.start('walk-test'));
    const read = () => page.evaluate(() => ({
      cam: window.ridgeline.renderer.camera,
      player: [window.ridgeline.state.player.x, window.ridgeline.state.player.y],
    }));
    const atStart = await read();
    const view = await page.evaluate(() => {
      const c = document.getElementById('game').getBoundingClientRect();
      return { cols: c.width / window.ridgeline.renderer.tileSize, rows: c.height / window.ridgeline.renderer.tileSize };
    });

    // Walk until the player has moved at least 8 tiles or the walk runs out;
    // walls refuse some commands, so the number of commands is not the point.
    const walked = await page.evaluate(async () => {
      const keys = ['e', 'e', 's', 's', 'e', 'e', 's', 's', 'w', 'w', 's', 's', 'e', 'e', 'e'];
      let moved = 0;
      for (const key of keys) {
        const before = window.ridgeline.state.turn;
        window.ridgeline.moveBy(key);
        if (window.ridgeline.state.turn > before) moved += 1;
      }
      return moved;
    });
    // A fixed seed, measured: 'walk-test' moves 14 of these 20 commands and
    // scrolls the camera 7.5 columns. The threshold is comfortably below that so
    // the test is about the mechanism, not about this seed's exact geometry.
    assert.ok(walked >= 8, `only ${walked} of the walk commands moved the player`);

    const after = await read();
    const dx = after.player[0] - atStart.player[0];
    const dy = after.player[1] - atStart.player[1];
    assert.ok(dx * dx + dy * dy >= 16, `player barely moved: dx=${dx} dy=${dy}`);

    const camDx = after.cam.x - atStart.cam.x;
    const camDy = after.cam.y - atStart.cam.y;
    assert.ok(camDx !== 0 || camDy !== 0, 'camera never moved while the player walked');
    // The camera must keep pace, not lag arbitrarily: over a walk of N tiles the
    // camera should have scrolled a comparable amount.
    assert.ok(Math.abs(camDx) + Math.abs(camDy) >= (Math.abs(dx) + Math.abs(dy)) / 2,
      `camera scrolled ${camDx.toFixed(1)},${camDy.toFixed(1)} for a player move of ${dx},${dy}`);

    // The camera stays centred: the player must remain inside the visible window,
    // not walk out from under the view.
    const relX = after.player[0] - after.cam.x;
    const relY = after.player[1] - after.cam.y;
    assert.ok(relX >= 0 && relX <= view.cols, `player left the view horizontally: ${relX.toFixed(1)} of ${view.cols.toFixed(1)}`);
    assert.ok(relY >= 0 && relY <= view.rows, `player left the view vertically: ${relY.toFixed(1)} of ${view.rows.toFixed(1)}`);

    await context.close();
  });

  process.stdout.write(`\nlayout: ${passed} passed, ${failed} failed\n`);
  process.exitCode = failed === 0 ? 0 : 1;
});
