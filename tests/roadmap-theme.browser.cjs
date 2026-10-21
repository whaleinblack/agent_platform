// Isolated temporary server; never uses owner credentials or projects from the live platform.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
(async()=>{
 const {Coordinator}=await import('../lib/coordinator.mjs'),{createHttpServer}=await import('../lib/http-server.mjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'roadmap-theme-'));
 let server,browser;
 try{
  const root=path.join(dir,'project');await fs.mkdir(root);
  const c=await new Coordinator(path.join(dir,'state')).init();
  const p=await c.createProject({name:'Theme test',root},c.ownerToken);
  const html='<!doctype html><html><head><style>body{background:white;color:black}.card{background:var(--roadmap-surface);color:var(--roadmap-text);border:1px solid var(--roadmap-border)}</style></head><body><h1>Saved roadmap</h1><section class="card">Milestone</section><table><tr><th>Stage</th></tr><tr><td data-status="success">Done</td></tr></table><a href="#">Link</a><script>parent.escaped=true</script><img src="/blocked-resource"></body></html>';
  await c.updateRoadmap(p.id,{baseRevision:0,html},c.ownerToken);
  server=createHttpServer(c,path.resolve(__dirname,'../public'),{port:0});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let leaks=0;server.on('request',r=>{if(r.url==='/blocked-resource')leaks++;});
  browser=await chromium.launch({...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{}),headless:true});
  const context=await browser.newContext({colorScheme:'light'}),page=await context.newPage();
  const base='http://localhost:'+server.address().port,ticket=server.ownerAccess.issueTicket();
  await page.goto(base+'/#owner='+ticket.ticket);await page.locator('#tab-roadmap').click();
  async function check(theme){
   await page.waitForFunction(theme=>document.querySelector('#roadmap-frame').src.includes('theme='+theme),theme);
   const frame=page.frameLocator('#roadmap-frame');await frame.locator(`style[data-roadmap-theme="${theme}"]`).waitFor({state:'attached'});
   const colors=await frame.locator('body').evaluate(e=>({bg:getComputedStyle(e).backgroundColor,text:getComputedStyle(e).color,scheme:getComputedStyle(e).colorScheme,card:getComputedStyle(e.querySelector('.card')).backgroundColor}));
   assert.equal(colors.bg,theme==='dark'?'rgb(12, 14, 18)':'rgb(243, 246, 250)');
   assert.equal(colors.text,theme==='dark'?'rgb(233, 236, 241)':'rgb(23, 32, 43)');
   assert.equal(colors.card,theme==='dark'?'rgb(18, 21, 25)':'rgb(235, 240, 246)');assert.equal(colors.scheme,theme);
   assert.equal(await page.locator('#roadmap-frame').getAttribute('sandbox'),'');
   const f=page.frames().find(f=>f.url().includes('/roadmap/render'));
   assert.equal(await f.evaluate(()=>{try{return !!parent.document;}catch{return false;}}),false);
   assert.equal(await page.evaluate(()=>window.escaped),undefined);assert.equal(leaks,0);
  }
  await check('dark'); // First load: default manual dark against a light OS.
  await page.locator('#theme-select').selectOption('light');await check('light');
  await page.emulateMedia({colorScheme:'dark'});await check('light'); // Manual overrides OS.
  await page.locator('#theme-select').selectOption('system');await check('dark');
  await page.emulateMedia({colorScheme:'light'});await check('light');
  await page.emulateMedia({colorScheme:'dark'});await check('dark');
  await Promise.all([page.waitForResponse(r=>r.url().includes('/roadmap/render')&&r.url().includes('theme=dark')),page.locator('#roadmap-reload').click()]);await check('dark');
  await page.locator('[data-roadmap-view=code]').click();await page.locator('#roadmap-html').fill('<h1>Unsaved draft</h1>');
  await page.locator('#theme-select').selectOption('light');await check('light');
  assert.equal(await page.locator('#roadmap-html').inputValue(),'<h1>Unsaved draft</h1>');
  assert.equal(c.roadmap(p.id,c.ownerToken).html,html);assert.equal(c.roadmap(p.id,c.ownerToken).revision,1);
  await page.reload();await page.locator('#tab-roadmap').click();await check('light');
  await page.locator('#theme-select').selectOption('dark');await page.reload();await page.locator('#tab-roadmap').click();await check('dark');
  const restored=await new Coordinator(c.directory).init();assert.equal(restored.roadmap(p.id,restored.ownerToken).html,html);
  console.log('PASS: initial/manual/system themes, OS mismatch and changes, reload/reopen, drafts, persisted source, CSP sandbox');
 }finally{if(browser)await browser.close();if(server)await new Promise(r=>{server.close(r);server.closeAllConnections();});await fs.rm(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
