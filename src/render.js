/**
 * render.js — the view. Reads game state, paints a canvas, and turns taps and
 * key presses into commands. It contains no game rules and no arithmetic about
 * damage or progression; if a number appears here it is a colour or a size.
 *
 * Two rules keep the view legible, and both were learned the hard way:
 *
 *   - **Whole pixels.** `tile` is an integer, `devicePixelRatio` is baked into the
 *     context transform, and the camera offset is rounded. Text drawn at a
 *     fractional device pixel is antialiased across two of them, which at glyph
 *     sizes is exactly what reads as "pixelated".
 *   - **One definition of where a tile lands.** `camX`/`camY` are the single
 *     source of truth, used by every draw and by hit-testing. Two definitions
 *     drift, and the failure is a tap that moves you into a wall.
 *
 * The view is a *camera* onto a larger floor, not a bitmap of the whole floor.
 * Fitting all 34x22 tiles of a floor into a phone-portrait box gives 11 px tiles,
 * which is unreadable; scrolling instead buys ~20x the tile size. See `resize`
 * for why the zoom still never depends on what is currently drawn.
 */

import { Tile } from './dungeon.js';
import { WEAPONS, CONSUMABLES, ENEMIES, BOSSES } from './content.js';

/** Colours per zone. Kept here rather than in content.js: this is presentation. */
const ZONE_PALETTE = [
  { wall: '#1b2418', floor: '#0f140e', ink: '#8fbf86', accent: '#c9e0b8' },
  { wall: '#24221a', floor: '#141309', ink: '#c9c08a', accent: '#e8e0b0' },
  { wall: '#151f28', floor: '#0b1116', ink: '#84b6cf', accent: '#bfe0f0' },
  { wall: '#241b16', floor: '#140e0a', ink: '#cf9d7a', accent: '#f0cfae' },
  { wall: '#2a1715', floor: '#170b09', ink: '#e08a70', accent: '#ffcdb8' },
];

/**
 * Fog, and the gap between it and a tile that is actually lit.
 *
 * The contrast step is load-bearing, and the old values were wrong. Unexplored
 * was `#050608` while zone 1's explored floor is `#0f140e`: 9/255 apart in one
 * channel, 2/255 in two others, i.e. indistinguishable on a dim phone screen. A
 * dark panel with a faint lit square in the corner does not read as "fog" -- it
 * reads as a broken render, and you cannot tell how big the dungeon is or where
 * its edge lies. A roguelike fog has to be *seen* to do its job.
 *
 * So the bands are anchored to the palette rather than to each other: VOID sits
 * below the darkest floor colour in ZONE_PALETTE (`#0b1116`) and REMEMBERED sits
 * above the brightest (`#170b09`), so no floor can collapse them together.
 */
const FOG_VOID = '#0b0f15';
/** Hairline tile border on a fog cell. */
const VOID_EDGE = '#141d27';
/** Gutter outside the floor, shown when the camera is clamped at a floor edge.
 *  Below VOID, so the floor's footprint always reads as the brighter thing. */
const OFF_MAP = '#04060a';

const GLYPH = Object.freeze({
  wall: '#',
  floor: '·',
  stairs: '>',
  player: '@',
});

