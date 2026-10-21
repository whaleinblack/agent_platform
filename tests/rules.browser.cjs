// Optional browser QA for the project rules tab: synthetic project, temporary state and AGENTS.md only.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {chromium}=require(process.env.PLAYWRIGHT_PATH||'playwright');
function contrast(foreground,background){
 const luminance=color=>{const rgb=color.match(/[\d.]+/g).slice(0,3).map(v=>Number(v)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722;};
 const values=[luminance(foreground),luminance(background)].sort((a,b)=>b-a);return (values[0]+.05)/(values[1]+.05);
}
(async()=>{
 const {Coordinator}=await import('../lib/coordinator.mjs'),{createHttpServer}=await import('../lib/http-server.mjs'),{writeRules}=await import('../lib/rules.mjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rules-ui-')),shots=await fs.mkdtemp(path.join(os.tmpdir(),'rules-shots-'));let browser,server;
 const platform=path.resolve(__dirname,'../AGENT_PROTOCOL.md'),managed='<!-- agent-coordinator:start -->\nManaged coordination\n<!-- agent-coordinator:end -->\n';
 try{
  const root=path.join(dir,'root');await fs.mkdir(root);await fs.writeFile(path.join(root,'AGENTS.md'),'# Local rules\nUse small commits.\n\n'+managed);
  const c=await new Coordinator(path.join(dir,'state')).init(),p=await c.createProject({name:'Rules fixture',root,leaseMs:300000,idleMs:3600000},c.ownerToken);
  server=createHttpServer(c,path.resolve(__dirname,'../public'),{port:0});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'msedge',headless:true});const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const shot=name=>page.screenshot({path:path.join(shots,name+'.png'),fullPage:true,animations:'disabled'});
  const text=selector=>page.locator(selector).innerText();
  const projectRules=()=>c.state.projectRules.find(r=>r.projectId===p.id);
  const checkContrast=async selectors=>{for(const selector of selectors){const colors=await page.locator(selector).first().evaluate(element=>{const foreground=getComputedStyle(element).color;let node=element,background;while(node){background=getComputedStyle(node).backgroundColor;if(!background.startsWith('rgba')&&background!=='transparent')break;node=node.parentElement;}return {foreground,background};});assert.ok(contrast(colors.foreground,colors.background)>=4.5,selector+' contrast below 4.5');}};
  const ticket=server.ownerAccess.issueTicket(),base='http://localhost:'+server.address().port;
  await page.goto(base+'/#owner='+ticket.ticket);await page.locator('#tab-rules').click();await page.locator('#rules-content').waitFor();
  // Three levels: platform read-only, project and local editable for the local owner, managed block shown read-only.
  assert.equal(await text('#rules-platform-source'),'AGENT_PROTOCOL.md');assert.equal(await page.locator('[data-scope="platform"] .badge').innerText(),'只读');
  await page.locator('[data-scope="platform"] summary').click();assert.match(await text('#rules-platform-text'),/Agent/);
  assert.equal(await text('#rules-project-access'),'可编辑');assert.equal(await text('#rules-local-access'),'可编辑');assert.equal(await text('#rules-status-badge'),'未确认');
  assert.equal(await page.locator('#rules-local-text').inputValue(),'# Local rules\nUse small commits.\n\n');assert.match(await page.locator('#rules-local-managed').textContent(),/Managed coordination/);
  // Saving and confirming are separate: a draft blocks confirmation until saved.
  await page.locator('#rules-project-text').fill('Shared review checklist');assert.equal(await text('#rules-project-state'),'有未保存的修改。');assert.equal(await page.locator('#rules-confirm').isDisabled(),true);
  await page.locator('#rules-project-save').click();await page.waitForFunction(()=>document.getElementById('rules-feedback').textContent==='规则已保存。');
  assert.equal(projectRules().text,'Shared review checklist');assert.equal(projectRules().revision,1);assert.equal(await page.locator('#rules-project-save').isDisabled(),true);
  // Local save keeps the managed block byte-for-byte; a polling refresh keeps an unsaved draft.
  await page.locator('#rules-local-text').fill('# Local rules\nUse small commits.\nRun tests before handoff.\n\n');await page.locator('#refresh-button').click();await page.waitForTimeout(400);
  assert.equal(await page.locator('#rules-local-text').inputValue(),'# Local rules\nUse small commits.\nRun tests before handoff.\n\n');
  await page.locator('#rules-local-save').click();await page.waitForFunction(()=>document.getElementById('rules-feedback').textContent==='规则已保存。'&&!document.getElementById('rules-local-save').querySelector('span').textContent.includes('…'));
  assert.equal(await fs.readFile(path.join(root,'AGENTS.md'),'utf8'),managed+'# Local rules\nUse small commits.\nRun tests before handoff.\n\n');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'rules-local-text','Focus stays in the editor after saving');
  // Conflict keeps the draft and offers an explicit reload of the latest version.
  await page.locator('#rules-project-text').fill('Stale draft');await writeRules(c,p.id,{scope:'project',baseRevision:1,text:'External standard'},c.ownerToken,platform);
  await page.locator('#rules-project-save').click();await page.waitForFunction(()=>document.getElementById('rules-project-state').classList.contains('conflict'));
  assert.equal(await page.locator('#rules-project-text').inputValue(),'Stale draft');assert.equal(projectRules().text,'External standard');assert.equal(await page.locator('#rules-project-latest').isVisible(),true);
  await shot('rules-dark-conflict');
  page.once('dialog',d=>d.accept());await page.locator('#rules-project-latest').click();await page.waitForFunction(()=>document.getElementById('rules-project-text').value==='External standard');
  // Read confirmation, then a later change makes it visibly stale.
  await page.locator('#rules-confirm').click();await page.waitForFunction(()=>document.getElementById('rules-status-badge').textContent==='已确认');assert.equal(await page.locator('#rules-confirm').isDisabled(),true);
  await writeRules(c,p.id,{scope:'project',baseRevision:2,text:'Revised standard'},c.ownerToken,platform);await page.locator('#rules-reload').click();
  await page.waitForFunction(()=>document.getElementById('rules-status-badge').textContent==='已变更');assert.match(await text('#rules-status-text'),/项目规则/);
  // Another agent holding AGENTS.md blocks the owner's local save (expected 409), and the draft stays.
  const editor=(await c.join({projectId:p.id,agentId:'local-editor',task:'Edit AGENTS.md',files:['AGENTS.md']})).session;
  await page.locator('#rules-local-text').fill('Owner draft');await page.locator('#rules-local-save').click();
  await page.waitForFunction(()=>document.getElementById('rules-feedback').textContent.includes('其他 Agent 正在编辑本地规则'));assert.equal(await page.locator('#rules-local-text').inputValue(),'Owner draft');
  page.once('dialog',d=>d.accept());await page.locator('#rules-local-discard').click();assert.equal(await page.locator('#rules-local-text').inputValue(),'# Local rules\nUse small commits.\nRun tests before handoff.\n\n');
  // Grants: explicit scope and reason for a working session, then revoke.
  await page.locator('#refresh-button').click();await page.waitForFunction(()=>[...document.getElementById('rules-grant-agent').options].some(o=>o.value==='local-editor'));
  await page.locator('#rules-grant-reason').fill('Update review checklist');await page.locator('#rules-grant-submit').click();assert.equal(await text('#rules-grant-feedback'),'请至少选择一个授权范围。');
  await page.locator('#rules-grant-form input[value="project"]').check();await page.locator('#rules-grant-minutes').fill('30');await page.locator('#rules-grant-submit').click();
  await page.waitForFunction(()=>document.getElementById('rules-grant-feedback').textContent==='授权已授予。');
  const grant=projectRules().grants[0];assert.equal(grant.agentId,'local-editor');assert.deepEqual(grant.scopes,['project']);assert.equal(grant.sessionId,editor.id);assert.ok(Date.parse(grant.expiresAt)-Date.now()<=30*60000);
  assert.match(await text('#rules-grant-list'),/local-editor[\s\S]*有效/);assert.equal(await page.evaluate(()=>document.activeElement.id),'rules-grant-reason','Focus is kept after granting');assert.equal(await page.locator('#rules-grant-reason').inputValue(),'');
  await checkContrast(['#rules-status-text','#rules-platform-source','.rules-scope-help','#rules-project-text','#rules-grant-list strong','.rules-grant p','#rules-local-access']);await shot('rules-dark');
  page.once('dialog',d=>d.accept());await page.locator('[data-rules-revoke]').click();await page.waitForFunction(()=>document.getElementById('rules-grant-feedback').textContent==='授权已撤销。');
  assert.ok(projectRules().grants[0].revokedAt);assert.match(await text('#rules-grant-list'),/已撤销/);
  // A grant whose session ended is shown as unusable, matching the server, and offers no revoke.
  await page.locator('#rules-grant-form input[value="local"]').check();await page.locator('#rules-grant-reason').fill('Edit AGENTS.md wording');await page.locator('#rules-grant-submit').click();
  await page.waitForFunction(()=>document.getElementById('rules-grant-feedback').textContent==='授权已授予。');assert.equal(await page.locator('[data-rules-revoke]').count(),1);
  await c.leave(editor.id,{reason:'completed'},editor.token);await page.locator('#refresh-button').click();
  await page.waitForFunction(()=>document.getElementById('rules-grant-list').textContent.includes('会话已结束'));assert.equal(await page.locator('[data-rules-revoke]').count(),0);
  // Delayed responses across a project switch: a reload must not discard the other project's draft,
  // and a save that lands after switching still clears the original project's saved draft.
  const otherRoot=path.join(dir,'other');await fs.mkdir(otherRoot);const other=await c.createProject({name:'Second rules fixture',root:otherRoot},c.ownerToken);
  const gated=async method=>{let release,count=0;const gate=new Promise(r=>{release=r;}),url=`**/api/projects/${p.id}/rules`;const handler=async route=>{if(route.request().method()===method){count++;await gate;}await route.continue();};await page.route(url,handler);return {count:()=>count,release:async()=>{release();await page.waitForTimeout(600);await page.unroute(url,handler);}};};
  const openProject=async(id,title,folder)=>{await page.locator(`[data-project-id="${id}"]`).click();await page.waitForFunction(title=>document.getElementById('project-title').textContent===title,title);await page.waitForFunction(folder=>!document.getElementById('rules-content').hidden&&document.getElementById('rules-local-source').textContent.endsWith(folder+'\\AGENTS.md')||document.getElementById('rules-local-source').textContent.endsWith(folder+'/AGENTS.md'),folder);};
  await page.locator('#rules-project-text').fill('Race draft');await writeRules(c,p.id,{scope:'project',baseRevision:3,text:'Newest standard'},c.ownerToken,platform);
  let hold=await gated('GET');await page.locator('#rules-project-save').click();await page.waitForFunction(()=>document.getElementById('rules-project-state').classList.contains('conflict'));
  page.once('dialog',d=>d.accept());await page.locator('#rules-project-latest').click();
  await openProject(other.id,'Second rules fixture','other');await page.locator('#rules-project-text').fill('Second project draft');
  assert.ok(hold.count()>=1,'The first project reload is still in flight while switching');await hold.release();
  assert.equal(await page.locator('#rules-project-text').inputValue(),'Second project draft','Delayed reload of the first project must not touch the second draft');
  page.once('dialog',d=>d.accept());await page.locator('#rules-project-discard').click();
  await openProject(p.id,'Rules fixture','root');page.once('dialog',d=>d.accept());await page.locator('#rules-project-latest').click();await page.waitForFunction(()=>document.getElementById('rules-project-text').value==='Newest standard');
  await page.locator('#rules-project-text').fill('Saved after switch');hold=await gated('PATCH');await page.locator('#rules-project-save').click();
  await openProject(other.id,'Second rules fixture','other');assert.equal(hold.count(),1);await hold.release();assert.equal(projectRules().text,'Saved after switch');
  await openProject(p.id,'Rules fixture','root');assert.equal(await page.locator('#rules-project-text').inputValue(),'Saved after switch');
  assert.equal(await page.locator('#rules-project-state').getAttribute('class'),'rules-state','A save that finished after switching leaves no stale draft');
  // A→B→A while the first A load is pending reuses that request instead of sending a duplicate.
  hold=await gated('GET');await page.locator('#rules-reload').click();
  await openProject(other.id,'Second rules fixture','other');await page.locator(`[data-project-id="${p.id}"]`).click();await page.waitForFunction(()=>document.getElementById('project-title').textContent==='Rules fixture');
  await page.locator('#refresh-button').click();await page.waitForTimeout(300);assert.equal(hold.count(),1,'Only one request for the first project while it is pending');
  await hold.release();await page.waitForFunction(()=>!document.getElementById('rules-content').hidden&&document.getElementById('rules-project-text').value==='Saved after switch');
  // Context menu entry, translations, light theme and mobile layout.
  await page.locator('#tab-agents').click();await page.locator(`[data-project-id="${p.id}"]`).click({button:'right'});await page.getByRole('menuitem',{name:'项目规则',exact:true}).click();
  assert.equal(await page.locator('#panel-rules').isVisible(),true);
  await page.locator('#language-select').selectOption('en');assert.equal(await text('#tab-rules'),'Project rules');assert.equal(await text('#rules-status-badge'),'Changed');assert.equal(await text('#rules-project-access'),'Editable');
  await page.locator('#language-select').selectOption('ja');assert.equal(await text('[data-scope="platform"] .badge'),'閲覧のみ');await page.locator('#language-select').selectOption('zh');
  await page.locator('#theme-select').selectOption('light');await checkContrast(['#rules-status-text','#rules-platform-source','.rules-scope-help','#rules-project-text','.rules-grant p','#rules-local-access']);await shot('rules-light');
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'No overflow at 390px');await shot('rules-light-mobile');
  assert.deepEqual(errors,[]);
  console.log('PASS: three-level view, platform read-only, project/local save with managed block preserved, polling-safe drafts, conflict + reload, confirmation and stale state, claim conflict, grant/revoke, context menu, zh/ja/en, dark/light contrast, 390px. Screenshots: '+shots);
 }finally{if(browser)await browser.close();if(server)await new Promise(r=>{server.close(r);server.closeAllConnections();});await fs.rm(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
