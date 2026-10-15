const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {chromium} = require(process.env.PLAYWRIGHT_PATH || 'playwright');
(async()=>{
 const {Coordinator}=await import('../lib/coordinator.mjs'),{createHttpServer}=await import('../lib/http-server.mjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'roadmap-ui-')),root=path.join(dir,'project');await fs.mkdir(root);
 const c=await new Coordinator(path.join(dir,'state')).init(),p=await c.createProject({name:'路线图验证项目',root},c.ownerToken);
 const a=(await c.join({projectId:p.id,agentId:'roadmap-agent',task:'Publish roadmap',files:[]})).session;
 await c.updateRoadmap(p.id,{baseRevision:0},a.token,{claim:true});
 const html='<meta charset="utf-8"><style>body{font:16px sans-serif;background:#e4f7eb;padding:24px}progress{width:80%}</style><h1>路线图示例</h1><p>模块 A 完成 · 模块 B 开发中</p><progress value="1" max="2"></progress><script>parent.roadmapEscaped=true;fetch("/roadmap-image-probe")</script><img src="/roadmap-image-probe">';
 await c.updateRoadmap(p.id,{baseRevision:1,html},a.token);
 const server=createHttpServer(c,path.resolve(__dirname,'../public'),{port:0});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 let leakedRequests=0;server.on('request',req=>{if(req.url.includes('/roadmap-image-probe'))leakedRequests++;});
 const browser=await chromium.launch({...(process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {}),headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],blocked=[];page.on('pageerror',e=>errors.push(e.message));page.on('requestfailed',r=>{if(r.url().includes('/roadmap-image-probe'))blocked.push(r.failure()?.errorText);});
  const ticket=server.ownerAccess.issueTicket(),base='http://localhost:'+server.address().port;
  await page.goto(base+'/#owner='+ticket.ticket);await page.locator('#tab-roadmap').click();
  const frame=page.frameLocator('#roadmap-frame');await frame.getByRole('heading',{name:'路线图示例'}).waitFor();
  assert.equal(await page.locator('#roadmap-frame').getAttribute('sandbox'),'');
  assert.equal(await frame.locator('body').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(228, 247, 235)');
  assert.equal(await page.evaluate(()=>window.roadmapEscaped),undefined);
  assert.equal(leakedRequests,0,'no image/script requests may reach the HTTP server');
  assert.ok(blocked.some(e=>/csp|blocked/i.test(e)),JSON.stringify(blocked));
  const f=page.frames().find(f=>f.url().includes('/roadmap/render'));assert.equal(await f.evaluate(()=>{try{return !!parent.document;}catch{return false;}}),false);
  await page.locator('[data-roadmap-view=code]').click();await page.locator('#roadmap-html').fill('<h1>My local draft</h1>');
  await page.locator('#language-select').selectOption('ja');assert.equal(await page.locator('#roadmap-html').inputValue(),'<h1>My local draft</h1>');assert.equal(await page.locator('#tab-roadmap').innerText(),'ロードマップ');
  await c.updateRoadmap(p.id,{baseRevision:2,html:'<h1>Agent new version</h1>'},a.token);
  await page.locator('#refresh-button').click();await page.waitForFunction(()=>document.getElementById('roadmap-meta').textContent.startsWith('版 3'));
  await page.locator('#roadmap-save').click();await page.waitForFunction(()=>document.getElementById('roadmap-feedback').textContent.includes('新しい版'));
  assert.equal(c.roadmap(p.id,c.ownerToken).html,'<h1>Agent new version</h1>');assert.equal(await page.locator('#roadmap-html').inputValue(),'<h1>My local draft</h1>');
  page.once('dialog',d=>d.accept());await page.locator('#roadmap-reload').click();await page.waitForFunction(()=>document.getElementById('roadmap-html').value.includes('Agent new version'));
  await page.locator('#roadmap-html').fill('<h1>Owner published</h1>');await page.locator('#roadmap-save').click();await page.waitForFunction(()=>document.getElementById('roadmap-meta').textContent.startsWith('版 4'));
  await page.locator('[data-roadmap-view=preview]').click();await frame.getByRole('heading',{name:'Owner published'}).waitFor();
  await page.locator('#language-select').selectOption('en');assert.equal(await page.locator('#tab-roadmap').innerText(),'Roadmap');
  await page.screenshot({path:path.resolve(__dirname,'../evidence/roadmap-desktop.png')});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.resolve(__dirname,'../evidence/roadmap-mobile.png')});
  assert.deepEqual(errors,[]);console.log('PASS: HTML/CSS sandbox, owner controls, live revisions, conflict protection, drafts, translations, desktop/mobile');
 }finally{await browser.close();await new Promise(r=>{server.close(r);server.closeAllConnections();});await fs.rm(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
