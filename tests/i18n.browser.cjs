// Real local HTTP, isolated coordinator state and a synthetic project only.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'),path = require('node:path'),os = require('node:os');
const {chromium} = require(process.env.PLAYWRIGHT_PATH || 'playwright');

(async () => {
  const {Coordinator} = await import('../lib/coordinator.mjs');
  const {createHttpServer} = await import('../lib/http-server.mjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-i18n-'));
  const root = path.join(directory, 'project');await fs.mkdir(root);
  const coordinator = await new Coordinator(path.join(directory, 'data')).init();
  const project = await coordinator.createProject({name:'工作中',root},coordinator.ownerToken);
  const a = (await coordinator.join({projectId:project.id,agentId:'alpha',task:'发送消息',files:['app.js']})).session;
  await coordinator.join({projectId:project.id,agentId:'beta',task:'Waiting for handoff',files:['app.js']});
  await coordinator.update(a.id,{progress:'等待中'},a.token);
  await coordinator.sendMessage({projectId:project.id,toAgentId:'*',text:'已完成',kind:'schedule'},a.token);
  await coordinator.postNote(project.id,{title:'状态',text:'原文を保持 / Keep original',tags:['消息']},a.token);
  const server=createHttpServer(coordinator,path.resolve(__dirname,'../public'),{port:0});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://localhost:'+server.address().port;
  const browser=await chromium.launch({...(process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {}),headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:980}}),page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const ticket=server.ownerAccess.issueTicket();
  const labels={zh:{locale:'zh-CN',connected:'已连接',working:'工作中',create:'新增项目',placeholder:'项目名称'},ja:{locale:'ja-JP',connected:'接続済み',working:'作業中',create:'プロジェクトを追加',placeholder:'プロジェクト名'},en:{locale:'en-US',connected:'Connected',working:'Working',create:'Add project',placeholder:'Project name'}};
  try {
    await page.goto(base+'/#owner='+ticket.ticket);
    await page.waitForFunction(()=>document.querySelector('#connection-text').textContent==='已连接');
    const catalog=await page.locator('#i18n-catalog').textContent();
    for(const [key,entry] of Object.entries(JSON.parse(catalog))){assert.ok(entry[0]&&entry[1],key);const fields=s=>[...s.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort();assert.deepEqual(fields(entry[0]),fields(key),key);assert.deepEqual(fields(entry[1]),fields(key),key);}
    await page.locator('#message-text').fill('Do not replace my draft / 下書き');
    await page.locator('[data-action="select-session"]').first().click();
    for(const language of ['en','ja','zh']){
      await page.locator('#language-select').selectOption(language);
      const expected=labels[language];
      assert.equal(await page.locator('html').getAttribute('lang'),expected.locale);
      assert.equal(await page.locator('#connection-text').innerText(),expected.connected);
      assert.equal(await page.locator('#project-title').innerText(),'工作中');
      assert.equal(await page.locator('.task-summary').filter({hasText:'发送消息'}).innerText(),'发送消息');
      assert.equal(await page.locator('.badge.working').first().innerText(),expected.working);
      assert.equal(await page.locator('#message-text').inputValue(),'Do not replace my draft / 下書き');
      assert.equal(await page.locator('#new-project-name').getAttribute('placeholder'),expected.placeholder);
      await page.locator('[data-action="open-project"]').first().click();
      assert.equal(await page.locator('#project-dialog-title').innerText(),expected.create);
      await page.locator('#new-project-name').fill('Keep project draft');
      await page.locator('#project-dialog [data-action="close-project"]').first().click();
      await page.locator('#tab-messages').click();
      assert.equal(await page.locator('.message-body').innerText(),'已完成');
      await page.locator('#tab-board').click();
      assert.equal(await page.locator('.note-item h3').innerText(),'状态');
      assert.equal(await page.locator('.note-body').innerText(),'原文を保持 / Keep original');
      await page.locator('[data-action="open-note"]').click();
      await page.locator('#note-text').fill('Keep note draft');
      await page.locator('#note-dialog [data-action="close-note"]').first().click();
      await page.locator('#tab-agents').click();
      for(const width of [1440,390,320]){
        await page.setViewportSize({width,height:980});
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false,`${language} overflow at ${width}`);
      }
      await page.setViewportSize({width:1440,height:980});
      await page.screenshot({path:path.join(directory,language+'.png'),fullPage:true});
    }
    await page.locator('#language-select').selectOption('en');
    await page.locator('[data-action="open-project"]').first().click();
    assert.equal(await page.locator('#new-project-name').inputValue(),'Keep project draft');
    await page.locator('#project-dialog [data-action="close-project"]').first().click();
    await page.locator('#tab-board').click();await page.locator('[data-action="open-note"]').click();
    assert.equal(await page.locator('#note-text').inputValue(),'Keep note draft');
    await page.locator('#note-dialog [data-action="close-note"]').first().click();
    await page.route('**/api/messages',route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Session is closed.'})}));
    await page.locator('#send-button').click();
    await page.waitForFunction(()=>document.querySelector('#message-feedback').textContent==='Session is closed.');
    await page.locator('#language-select').selectOption('ja');
    assert.equal(await page.locator('#message-feedback').innerText(),'セッションは終了しています。');
    await page.locator('#theme-select').selectOption('light');await page.reload();
    await page.waitForFunction(()=>document.querySelector('#connection-text').textContent==='接続済み');
    assert.equal(await page.locator('#language-select').inputValue(),'ja');
    assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
    const second=await context.newPage();await second.goto(base);
    await second.waitForFunction(()=>document.querySelector('#connection-text').textContent==='接続済み');
    await page.locator('#language-select').selectOption('en');
    await second.waitForFunction(()=>document.documentElement.lang==='en-US');
    const anonymous=await browser.newContext();await anonymous.addInitScript(()=>localStorage.setItem('agent-coordinator.language','en'));
    const loggedOut=await anonymous.newPage();await loggedOut.goto(base);
    await loggedOut.waitForFunction(()=>document.querySelector('#owner-sign-in').hidden===false);
    assert.equal(await loggedOut.locator('#owner-sign-in-title').innerText(),'Administrator sign-in required');
    assert.deepEqual(errors,[]);
    console.log('PASS: zh/ja/en, draft preservation, untranslated user content, dynamic states/errors, persisted language/theme, cross-tab sync, signed-out UI, 320/390/1440px. Screenshots: '+directory);
  } finally {
    await browser.close();await coordinator.shutdown();
    await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
    await fs.rm(path.join(directory,'data'),{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
