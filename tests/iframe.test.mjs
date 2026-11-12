/**
 * iframe.test.mjs — the artifact must boot and paint inside a sandboxed frame
 * whose storage is confirmed dead, and must prove it by reporting from inside.
 *
 * WHY THE FRAME HAS TO ANNOUNCE ITSELF
 *
 * Every version of this test that relied on "no SecurityError surfaced as a page
 * error" was passing vacuously. That is also exactly what a frame that executed
 * nothing looks like. Verified by mutation: an artifact that calls
 * `localStorage.setItem` at boot does fail the test below, but a frame in which
 * the artifact never runs must fail too, so the frame posts a message about
 * itself and silence is treated as a harness fault rather than a pass.
 *
 * WHAT THIS DOES AND DOES NOT COVER
 *
 * The artifact is served over `https:` by a Playwright route (binding a port is
 * EPERM in this container, so there is no local server to use), which is the
 * shape of the advertised githack preview: an `http:` origin, sandboxed, with Web
 * Storage denied and inline script allowed. That is the context a visitor from
 * this organisation's front page actually lands in, and it is what this test
 * proves.
 *
 * It is NOT an opaque origin, and that gap is stated rather than papered over.
 * The opaque-origin case is the `srcdoc`+`file:`-parent shape, and in this
 * container Firefox does not execute inline scripts in such a frame at all (see
 * knowledge/environment.md) — so with the artifact being one inline script, an
 * opaque-origin run cannot be made to execute here, and a test that claimed it
 * would be asserting the absence of a document. What IS verified is that the
 * sandbox attribute itself is doing real work: the same frame without
 * `sandbox="allow-scripts"` passes storage through, so removing the attribute
 * turns this test red.
 *
 * A frame that has BOTH `srcdoc` and `src` keeps `srcdoc` authoritative, so the
 * artifact is loaded only after `srcdoc` is removed; forgetting that loads
 * nothing at all and, absent a self-report, looks like a pass.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { withBrowser, log } from './harness.mjs';

const engine = (() => {
  const i = process.argv.indexOf('--engine');
  return i === -1 ? 'firefox' : process.argv[i + 1];
})();

let passed = 0;
let failed = 0;
function test(name, fn) {
  return fn().then(
    () => { passed += 1; process.stdout.write(`ok - ${name}\n`); },
    (e) => { failed += 1; process.stdout.write(`not ok - ${name}\n    ${e.message}\n`); },
  );
}

/** Appended to the artifact so the frame can report its own state. */
const SELF_REPORT = [
  '  <script>',
  '  window.addEventListener("load", function () {',
  '    setTimeout(function () {',
  '      var o = { probe: "artifact" };',
  '      o.seam = (typeof window.ridgeline === "object");',
  '      o.floor = o.seam ? window.ridgeline.state.floorNumber : null;',
  '      var cs = document.querySelectorAll("canvas");',
  '      o.canvases = cs.length;',
  '      var painted = 0;',
  '      [].forEach.call(cs, function (c) {',
  '        try {',
  '          var g = c.getContext("2d");',
  '          if (!g) { painted += 1; return; }',
  '          var d = g.getImageData(0, 0, Math.min(c.width, 80), Math.min(c.height, 80)).data;',
  '          for (var j = 3; j < d.length; j += 4) { if (d[j] !== 0) { painted += 1; break; } }',
  '        } catch (e) { painted += 1; }',
  '      });',
  '      o.painted = painted;',
  '      try { void window.localStorage; o.localStorage = "accessible"; }',
  '      catch (e) { o.localStorage = "denied:" + e.name; }',
  '      try { void window.indexedDB; o.indexedDB = "accessible"; }',
  '      catch (e) { o.indexedDB = "denied:" + e.name; }',
  '      o.origin = String(window.location.origin);',
  '      parent.postMessage(o, "*");',
  '    }, 1200);',
  '  });',
  '  </script>',
  '',
].join('\n');

/**
 * Proves storage is dead using an `onload` attribute rather than an inline
 * script, so it reports truthfully even under a `file:` parent.
 */
const HOSTILE_CONTROL =
  '<!doctype html><html><body onload="(function(){var o={probe:\'control\'};' +
  'var ks=[\'localStorage\',\'sessionStorage\',\'indexedDB\'];' +
  'for(var i=0;i<3;i++){try{void window[ks[i]];o[ks[i]]=\'accessible\'}' +
  'catch(e){o[ks[i]]=\'denied:\'+e.name}}' +
  'o.origin=String(window.location.origin);parent.postMessage(o,\'*\')})()">' +
  'control</body></html>';

const PARENT = [
  '<!doctype html><html><body>',
  '<iframe id="hostile" sandbox="allow-scripts" style="width:880px;height:680px;border:0"></iframe>',
  '<script>',
  'window.__messages = [];',
  'window.addEventListener("message", function (ev) { window.__messages.push(ev.data); });',
  'document.getElementById("hostile").srcdoc = ' + JSON.stringify(HOSTILE_CONTROL) + ';',
  'window.loadArtifactIntoFrame = function (srcUrl) {',
  '  var f = document.getElementById("hostile");',
  '  f.removeAttribute("srcdoc");',
  '  f.src = srcUrl;',
  '};',
  '</script>',
  '</body></html>',
  '',
].join('\n');

const ARTIFACT_URL = 'https://artifact.invalid/index.html';
const PARENT_URL = 'https://host-parent.invalid/';

