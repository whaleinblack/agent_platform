const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
// Synthetic project and temporary state only; screenshots go to a temporary folder.
function contrast(foreground,background){
 const luminance=color=>{const rgb=color.match(/[\d.]+/g).slice(0,3).map(v=>Number(v)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
 const values=[luminance(foreground),luminance(background)].sort((a,b)=>b-a);return (values[0]+.05)/(values[1]+.05);
}
(async()=>{
 const {Coordinator}=await import('../lib/coordinator.mjs'),{createHttpServer}=await import('../lib/http-server.mjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'project-settings-ui-')),shots=await fs.mkdtemp(path.join(os.tmpdir(),'project-settings-shots-'));let browser,server;
 try{
  const root=path.join(dir,'root'),next=path.join(dir,'next');await fs.mkdir(root);await fs.mkdir(next);
  const c=await new Coordinator(path.join(dir,'state')).init(),p=await c.createProject({name:'Settings fixture',root},c.ownerToken);
  server=createHttpServer(c,path.resolve(__dirname,'../public'),{port:0});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'msedge',headless:true});const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const shot=name=>page.screenshot({path:path.join(shots,name+'.png'),animations:'disabled'});
  const focused=()=>page.evaluate(()=>document.activeElement?.id||document.activeElement?.dataset.projectId||document.activeElement?.tagName);
  const checkContrast=async selectors=>{for(const selector of selectors){const colors=await page.locator(selector).first().evaluate(element=>{const foreground=getComputedStyle(element).color;let node=element,background;while(node){background=getComputedStyle(node).backgroundColor;if(!background.startsWith('rgba')&&background!=='transparent')break;node=node.parentElement;}return {foreground,background};});assert.ok(contrast(colors.foreground,colors.background)>=4.5,selector+' contrast below 4.5');}};
  const ticket=server.ownerAccess.issueTicket(),base='http://localhost:'+server.address().port;
  await page.goto(base+'/#owner='+ticket.ticket);await page.locator('#project-settings-button').click();
  assert.equal(await page.locator('#settings-save').isDisabled(),true,'Nothing to save before edits');assert.equal(await focused(),'settings-name');
  await page.locator('#settings-name').fill('Updated <safe>');await page.locator('#settings-description').fill('Project notes');await page.locator('#settings-root').fill(next);await page.locator('#settings-page').fill('https://example.test/agents');await page.locator('#settings-repository').fill('git@example.test:team/repo.git');await page.locator('#settings-members').fill('alice@example.test\nbob\nbob');
  assert.equal(await page.locator('#settings-members-count').innerText(),'2 项');
  await page.locator('#settings-save').click();await page.waitForFunction(()=>!document.getElementById('settings-dialog').open);
  assert.equal(c.project(p.id).name,'Updated <safe>');assert.equal(c.project(p.id).root,next);assert.deepEqual(c.project(p.id).plannedMembers,['alice@example.test','bob']);
  assert.match(await page.locator('#policy-feedback').innerText(),/重新写入接入规则/,'Root changes remind the owner to reinstall rules');
  const item=page.locator(`[data-project-id="${p.id}"]`);await item.click({button:'right'});await page.getByRole('menuitem',{name:'设置',exact:true}).click();assert.equal(await page.locator('#settings-description').inputValue(),'Project notes');
  // A changed draft is not discarded silently: Escape asks, and dismissing keeps the dialog and draft.
  await page.locator('#settings-name').fill('Stale draft');page.once('dialog',d=>d.dismiss());await page.keyboard.press('Escape');
  assert.equal(await page.locator('#settings-dialog').evaluate(d=>d.open),true);assert.equal(await page.locator('#settings-name').inputValue(),'Stale draft');
  // Conflicting save keeps the draft, does not overwrite newer server metadata, and offers an explicit reload.
  await c.updateProject(p.id,{baseRevision:1,name:'External update'},c.ownerToken);
  await page.locator('#settings-save').click();await page.waitForFunction(()=>document.getElementById('settings-feedback').textContent.includes('草稿已保留'));
  assert.equal(await page.locator('#settings-name').inputValue(),'Stale draft');assert.equal(c.project(p.id).name,'External update');assert.equal(await page.locator('#settings-reload').isVisible(),true);
  await checkContrast(['#settings-title','#settings-name','.settings-section h3','#settings-root-help','.settings-notice span','#settings-feedback','#settings-delete']);await shot('settings-dark-conflict');
  page.once('dialog',d=>d.accept());await page.locator('#settings-reload').click();await page.waitForFunction(()=>document.getElementById('settings-name').value==='External update');
  assert.equal(await page.locator('#settings-save').isDisabled(),true);assert.equal(await page.locator('#settings-reload').isHidden(),true);await page.locator('#close-settings').click();
  await page.locator('#refresh-button').click();await page.waitForFunction(()=>document.getElementById('project-title').textContent==='External update');
  const agent=(await c.join({projectId:p.id,agentId:'active-test',task:'Protect deletion',files:[]})).session;
  await page.locator('#refresh-button').click();await page.waitForFunction(()=>document.getElementById('stat-working').textContent==='1');
  await page.locator('#project-settings-button').click();assert.equal(await page.locator('#settings-root-active').isVisible(),true,'Active sessions are shown next to the root');await page.locator('#close-settings').click();
  // Keyboard menu: open, move, choose; the dialog starts on Cancel and returns focus to the project.
  await item.focus();await page.keyboard.press('Shift+F10');await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>document.activeElement.dataset.projectCommand),'rules');await page.keyboard.press('End');assert.equal(await page.evaluate(()=>document.activeElement.dataset.projectCommand),'delete');await page.keyboard.press('Enter');
  assert.equal(await focused(),'delete-project-cancel');assert.equal(await page.locator('#delete-project-active').isVisible(),true);await shot('delete-dark-active');
  await page.locator('#delete-project-confirm').click();await page.waitForFunction(()=>document.getElementById('delete-project-feedback').textContent.includes('有活动 Agent'));assert.equal(c.visibleProjects().length,1);
  await page.locator('#delete-project-cancel').click();assert.equal(await focused(),p.id,'Focus returns to the project after the menu dialog');
  await page.keyboard.press('Shift+F10');assert.equal(await page.locator('#project-context-menu').isVisible(),true);await page.keyboard.press('Escape');assert.equal(await page.locator('#project-context-menu').isHidden(),true);assert.equal(await focused(),p.id);
  await c.leave(agent.id,{reason:'completed'},agent.token);
  for(const lang of ['en','ja','zh']){await page.locator('#language-select').selectOption(lang);await page.locator('#project-settings-button').click();assert.equal(await page.locator('#settings-name').inputValue(),'External update');await page.locator('#close-settings').click();}
  await page.locator('#theme-select').selectOption('light');await page.locator('#project-settings-button').click();
  await checkContrast(['#settings-title','#settings-name','.settings-section h3','#settings-root-help','.settings-notice span','#settings-delete']);await shot('settings-light');await page.locator('#close-settings').click();
  await item.click({button:'right'});await shot('menu-light');await page.keyboard.press('Escape');
  await page.setViewportSize({width:390,height:844});await page.locator('#project-settings-button').click();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.equal(await page.locator('#settings-dialog').evaluate(d=>d.scrollWidth>d.clientWidth),false);await shot('settings-light-mobile');await page.locator('#close-settings').click();
  await item.click({button:'right'});await page.getByRole('menuitem',{name:'删除',exact:true}).click();await checkContrast(['#delete-project-confirm span','.delete-target strong']);await shot('delete-light-mobile');
  await page.locator('#delete-project-confirm').click();await page.waitForFunction(()=>!document.getElementById('delete-project-dialog').open);
  assert.equal(c.visibleProjects().length,0);assert.ok(c.project(p.id).deletedAt);assert.equal(await fs.stat(root).then(s=>s.isDirectory()),true);assert.equal(await page.locator('#project-settings-button').isHidden(),true);assert.deepEqual(errors,[]);
  console.log('PASS: settings persistence, safe text, dirty-close guard, conflict draft + reload, active-session hints and deletion guard, keyboard menu focus, translations, dark/light contrast, mobile light, archive. Screenshots: '+shots);
 }finally{if(browser)await browser.close();if(server)await new Promise(r=>{server.close(r);server.closeAllConnections();});await fs.rm(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
