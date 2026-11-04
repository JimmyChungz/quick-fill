import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Run the production visibility policy in actual layout, without an extension
// profile or any user browser state. jsdom geometry tests cover synthetic bounds.
test('vertical reachability rejects document traps and preserves scrollable forms', async () => {
  const bundle = await build({ entryPoints: ['src/lib/visibility.ts'], bundle: true, write: false, format: 'iife', globalName: 'VisibilityPolicy' });
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    async function load(html) {
      await page.setContent(`<!doctype html><html><body>${html}</body></html>`);
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
    }
    const visible = () => page.evaluate(() => VisibilityPolicy.isVisible(document.querySelector('input')));
    const reachable = () => page.evaluate(() => {
      const rect = document.querySelector('input').getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= innerHeight;
    });

    await load('<input style="position:absolute;top:-10000px">');
    assert.equal(await visible(), false, 'negative document position is unreachable');

    await load('<div style="height:1800px"></div><input>');
    assert.equal(await visible(), true, 'normal below-fold document field');
    assert.equal(await page.evaluate(() => scrollY), 0, 'visibility does not scroll');
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    assert.equal(await reachable(), true);
    assert.equal(await visible(), true, 'already scrolled document');

    // A huge positive absolute position expands the actual document. It is
    // reachable, unlike a mocked rectangle outside a finite scrollHeight.
    await load('<input style="position:absolute;top:1000000px">');
    assert.equal(await visible(), true, 'positive absolute field expands document bounds');
    assert.ok(await page.evaluate(() => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)) >= 1000021);
    await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    assert.equal(await reachable(), true);

    await load('<div style="height:100px;overflow:auto"><div style="height:1000px"></div><input></div>');
    assert.equal(await visible(), true, 'field past document bottom is reachable inside scroll container');
    assert.equal(await page.evaluate(() => document.querySelector('div').scrollTop), 0);
    await page.evaluate(() => { document.querySelector('div').scrollTop = 2000; });
    assert.equal(await reachable(), true);
    assert.equal(await visible(), true, 'already scrolled container');

    await load('<div style="height:100px;overflow:auto;transform:scale(2);transform-origin:top left"><div style="height:1000px"></div><input></div>');
    assert.equal(await visible(), true, 'scaled scroll container uses rendered scroll distances');

    await load('<div style="height:100px;overflow:auto"><input><div style="height:1000px"></div></div>');
    await page.evaluate(() => { document.querySelector('div').scrollTop = 2000; });
    assert.equal(await visible(), true, 'container field currently above the document is reachable by scrolling back');

    await load('<div style="height:100px;overflow:auto;position:relative"><input style="position:absolute;top:-10000px"><div style="height:1000px"></div></div>');
    assert.equal(await visible(), false, 'negative scroller trap cannot be reached');

    await load('<div style="height:3000px"></div><input style="position:fixed;top:1800px">');
    assert.equal(await visible(), false, 'document scrolling cannot reveal a fixed field');

    await load('<div style="overflow:hidden;height:1px;width:1px"><input style="position:fixed;top:100px;left:100px"></div>');
    assert.equal(await visible(), true, 'fixed field escapes a static clipping ancestor');

    await load('<div style="overflow:hidden;height:1px;width:1px;transform:translateX(0)"><input style="position:fixed;top:100px;left:100px"></div>');
    assert.equal(await visible(), false, 'transformed containing block still clips fixed field');
  } finally {
    await browser.close();
  }
});