async function awaitMessage(page, probeName, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await page.evaluate((name) => {
      const idx = window.__messages.findIndex((m) => m && m.probe === name);
      if (idx === -1) { return null; }
      // Drain what we consume: an undrained buffer lets a later case read this
      // one's report and pass for reasons unrelated to it.
      const [msg] = window.__messages.splice(idx, 1);
      return msg;
    }, probeName);
    if (found) { return found; }
    await page.waitForTimeout(150);
  }
  return null;
}

/** A page hosting the sandboxed frame, with the control already reporting. */
async function openHostilePage(browser, context, bodyHtml) {
  await context.route(PARENT_URL, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: PARENT }));
  await context.route(ARTIFACT_URL, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: bodyHtml }));
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(PARENT_URL, { waitUntil: 'load' });
  return { page, problems };
}

await withBrowser(engine, async (browser) => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

  await test('the sandboxed frame reports storage as unavailable', async () => {
    const context = await browser.newContext({ viewport: { width: 940, height: 760 } });
    const { page } = await openHostilePage(browser, context, html);

    const control = await awaitMessage(page, 'control', 10000);
    assert.notEqual(control, null, 'control frame must report about itself; silence is a harness fault');
    log(`control: ${JSON.stringify(control)}`);

    // Judge the capability, not the mechanism: Firefox denies storage by giving
    // the frame an opaque origin, Chromium denies it while keeping a file://
    // origin. Gating on origin === "null" would call a valid Chromium run
    // non-hostile for the wrong reason.
    const denied = ['localStorage', 'sessionStorage'].filter((k) => String(control[k]).startsWith('denied'));
    assert.equal(denied.length, 2,
      `the frame must deny Web Storage, otherwise nothing here is hostile; got ${JSON.stringify(control)}`);
    log(`frame denies: ${denied.join(', ')} (origin=${control.origin})`);

    await context.close();
  });

  // Discriminates the sandbox from the origin. Both the control and the artifact
  // run in ONE frame, so if removing sandbox="allow-scripts" turns the control
  // red, the denial is attributable to the attribute and not to the http origin.
  await test('the storage denial is attributable to the sandbox attribute', async () => {
    const unsandboxed = PARENT.replace('<iframe id="hostile" sandbox="allow-scripts"',
                                       '<iframe id="hostile"');
    assert.notEqual(unsandboxed, PARENT, 'the mutation must actually change the parent');

    const context = await browser.newContext({ viewport: { width: 940, height: 760 } });
    await context.route(PARENT_URL, (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: unsandboxed }));
    const page = await context.newPage();
    await page.goto(PARENT_URL, { waitUntil: 'load' });

    const control = await awaitMessage(page, 'control', 10000);
    assert.notEqual(control, null, 'unsandboxed control frame must still report');
    const open = ['localStorage', 'sessionStorage'].filter((k) => control[k] === 'accessible');
    assert.equal(open.length, 2,
      `without sandbox="allow-scripts" Web Storage should be reachable, so the previous test's ` +
      `denial is attributable to the attribute; got ${JSON.stringify(control)}`);
    log(`unsandboxed frame exposes: ${open.join(', ')} — so the sandbox attribute is load-bearing`);

    await context.close();
  });

  await test('the artifact boots and paints inside the sandboxed frame, and says so itself', async () => {
    const context = await browser.newContext({ viewport: { width: 940, height: 760 } });
    const { page, problems } = await openHostilePage(
      browser, context, html.replace('</body>', SELF_REPORT + '</body>'));
    const control = await awaitMessage(page, 'control', 10000);
    assert.notEqual(control, null, 'control must report before any artifact result means anything');

    await page.evaluate((url) => window.loadArtifactIntoFrame(url), ARTIFACT_URL);
    const report = await awaitMessage(page, 'artifact', 20000);
    if (report === null) {
      const state = await page.evaluate(() => {
        const f = document.getElementById('hostile');
        return {
          buffered: window.__messages.length,
          src: f.getAttribute('src'),
          hasSrcdoc: f.hasAttribute('srcdoc'),
        };
      });
      assert.fail(`the artifact never announced itself; it may not have run at all. ` +
        `harness=${JSON.stringify(state)} pageErrors=${JSON.stringify(problems)}`);
    }
    assert.equal(report.seam, true, 'test seam present inside the hostile frame');
    assert.equal(report.floor, 1, 'first floor reached inside the hostile frame');
    assert.ok(report.canvases >= 1, 'canvas present inside the hostile frame');
    assert.ok(report.painted >= 1, 'canvas actually painted inside the hostile frame');
    // Reported, not asserted: over an https: origin storage is denied whether or
    // not the sandbox is doing it, so this line cannot discriminate. The control
    // frame above is what establishes that sandbox="allow-scripts" denies it.
    log(`artifact origin=${report.origin} localStorage=${report.localStorage} indexedDB=${report.indexedDB}`);
    // A page error from the harness must not be reported as an artifact defect,
    // but must not be swallowed either, so it is named in the message.
    assert.deepEqual(problems, [], `no page errors while the artifact ran (got ${problems.length})`);

    await context.close();
  });

  await test('boots under file:// with its seam and first floor', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await context.newPage();
    const problems = [];
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await page.goto(new URL('../index.html', import.meta.url).href, { waitUntil: 'load' });
    await page.waitForTimeout(600);
    const boot = await page.evaluate(() => ({
      seam: typeof window.ridgeline === 'object',
      floor: window.ridgeline.state.floorNumber,
    }));
    assert.ok(boot.seam, 'test seam present under file://');
    assert.equal(boot.floor, 1);
    assert.deepEqual(problems, []);
    await context.close();
  });

  log(`\n# iframe: pass ${passed} fail ${failed}`);
  process.exitCode = failed === 0 ? 0 : 1;
});
