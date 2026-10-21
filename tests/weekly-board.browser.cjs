// Fully intercepted fixture: never reads or changes the live coordinator's data.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {chromium} = require(process.env.PLAYWRIGHT_PATH || 'playwright');
(async () => {
  const origin = 'http://localhost:49240', errors = [], now = '2026-10-06T02:00:00Z';
  const projects = ['one', 'two'].map(id => ({id, name: 'Weekly board ' + id, root: 'C:/fixture/' + id, createdAt: now}));
  const note = (id, createdAt, title = id) => ({id, createdAt, title, text: 'Fixture text', authorAgentId: 'fixture.author', tags: []});
  const notes = [note('latest', now, '<img src=x onerror=alert(1)>'), note('monday', '2026-10-04T15:00:00Z'),
    note('sunday', '2026-10-04T14:59:59Z', 'older searchable'), note('new-year', '2026-01-04T15:00:00Z'),
    note('cross-year', '2025-12-31T12:00:00Z'), note('unknown', 'invalid')];
  let snapshots = 0;
  const browser = await chromium.launch({...(process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {}), headless: true});
  try {
    const context = await browser.newContext({viewport: {width: 1280, height: 960}, timezoneId: 'America/Los_Angeles'});
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      assert.equal(url.origin, origin); assert.equal(request.method(), 'GET', 'No live mutations');
      let value;
      if (url.pathname === '/api/bootstrap') value = {token: 'fixture', snapshot: {projects, cursor: 1}};
      else if (url.pathname === '/api/projects') value = {projects};
      else if (url.pathname.startsWith('/api/projects/')) {
        snapshots++; value = {project: projects.find(p => p.id === url.pathname.split('/').at(-1)), notes, agents: [], messages: [], events: [], cursor: 1};
      }
      if (value) return route.fulfill({json: value});
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      assert.ok(['index.html', 'app.js', 'styles.css', 'icons.js', 'roadmap.js'].includes(name));
      return route.fulfill({body: await fs.readFile(path.join(__dirname, '../public', name), 'utf8'), contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html'});
    });
    const page = await context.newPage(); page.setDefaultTimeout(8000);
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin); await page.locator('#tab-board').click();
    await page.locator('.note-week').first().waitFor();
    assert.deepEqual(await page.locator('.note-week').evaluateAll(nodes => nodes.map(n => n.dataset.week)), ['2026-10-05', '2026-09-28', '2026-01-05', '2025-12-29', 'undated']);
    assert.equal(await page.locator('.note-week').first().locator('.note-item').count(), 2, 'JST Monday boundary');
    assert.match(await page.locator('[data-key="monday"] time').innerText(), /2026.*10.*05.*00:00/, 'Displayed date agrees with JST folder even outside Japan');
    assert.equal(await page.locator('.note-week[open]').count(), 1);
    assert.equal(await page.locator('.note-item').count(), notes.length, 'No lost or duplicate notes');
    assert.equal(await page.locator('.note-item img').count(), 0, 'Content stays escaped');
    const old = page.locator('[data-week="2026-09-28"]');
    await old.locator('summary').focus(); await page.keyboard.press('Enter');
    assert.equal(await old.evaluate(n => n.open), true, 'Keyboard expands folder');
    const before = snapshots; await page.locator('#refresh-button').click();
    await page.waitForFunction(() => document.getElementById('refresh-button').getAttribute('aria-busy') === 'false');
    assert.ok(snapshots > before); assert.equal(await old.evaluate(n => n.open), true, 'Polling preserves folder state');
    await old.locator('summary').click();
    await page.locator('#note-search').fill('older searchable');
    assert.equal(await page.locator('.note-week').count(), 1); assert.equal(await old.evaluate(n => n.open), true, 'Search opens matching old week');
    await page.locator('#note-search').fill('');
    assert.equal(await old.evaluate(n => n.open), false, 'Clearing search restores collapsed state');
    await page.locator('#language-select').selectOption('ja');
    assert.match(await page.locator('.note-week-help').innerText(), /日本時間/);
    await page.locator('#language-select').selectOption('en');
    assert.match(await page.locator('.note-week').first().locator('.count').innerText(), /2 posts/);
    await page.locator('#note-search').fill('no matches');
    assert.equal(await page.locator('.note-week').count(), 0); assert.equal(await page.locator('#note-empty').isVisible(), true);
    await page.locator('#note-search').fill('');
    await page.locator('.note-week').first().locator('summary').click();
    await page.locator('[data-project-id="two"]').click();
    await page.waitForFunction(() => document.querySelector('.note-week')?.dataset.key === 'two:2026-10-05');
    assert.equal(await page.locator('.note-week').first().evaluate(n => n.open), true, 'Projects have independent folder state');
    for (const mode of ['dark', 'light']) {
      await page.locator('#theme-select').selectOption(mode);
      for (const width of [1280, 390, 320]) {
        await page.setViewportSize({width, height: 960});
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'No overflow at ' + width);
      }
    }
    await page.setViewportSize({width: 1280, height: 960});
    const screenshot = path.join(os.tmpdir(), 'agent-weekly-board.png'); await page.screenshot({path: screenshot, fullPage: true});
    assert.deepEqual(errors, []);
    console.log('PASS: JST week boundaries, year boundaries, undated fallback, counts, search, keyboard, polling, project isolation, translations, themes and 320px layout. Screenshot: ' + screenshot);
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
