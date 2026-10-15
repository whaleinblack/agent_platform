// Optional browser integration: isolated state, projects and HTTP port only.
const assert = require('node:assert/strict'),fs = require('node:fs/promises'),path = require('node:path'),os = require('node:os');
const {chromium} = require(process.env.PLAYWRIGHT_PATH || 'playwright');
(async () => {
  const {Coordinator} = await import('../lib/coordinator.mjs'),{createHttpServer} = await import('../lib/http-server.mjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-ui-')),root = path.join(directory, 'project');await fs.mkdir(root);await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'AGENTS.md'), '# Existing project rules\n');
  const coordinator = await new Coordinator(path.join(directory, 'state')).init(),server = createHttpServer(coordinator, path.resolve(__dirname, '../public'), {port: 0});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({...(process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {}),headless: true}),page = await browser.newPage({viewport: {width: 1440,height: 980}}),errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const call = async (route, body, token = coordinator.ownerToken, method = 'POST') => {
    const response = await fetch(base + route, {method,headers: {'Content-Type': 'application/json',Authorization: 'Bearer ' + token},body: JSON.stringify(body)});assert.ok(response.ok, await response.clone().text());return response.json();
  };
  try {
    const ticket = server.ownerAccess.issueTicket();
    await page.goto(base + '/#owner=' + ticket.ticket);await page.waitForFunction(() => document.getElementById('connection-text').textContent === '已连接');
    assert.equal(new URL(page.url()).hostname, 'localhost');
    assert.equal(page.url().includes('#owner='), false);
    await page.goto(base + '/');await page.waitForFunction(() => document.getElementById('connection-text').textContent === '已连接');
    assert.equal(new URL(page.url()).hostname, 'localhost');
    assert.equal(coordinator.state.projects.length, 0);
    await page.locator('[data-action="open-project"]').first().click();await page.locator('#new-project-name').fill('集成验证项目');await page.locator('#new-project-root').fill(root);
    await page.locator('#create-project-button').click();await page.waitForFunction(() => !document.getElementById('project-dialog').open);
    const project = coordinator.state.projects[0];assert.ok(project);assert.equal(project.leaseMs, 45000);assert.equal(project.idleMs, 300000);
    const rules = await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8');assert.ok(rules.startsWith('# Existing project rules'));assert.ok(rules.includes(project.id));
    const a = (await call('/api/agents/join', {projectId: project.id,agentId: 'agent-alpha',task: '编写共享模块',files: ['src/module.js']})).session;
    const b = (await call('/api/agents/join', {projectId: project.id,agentId: 'agent-beta',task: '更新调用接口',files: ['src/module.js']})).session;
    assert.equal(b.status, 'waiting');await page.locator('#refresh-button').click();
    await page.waitForFunction(() => document.getElementById('stat-waiting').textContent === '1');assert.equal(await page.locator('#stat-working').innerText(), '1');
    await page.getByRole('button', {name: 'agent-beta',exact: true}).click();assert.match(await page.locator('#session-detail').innerText(), /module\.js/);
    const waiting = fetch(`${base}/api/sessions/${b.id}/events?after=${coordinator.state.sequence}&wait=2000`, {headers: {Authorization: 'Bearer ' + b.token}}).then(r => r.json());
    await page.locator('#message-recipient').fill('agent-beta');await page.locator('#message-text').fill('等模块完成后再接手，接口使用 v2。');await page.locator('#send-button').click();
    const delivered = await waiting;assert.ok(delivered.events.some(e => e.type === 'message.sent' && e.data.toAgentId === 'agent-beta'));
    await page.locator('#tab-board').click();await page.locator('[data-action="open-note"]').click();await page.locator('#note-title').fill('接口交接');await page.locator('#note-text').fill('保持原始 DN，解析函数返回独立的布局信息。');await page.locator('#note-tags').fill('raw, interface');await page.locator('#publish-note-button').click();
    await page.waitForFunction(() => !document.getElementById('note-dialog').open);assert.ok(coordinator.state.notes.some(note => note.title === '接口交接'));
    await call(`/api/sessions/${a.id}/leave`, {reason: 'completed',summary: '模块已完成，可以按 v2 接口继续。'}, a.token);
    await call(`/api/sessions/${b.id}`, {progress: '读取交接后继续实现'}, b.token, 'PATCH');assert.equal(coordinator.session(b.id).status, 'working');
    await page.locator('#tab-agents').click();await page.locator('#refresh-button').click();await page.waitForFunction(() => document.getElementById('stat-waiting').textContent === '0');
    assert.equal(await page.locator('#agent-rows tr').count(), 1);await page.locator('#show-history').check();assert.equal(await page.locator('#agent-rows tr').count(), 2);
    await page.locator('#tab-board').click();await page.locator('#note-search').fill('接口');assert.ok((await page.locator('#note-list').innerText()).includes('接口交接'));
    const output = path.resolve(__dirname, '../evidence');await fs.mkdir(output, {recursive: true});await page.screenshot({path: path.join(output, 'desktop.png'),fullPage: true});
    for (const width of [390, 320]) {
      await page.setViewportSize({width,height: 900});await page.screenshot({path: path.join(output, `mobile-${width}.png`),fullPage: true});
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false, 'Page overflow at ' + width);
    }
    assert.deepEqual(errors, []);console.log('PASS: owner project creation and rules, competing agent declarations, HTTP long-poll messaging, persistent board, completion/handoff, history and 320/390/1440px layouts. Only synthetic project files were touched.');
  } finally {
    await browser.close();await coordinator.shutdown();await new Promise(resolve => {server.close(resolve);server.closeAllConnections();});await fs.rm(directory, {recursive: true,force: true});
  }
})().catch(error => {console.error(error);process.exitCode = 1;});