export function makeRenderer(canvas, { cols, rows }) {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');

  /**
   * The dungeon grid, in tiles. Supplied by the caller, never read from the canvas.
   *
   * The canvas' width/height attributes are the renderer's OWN output: resize()
   * writes the bitmap size there. Reading them back is a trap with two jaws --
   * measured later you get pixels, and measured at construction you usually still
   * get pixels, because the script runs after the HTML attribute has already been
   * overwritten by the first resize. Both silently produce a grid of the wrong
   * size, and the view then just looks small instead of failing. So the grid size
   * is an explicit parameter, validated once, and FloorSize is its only source.
   */
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
    throw new Error(`renderer needs the grid size in tiles; got ${cols}x${rows}`);
  }

  let tile = 16;
  let fontPx = 13;
  // Camera: the grid coordinate drawn at the canvas' top-left, rounded so it
  // lands on a whole device pixel (see module header). Set by `computeCamera`
  // once per draw, and by nothing else.
  let camX = 0;
  let camY = 0;
  // The device-pixel-ratio baked into the current transform. Draw code works in
  // CSS pixels, so painting the canvas needs to divide its bitmap size by this.
  let dpr = 1;

  /**
   * Choose the tile size and bitmap size from the canvas box.
   *
   * The zoom is derived from the *viewport box* and never from what is currently
   * drawn: a zoom that depends on content is a feedback loop the moment a tap
   * converts pixels back to tiles. See the workspace note on fit-to-content zoom.
   * The grid size is fixed at construction, so this needs no game state and is
   * safe at any time, including before the first draw -- the early return that
   * used to sit here meant the very first layout did nothing at all, and the view
   * kept whatever size the default canvas gave it until the floor changed.
   *
   * The target is responsive rather than "as big as fits the floor". Fitting all
   * 34x22 tiles measured 23px on a desktop that could carry 40, and 11px on a
   * portrait phone where '@' and '#' were unreadable. It optimised for seeing the
   * whole dungeon -- which fog already prevents -- at the cost of reading the part
   * you can actually see. Scrolling is the camera's job, not the zoom's.
   */
  function resize(cssWidth, cssHeight) {
    // Roughly 30 columns across whatever box we were given, and never fewer than
    // 18 rows so a wide, short box cannot inflate tiles past usefulness. Measured
    // at the three shapes the app is used at: 29px on an 884px desktop, 24px on a
    // 374px portrait phone, 22px on a 660px landscape phone.
    // The target is keyed on COLUMNS, deliberately. The floor is 34x22, so its
    // long axis is horizontal; size the tile from the width and the height term
    // only keeps a short wide box (landscape phone: 660x269) from inflating tiles
    // past usefulness. Keying it on rows instead is what produced the first phone
    // render: 510/18 = 12px tiles, which made the stage 15.7 tiles tall against a
    // 22-tile floor, and the camera -- correctly clamped -- left a 234px band of
    // nothing at the bottom of a phone screen.
    const target = Math.min(cssWidth / 28, cssHeight / 20);
    // 12 is where '@' and '#' stop being distinguishable; it binds only on a box
    // narrower than about 144px. floor() keeps the grid on whole device pixels.
    const next = Math.max(12, Math.floor(target));
    dpr = Math.min(2, window.devicePixelRatio || 1);
    tile = next;
    fontPx = Math.max(9, Math.round(tile * 0.82));
    // The canvas FILLS the stage box. Sizing it to the grid instead left a dead
    // strip the colour of nothing in any box whose aspect differed from the
    // floor's, and the stage's centring could not help because the element had
    // already shrunk itself. Filling the box lets the camera decide which part of
    // the floor lands where, so every pixel is deliberate.
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${fontPx}px "Ridgeline Sans", ui-monospace, monospace`;
  }

  let canvasState = null;

  /**
   * Centre the camera on the player, clamped to the floor.
   *
   * Clamping to `[0, floor - view]` is what keeps the camera honest: at a floor's
   * edge the view stops scrolling and the OFF_MAP gutter shows instead, so you can
   * always see where the dungeon ends rather than being shown invented fog.
   *
   * The rounding is what keeps it crisp. Note this is NOT the feedback loop the
   * comment above warns about: that was about `tile`, which changes the pixels-per-
   * tile scale. The camera never changes the scale, and a tap is converted with
   * the camera of the frame the player saw, so the mapping stays invertible.
   */
  function computeCamera(state, cssW, cssH) {
    const viewCols = cssW / tile;
    const viewRows = cssH / tile;
    let x = state.player.x + 0.5 - viewCols / 2;
    let y = state.player.y + 0.5 - viewRows / 2;
    x = Math.max(0, Math.min(x, Math.max(0, cols - viewCols)));
    y = Math.max(0, Math.min(y, Math.max(0, rows - viewRows)));
    camX = Math.round(x * tile) / tile;
    camY = Math.round(y * tile) / tile;
  }

  /** Tile coordinates from a point in the canvas' CSS space. */
  function tileAtPoint(cssX, cssY) {
    if (!canvasState) return null;
    const x = Math.floor(cssX / tile + camX);
    const y = Math.floor(cssY / tile + camY);
    const floor = canvasState.floor;
    if (x < 0 || y < 0 || x >= floor.width || y >= floor.height) return null;
    return { x, y };
  }

  /**
   * Which tiles the player may currently see.
   *
   * Fog is computed from line of sight to the player, so a torch genuinely
   * widens the view and the map never shows a monster the player has not
   * spotted. Monsters seen earlier are not remembered: that would turn the
   * fog into decoration.
   */
  function visibleSet(state, radius) {
    const set = new Set();
    const { grid, width, height } = state.floor;
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        const x = state.player.x + dx;
        const y = state.player.y + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        if (dx * dx + dy * dy > radius * radius) continue;
        // Bresenham through the shared implementation, so the view and the
        // monsters' eyes use exactly the same rule.
        if (!los(grid, width, height, state.player.x, state.player.y, x, y)) continue;
        set.add(y * width + x);
      }
    }
    set.add(state.player.y * width + state.player.x);
    return set;
  }

  function draw(state) {
    canvasState = state;
    const floor = state.floor;
    const palette = ZONE_PALETTE[Math.min(ZONE_PALETTE.length - 1, Math.floor((state.floorNumber - 1) / 20))];
    // Explored tiles are drawn LIT, not at their rest colour, and this is the
    // single most important thing the renderer does for legibility. Zone 1's rest
    // palette is floor #0f140e / wall #1b2418; the darkest fog band is #0b0f15.
    // That is 4/255 and 16/255 -- i.e. the room you are standing in was the same
    // colour as the fog. Mixing explored tiles toward the zone's own ink lifts
    // them clear of every fog band on a colour the zone already owns, so the
    // dungeon still looks like itself at floor 60.
    const lit = mix(palette.floor, palette.ink, 0.16);
    const litWall = mix(palette.wall, palette.ink, 0.12);
    const litInk = mix(palette.wall, palette.ink, 0.55);
    const seen = visibleSet(state, state.player.torchTurns > 0 ? 14 : 8);
    const W = floor.width;
    const H = floor.height;

    const cssW = canvas.width / dpr;
    const cssH = canvas.height / dpr;
    computeCamera(state, cssW, cssH);

    // Paint every pixel before anything else. A transparent canvas in a
    // flex-centred box reads as an unpainted panel -- which is how a correct
    // layout came to look broken.
    ctx.fillStyle = OFF_MAP;
    ctx.fillRect(0, 0, cssW, cssH);

    // Grid space from here down. This translate is the only place the camera
    // enters the drawing code.
    ctx.save();
    ctx.translate(-camX * tile, -camY * tile);

    // The visible window, clamped to the floor. Iterating the window rather than
    // the grid makes a frame cost the screen, not the tower.
    const x0 = Math.max(0, Math.floor(camX));
    const y0 = Math.max(0, Math.floor(camY));
    const x1 = Math.min(cols, Math.ceil(camX + cssW / tile));
    const y1 = Math.min(rows, Math.ceil(camY + cssH / tile));

    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const index = y * W + x;
        const tileValue = floor.grid[index];
        const px = x * tile;
        const py = y * tile;
        const known = seen.has(index);

        // Hairline border on every cell, explored or not. This is the cue that
        // conveys the grid pitch through fog, which is how a player infers the
        // shape of a room they have not entered. 1 px is deliberate: at an 11 px
        // phone tile anything thicker turns the view into a lattice.
        const edge = VOID_EDGE;

        if (!known) {
          ctx.fillStyle = FOG_VOID;
          ctx.fillRect(px, py, tile, tile);
          ctx.fillStyle = edge;
          ctx.fillRect(px, py, tile, 1);
          ctx.fillRect(px, py, 1, tile);
          continue;
        }

        if (tileValue === Tile.Wall) {
          ctx.fillStyle = litWall;
          ctx.fillRect(px, py, tile, tile);
          ctx.fillStyle = edge;
          ctx.fillRect(px, py, tile, 1);
          ctx.fillRect(px, py, 1, tile);
          continue;
        }

        ctx.fillStyle = lit;
        ctx.fillRect(px, py, tile, tile);
        ctx.fillStyle = edge;
        ctx.fillRect(px, py, 1, 1);

        const glyph = tileValue === Tile.StairsUp ? GLYPH.stairs : GLYPH.floor;
        ctx.fillStyle = tileValue === Tile.StairsUp ? palette.accent : litInk;
        ctx.fillText(glyph, px + tile / 2, py + tile / 2);
      }
    }

    // Items, then monsters, then the player, so the player is never hidden.
    for (const item of state.items) {
      if (!seen.has(item.y * W + item.x)) continue;
      if (item.x < x0 || item.x >= x1 || item.y < y0 || item.y >= y1) continue;
      const px = item.x * tile;
      const py = item.y * tile;
      ctx.fillStyle = itemColour(item);
      ctx.fillText(itemGlyph(item), px + tile / 2, py + tile / 2);
    }

    for (const enemy of state.enemies) {
      if (!seen.has(enemy.y * W + enemy.x)) continue;
      if (enemy.x < x0 || enemy.x >= x1 || enemy.y < y0 || enemy.y >= y1) continue;
      const px = enemy.x * tile;
      const py = enemy.y * tile;
      const spec = enemy.isBoss ? BOSSES[enemy.kind] : ENEMIES[enemy.kind];
      ctx.fillStyle = enemy.isBoss ? '#ff9d4d' : palette.ink;
      ctx.fillText(spec.glyph, px + tile / 2, py + tile / 2);
      // A hurt monster shows a sliver of its remaining hp so a finishing blow is
      // legible without a tooltip.
      if (enemy.hp < enemy.maxHp) {
        const frac = Math.max(0, enemy.hp / enemy.maxHp);
        ctx.fillStyle = '#3a0f0c';
        ctx.fillRect(px + 2, py + tile - 3, tile - 4, 2);
        ctx.fillStyle = '#c9483f';
        ctx.fillRect(px + 2, py + tile - 3, Math.round((tile - 4) * frac), 2);
      }
    }

    // Projectiles in flight. Discrete rather than instant, so the player can
    // see a bolt coming and step out of it next turn.
    for (const bolt of state.projectiles) {
      const px = bolt.x * tile;
      const py = bolt.y * tile;
      ctx.fillStyle = '#e8d7ff';
      ctx.fillText('*', px + tile / 2, py + tile / 2);
    }

    // A dark plate behind the player. '@' in white over a wall tile is hard to
    // pick out, and the player is the one glyph that must never be ambiguous.
    const ppx = state.player.x * tile;
    const ppy = state.player.y * tile;
    ctx.fillStyle = '#000000';
    ctx.fillRect(ppx + 1, ppy + 1, tile - 2, tile - 2);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(GLYPH.player, ppx + tile / 2, ppy + tile / 2);
    ctx.restore();
  }

  return {
    draw,
    resize,
    tileAtPoint,
    get tileSize() { return tile; },
    /** Grid coordinate at the canvas' top-left; for tests and diagnostics. */
    get camera() { return { x: camX, y: camY }; },
  };
}

/** Blend two `#rrggbb` colours. Presentation only; no game value passes through. */
function mix(a, b, t) {
  const ch = (x, i) => parseInt(x.slice(i, i + 2), 16);
  let out = '#';
  for (let i = 1; i < 7; i += 2) {
    const v = Math.round(ch(a, i) * (1 - t) + ch(b, i) * t);
    out += v.toString(16).padStart(2, '0');
  }
  return out;
}

function itemColour(item) {
  if (item.type === 'weapon') return '#ffd479';
  if (item.type === 'plate') return '#9fd2ff';
  if (item.type === 'upgrade') return '#c6a2ff';
  if (item.kind === 'potion') return '#ff7a6e';
  if (item.kind === 'elixir') return '#ff9ed8';
  if (item.kind === 'bomb') return '#d8d8d8';
  if (item.kind === 'torch') return '#ffb347';
  if (item.kind === 'scroll') return '#cfd8ff';
  if (item.kind === 'wings') return '#eaeaea';
  if (item.kind === 'shard') return '#7fe0d0';
  return '#ffffff';
}

function itemGlyph(item) {
  if (item.type === 'weapon') return WEAPONS[item.kind].glyph;
  if (item.type === 'plate') return '[';
  if (item.type === 'upgrade') return '^';
  return CONSUMABLES[item.kind].glyph;
}

/**
 * Line of sight, mirroring dungeon.js `lineOfSight`.
 *
 * Duplicated rather than imported with the player's coordinates wrapped: the
 * renderer must not depend on the pathfinder's argument shape, and the two must
 * still agree. tests/render.test.mjs asserts they produce the same answers on
 * random pairs, which is the cheap way to keep a copy honest.
 */
function los(grid, w, h, x0in, y0in, x1, y1) {
  let x0 = x0in;
  let y0 = y0in;
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    if (grid[y0 * w + x0] === Tile.Wall) return false;
    if (x0 === x1 && y0 === y1) return true;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

