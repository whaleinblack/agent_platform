// Optional browser QA. Every request is intercepted; no coordinator state is created.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {chromium} = require(process.env.PLAYWRIGHT_PATH || 'playwright');

(async () => {
  const publicDirectory = path.resolve(__dirname, '../public');
  const assets = new Map();
  for (const file of ['index.html', 'styles.css', 'icons.js', 'app.js']) {
    assets.set('/' + file, await fs.readFile(path.join(publicDirectory, file), 'utf8'));
  }
  const html = assets.get('/index.html');
  assert.ok(html.indexOf('src="/app.js?theme-bootstrap=1"') < html.indexOf('href="/styles.css"'));
  assert.match(html, /<script src="\/app\.js\?theme-bootstrap=1" data-theme-bootstrap><\/script>/);
  assert.ok(!html.includes('/theme.js'));
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-theme-'));
  const browser = await chromium.launch({...(process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {}), headless: true});
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}, colorScheme: 'light'});
  const errors = [];
  const writes = [];
  let bootstrapCount = 0;
  let signInCount = 0;
  const token = 'isolated-theme-fixture-token';
  const ticket = 'isolated-theme-fixture-ticket';
  const now = new Date().toISOString();
  const project = {id: 'fixture-project', name: '协调台主题验证', root: 'C:/isolated-fixture', description: '完全模拟的项目、会话与公告', leaseMs: 45000, idleMs: 300000, createdAt: now};
  const agent = {id: 'fixture-session', agentId: 'frontend.fixture', task: '检查主题切换与输入保留', files: ['public/styles.css'], claimedFiles: ['public/styles.css'], status: 'working', progress: '深色、浅色与移动端检查', lastHeartbeatAt: now, lastActivityAt: now, leaseExpiresAt: new Date(Date.now() + 300000).toISOString(), conflicts: []};
  const data = {
    project, agents: [agent, {...agent, id: 'fixture-waiting', agentId: 'review.fixture', status: 'waiting', claimedFiles: [], conflicts: [{sessionId: agent.id, agentId: agent.agentId, files: agent.files}]},
      ...['completed', 'idle', 'failed', 'cancelled', 'timed_out'].map(status => ({...agent, id: 'fixture-' + status, agentId: status + '.fixture', status, claimedFiles: [], conflicts: []}))],
    notes: [{id: 'fixture-note', title: '共享约定', text: '保留任务草稿与轮询状态。\n公告正文在两种主题下均保持清晰。', tags: ['协作', '主题'], authorAgentId: agent.agentId, createdAt: now}],
    messages: [{id: 'fixture-message', projectId: project.id, fromAgentId: 'owner', toAgentId: '*', kind: 'schedule', text: '请核对当前任务与文件范围。', createdAt: now, deliveredTo: []}],
    events: [{id: 1, type: 'agent.left', at: now, data: {agentId: 'completed.fixture', status: 'completed'}}], cursor: 1
  };
  const csp = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'";
  const origin = 'http://localhost:49239';
  let holdCss = true;
  let releaseCss;
  const cssGate = new Promise(resolve => { releaseCss = resolve; });
  async function mock(route) {
    const request = route.request();
    const url = new URL(request.url());
    assert.equal(url.origin, origin, 'No external requests are allowed');
    const pathname = url.pathname;
    if (pathname.startsWith('/api/')) {
      if (!['/api/bootstrap', '/api/owner/session'].includes(pathname)) assert.equal(request.headers().authorization, 'Bearer ' + token);
      let result;
      if (pathname === '/api/owner/session') {
        assert.equal(request.method(), 'POST');
        assert.equal(request.headers().authorization, undefined);
        assert.equal(request.postDataJSON().ticket, ticket);
        assert.equal(request.frame().page().url().includes('#owner='), false);
        signInCount++; result = {token, snapshot: {projects: [project], cursor: 1}};
      } else if (request.method() === 'GET') {
        if (pathname === '/api/bootstrap') { bootstrapCount++; result = {token, snapshot: {projects: [project], cursor: 1}}; }
        else if (pathname === '/api/projects') result = {projects: [project]};
        else if (pathname === '/api/projects/' + project.id) result = data;
      } else {
        const body = request.postDataJSON();
        writes.push({pathname, body});
        if (pathname === '/api/messages') {
          const message = {...body, id: 'message-' + writes.length, fromAgentId: 'owner', createdAt: now, deliveredTo: []};
          data.messages.push(message); result = {message};
        } else if (pathname.endsWith('/notes')) {
          const note = {...body, id: 'note-' + writes.length, authorAgentId: 'owner', createdAt: now};
          data.notes.push(note); result = {note};
        } else if (pathname.endsWith('/leave')) {
          const session = data.agents.find(item => item.id === pathname.split('/')[3]);
          Object.assign(session, {status: body.reason, summary: body.summary, claimedFiles: []}); result = {session};
        }
      }
      assert.ok(result, 'Unexpected mock API: ' + request.method() + ' ' + pathname);
      return route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(result)});
    }
    if (pathname === '/styles.css' && holdCss) await cssGate;
    const file = pathname === '/' ? '/index.html' : pathname;
    assert.ok(assets.has(file), 'Unexpected asset: ' + pathname);
    return route.fulfill({status: 200, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', headers: {'Content-Security-Policy': csp}, body: assets.get(file)});
  }
  await context.route('**/*', mock);
  function observe(page) {
    page.setDefaultTimeout(8000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  }
  const page = await context.newPage();
  observe(page);
  const theme = async target => target.evaluate(() => ({mode: document.documentElement.dataset.themeMode, resolved: document.documentElement.dataset.theme, selected: document.getElementById('theme-select')?.value}));
  const expectTheme = async (target, mode, resolved) => {
    await target.waitForFunction(({mode, resolved}) => document.documentElement.dataset.themeMode === mode && document.documentElement.dataset.theme === resolved && document.getElementById('theme-select').value === mode, {mode, resolved});
  };
  const shot = async (target, name) => target.screenshot({path: path.join(output, name + '.png'), fullPage: true, animations: 'disabled', timeout: 8000});
  function contrast(foreground, background) {
    const luminance = color => {
      const rgb = color.match(/[\d.]+/g).slice(0, 3).map(value => Number(value) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
      return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
    };
    const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
    return (values[0] + .05) / (values[1] + .05);
  }
  async function checkContrast(selectors) {
    for (const selector of selectors) {
      const colors = await page.locator(selector).first().evaluate(element => {
        const foreground = getComputedStyle(element).color;
        let node = element, background;
        while (node) {
          background = getComputedStyle(node).backgroundColor;
          if (!background.startsWith('rgba') && background !== 'transparent') break;
          node = node.parentElement;
        }
        return {foreground, background};
      });
      assert.ok(contrast(colors.foreground, colors.background) >= 4.5, selector + ' contrast below 4.5');
    }
  }

  try {
    const navigation = page.goto(origin + '/#owner=' + ticket, {waitUntil: 'load'});
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    assert.equal(await page.evaluate(() => document.querySelector('meta[name="color-scheme"]').content), 'dark');
    assert.equal(bootstrapCount, 0, 'The blocking theme must apply before CSS/deferred app load');
    assert.equal(signInCount, 0, 'The early theme load must not exchange the owner ticket');
    assert.equal(await page.evaluate(() => location.hash), '#owner=' + ticket);
    const themeObject = await page.evaluateHandle(() => window.AgentCoordinatorTheme);
    holdCss = false; releaseCss(); await navigation;
    await page.locator('#agent-rows tr').first().waitFor();
    assert.equal(signInCount, 1, 'Only the deferred app may consume the ticket');
    assert.equal(page.url().includes('#owner='), false);
    assert.equal(await themeObject.evaluate(object => object === window.AgentCoordinatorTheme), true, 'The deferred app must not initialize the theme twice');
    await expectTheme(page, 'dark', 'dark');
    await page.locator('#show-history').check();
    await page.getByRole('button', {name: agent.agentId, exact: true}).click();
    await checkContrast(['#project-title', '#message-recipient', '.agent-table th', '.task-summary', '.badge.working', '.badge.waiting', '.badge.completed', '.badge.idle', '.badge.failed', '.badge.cancelled', '.badge.timed_out', '#send-button', '#theme-select']);
    const errorColor = await page.locator('#message-feedback').evaluate(element => {
      element.classList.add('error');
      const color = getComputedStyle(element).color;
      element.classList.remove('error');
      return color;
    });
    assert.equal(errorColor, 'rgb(239, 152, 161)', 'Error feedback must not inherit the neutral text override');
    await shot(page, 'dark-desktop');

    await page.locator('#message-recipient').fill('offline.fixture');
    await page.locator('#message-text').fill('主题切换不得丢失这份草稿。');
    await page.locator('#message-text').evaluate(element => { element.focus(); element.setSelectionRange(2, 7); });
    const textarea = await page.locator('#message-text').elementHandle();
    const bootstraps = bootstrapCount;
    await page.locator('#theme-select').selectOption('light');
    await expectTheme(page, 'light', 'light');
    assert.equal(await page.locator('#message-text').inputValue(), '主题切换不得丢失这份草稿。');
    assert.equal(await textarea.evaluate(element => element === document.getElementById('message-text')), true);
    assert.deepEqual(await page.locator('#message-text').evaluate(element => [element.selectionStart, element.selectionEnd]), [2, 7]);
    assert.equal(await page.locator('#session-detail').isVisible(), true);
    assert.equal(await page.locator('#show-history').isChecked(), true);
    assert.equal(bootstrapCount, bootstraps, 'Changing theme must not reload state');
    assert.equal(await page.locator('#theme-icon svg').getAttribute('data-lucide'), 'sun-moon');
    await shot(page, 'light-desktop');
    await page.reload(); await expectTheme(page, 'light', 'light');

    const second = await context.newPage(); observe(second);
    await second.goto(origin); await expectTheme(second, 'light', 'light');
    await page.locator('#theme-select').selectOption('dark'); await expectTheme(second, 'dark', 'dark');
    await page.locator('#message-text').fill('跨标签页同步时保留草稿');
    await second.locator('#theme-select').selectOption('light'); await expectTheme(page, 'light', 'light');
    assert.equal(await page.locator('#message-text').inputValue(), '跨标签页同步时保留草稿');
    await page.emulateMedia({colorScheme: 'dark'}); await expectTheme(page, 'light', 'light');
    await page.locator('#theme-select').selectOption('system'); await expectTheme(page, 'system', 'dark');
    await page.emulateMedia({colorScheme: 'light'}); await expectTheme(page, 'system', 'light');
    await page.emulateMedia({colorScheme: 'dark'}); await expectTheme(page, 'system', 'dark');
    await page.reload(); await expectTheme(page, 'system', 'dark');
    const key = await page.evaluate(() => window.AgentCoordinatorTheme.storageKey);
    await second.evaluate(key => localStorage.setItem(key, 'invalid'), key); await expectTheme(page, 'dark', 'dark');
    await second.evaluate(key => localStorage.removeItem(key), key); await expectTheme(page, 'dark', 'dark');
    await page.locator('#theme-select').selectOption('light');
    await second.evaluate(() => localStorage.clear()); await expectTheme(page, 'dark', 'dark');
    await second.close();

    for (const mode of ['dark', 'light']) {
      await page.locator('#theme-select').selectOption(mode);
      await page.locator('[data-action="open-project"]').first().click();
      await page.locator('#new-project-name').fill('保留的项目表单草稿');
      await shot(page, mode + '-modal');
      await page.locator('[data-action="close-project"]').first().click();
      await page.locator('#tab-board').click();
      await shot(page, mode + '-board');
      await page.locator('[data-action="open-note"]').click();
      await page.locator('#note-title').fill('保留的公告草稿');
      await page.locator('#note-text').fill('不会实际发布。');
      await shot(page, mode + '-note-modal');
      await page.locator('[data-action="close-note"]').first().click();
      await page.locator('#tab-messages').click(); await shot(page, mode + '-messages');
      await page.locator('#tab-events').click();
      await page.locator('.event-item details').evaluate(element => { element.open = true; });
      await shot(page, mode + '-events');
      await page.locator('#tab-agents').click();
      for (const width of [390, 320]) {
        await page.setViewportSize({width, height: 900});
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, mode + ' overflow at ' + width);
        await shot(page, mode + '-mobile-' + width);
      }
      await page.locator('[data-action="open-project"]').first().click();
      assert.equal(await page.locator('#new-project-name').inputValue(), '保留的项目表单草稿');
      assert.equal(await page.locator('#project-dialog').evaluate(element => element.scrollWidth > element.clientWidth), false);
      await shot(page, mode + '-mobile-modal');
      await page.locator('[data-action="close-project"]').first().click();
      await page.setViewportSize({width: 1440, height: 1000});
    }

    // Regression paths still go only to the in-memory fixture.
    await page.locator('#message-recipient').fill('offline.fixture');
    await page.locator('#message-text').fill('模拟消息'); await page.locator('#send-button').click();
    await page.locator('#message-feedback.success').waitFor();
    assert.equal(writes.at(-1).body.toAgentId, 'offline.fixture');
    await page.locator('#tab-board').click(); await page.locator('[data-action="open-note"]').click();
    await page.locator('#publish-note-button').click(); await page.locator('#note-dialog').waitFor({state: 'hidden'});
    await page.locator('#note-search').fill('保留的公告');
    assert.equal(await page.locator('.note-item').count(), 1);
    assert.ok(!writes.some(write => write.pathname === '/api/projects'), 'No project creation, even in the fixture');
    assert.deepEqual(errors, []);

    const blocked = await browser.newContext({viewport: {width: 390, height: 844}});
    await blocked.route('**/*', mock);
    await blocked.addInitScript(() => {
      Storage.prototype.getItem = () => { throw new DOMException('Blocked', 'SecurityError'); };
      Storage.prototype.setItem = () => { throw new DOMException('Blocked', 'SecurityError'); };
    });
    const blockedPage = await blocked.newPage(); observe(blockedPage);
    await blockedPage.goto(origin); await expectTheme(blockedPage, 'dark', 'dark');
    await blockedPage.locator('#theme-select').selectOption('light'); await expectTheme(blockedPage, 'light', 'light');
    await blocked.close();
    assert.deepEqual(errors, []);
    console.log('PASS: default dark before CSS; light/system persistence; cross-tab storage and clear; OS changes; denied storage fallback; stable drafts/DOM; badges/forms contrast; dark/light modal, notes, messages, events and 320/390/1440px screenshots; mock message/board regression. No real project creation.');
    console.log('SCREENSHOTS=' + output);
  } finally {
    releaseCss();
    await context.close();
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
