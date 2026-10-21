import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {Coordinator} from '../lib/coordinator.mjs';
import {readRules,writeRules,grantRules,confirmRules} from '../lib/rules.mjs';
import {createHttpServer} from '../lib/http-server.mjs';
async function fixture(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'rules-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const root=path.join(dir,'project');await mkdir(root);await mkdir(path.join(dir,'public'));const platform=path.join(dir,'AGENT_PROTOCOL.md');await writeFile(platform,'# Platform requirements');
 let now=Date.now();const c=await new Coordinator(path.join(dir,'state'),{now:()=>now}).init();const p=await c.createProject({name:'Rules',root,leaseMs:300000,idleMs:3600000},c.ownerToken);
 const join=async(id,files=[])=> (await c.join({projectId:p.id,agentId:id,task:'Rules task',files})).session;
 const read=async token=>(await readRules(c,p.id,token??c.ownerToken,platform)).rules;
 return {dir,root,platform,c,p,join,read,advance:ms=>now+=ms};
}
test('three levels, revision conflicts, read confirmation and state survive restart',async t=>{
 const f=await fixture(t),{c,p,read,platform}=f;
 let rules=await read();assert.equal(rules.project.revision,0);assert.equal(rules.local.text,'');assert.equal(rules.platform.readOnly,true);assert.ok(rules.permissions.manageGrants);
 rules=(await writeRules(c,p.id,{scope:'project',baseRevision:0,text:'Shared standards'},c.ownerToken,platform)).rules;
 assert.equal(rules.project.revision,1);assert.equal(rules.project.text,'Shared standards');
 await assert.rejects(writeRules(c,p.id,{scope:'project',baseRevision:0,text:'stale'},c.ownerToken,platform),{status:409});
 const revisions={platform:rules.platform.revision,project:rules.project.revision,local:rules.local.revision};
 rules=(await confirmRules(c,p.id,{revisions},c.ownerToken,platform)).rules;assert.equal(rules.confirmation.confirmedBy,'owner');
 await writeRules(c,p.id,{scope:'project',baseRevision:1,text:'New standard'},c.ownerToken,platform);
 await assert.rejects(confirmRules(c,p.id,{revisions},c.ownerToken,platform),{status:409});
 assert.equal((await read()).confirmation.revisions.project,1,'old confirmation remains visibly stale');
 const restored=await new Coordinator(c.directory).init();const saved=(await readRules(restored,p.id,restored.ownerToken,platform)).rules;assert.equal(saved.project.text,'New standard');assert.equal(saved.project.revision,2);assert.equal(restored.state.projectRules[0].history.length,2);
 await assert.rejects(writeRules(c,p.id,{scope:'platform',baseRevision:0,text:'Override'},c.ownerToken,platform),{status:400});
});
test('explicit grants are project/session/scope bound, expire and revoke immediately',async t=>{
 const {c,p,join,platform,read,advance}=await fixture(t),a=await join('alpha'),b=await join('beta');
 const edit=(token,baseRevision)=>writeRules(c,p.id,{scope:'project',baseRevision,text:'Agent change'},token,platform);
 await assert.rejects(edit(a.token,0),{status:403});
 await assert.rejects(grantRules(c,p.id,{agentId:'alpha',scopes:['project'],reason:'self grant'},a.token,platform),{status:403});
 await grantRules(c,p.id,{agentId:'alpha',scopes:['project'],reason:'Human-approved project edits',expiresInMinutes:1},c.ownerToken,platform);
 await edit(a.token,0);await assert.rejects(edit(b.token,1),{status:403});
 assert.equal((await read(a.token)).permissions.editProject,true);assert.equal((await read(a.token)).permissions.editLocal,false);
 advance(60001);await assert.rejects(edit(a.token,1),{status:403});
 let rules=(await grantRules(c,p.id,{agentId:'alpha',scopes:['project'],reason:'Reauthorized'},c.ownerToken,platform)).rules;
 const id=rules.grants.at(-1).id;await grantRules(c,p.id,{grantId:id,revoke:true},c.ownerToken,platform);await assert.rejects(edit(a.token,1),{status:403});
 await grantRules(c,p.id,{agentId:'alpha',scopes:['project'],reason:'One session only'},c.ownerToken,platform);
 await c.leave(a.id,{reason:'completed'},a.token);const next=await join('alpha');await assert.rejects(edit(next.token,1),{status:403});
 const otherRoot=path.join(c.directory,'other');await mkdir(otherRoot);const other=await c.createProject({name:'Other',root:otherRoot},c.ownerToken);
 await assert.rejects(readRules(c,other.id,next.token,platform),{status:403});
});
test('local edits preserve managed rules and text, require claims, reject conflicts and unsafe markers',async t=>{
 const {c,p,root,platform,join,read}=await fixture(t);
 const managed='<!-- agent-coordinator:start -->\nRequired coordination\n<!-- agent-coordinator:end -->\n';await writeFile(path.join(root,'AGENTS.md'),'Custom before\n'+managed+'Custom after\n');
 let rules=await read();assert.equal(rules.local.managedText,managed);assert.equal(rules.local.text,'Custom before\nCustom after\n');
 const a=await join('alpha',['AGENTS.md']);
 await assert.rejects(writeRules(c,p.id,{scope:'local',baseRevision:rules.local.revision,text:'Owner edit'},c.ownerToken,platform),{status:409});
 await assert.rejects(writeRules(c,p.id,{scope:'local',baseRevision:rules.local.revision,text:'Agent edit'},a.token,platform),{status:403});
 await grantRules(c,p.id,{agentId:'alpha',scopes:['local'],reason:'User-authorized local rule edit'},c.ownerToken,platform);
 rules=(await writeRules(c,p.id,{scope:'local',baseRevision:rules.local.revision,text:'New custom'},a.token,platform)).rules;
 assert.equal(rules.local.text,'New custom');assert.equal(rules.local.managedText,managed);assert.equal(await readFile(path.join(root,'AGENTS.md'),'utf8'),managed+'New custom');
 await assert.rejects(writeRules(c,p.id,{scope:'local',baseRevision:rules.local.revision,text:'<!-- agent-coordinator:start -->'},a.token,platform),{status:400});
 const old=rules.local.revision;await writeFile(path.join(root,'AGENTS.md'),managed+'External change');
 await assert.rejects(writeRules(c,p.id,{scope:'local',baseRevision:old,text:'clobber'},a.token,platform),{status:409});
 await c.update(a.id,{files:[]},a.token);rules=await read(a.token);assert.equal(rules.permissions.editLocal,false);
 await assert.rejects(writeRules(c,p.id,{scope:'local',baseRevision:rules.local.revision,text:'No claim'},a.token,platform),{status:403});
});
test('malformed managed blocks and symlinked local rules are not overwritten',async t=>{
 const {c,p,root,platform,read}=await fixture(t),file=path.join(root,'AGENTS.md');
 await writeFile(file,'<!-- agent-coordinator:start -->missing end');await assert.rejects(read(),{status:409});
 await rm(file);const target=path.join(c.directory,'external.md');await writeFile(target,'Untouched');
 try{await symlink(target,file);}catch(e){if(e.code==='EPERM'){t.diagnostic('Symlink creation unavailable; malformed-block protection covered');return;}throw e;}
 await assert.rejects(readRules(c,p.id,c.ownerToken,platform),{status:409});assert.equal(await readFile(target,'utf8'),'Untouched');
});
test('HTTP rules routes require bound owner credentials; agents cannot self-authorize or change platform rules',async t=>{
 const {c,p,dir,join}=await fixture(t),a=await join('agent');const server=createHttpServer(c,path.join(dir,'public'),{port:0});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
 const base='http://localhost:'+server.address().port,route=base+'/api/projects/'+p.id+'/rules';
 const call=(suffix,body,headers={})=>fetch(route+suffix,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 assert.equal((await fetch(route)).status,401);
 const ticket=server.ownerAccess.issueTicket();const login=await fetch(base+'/api/owner/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket:ticket.ticket})});const cookie=login.headers.get('set-cookie').split(';')[0],token=(await login.json()).token;
 assert.equal((await call('/grants',{agentId:'agent',scopes:['project'],reason:'No bound API token'},{Cookie:cookie})).status,401);
 const headers={Cookie:cookie,Authorization:'Bearer '+token};const response=await call('/grants',{agentId:'agent',scopes:['project'],reason:'Approved'},headers);assert.equal(response.status,200);
 const r=await fetch(route,{method:'PATCH',headers:{'Content-Type':'application/json',Authorization:'Bearer '+a.token},body:JSON.stringify({scope:'project',baseRevision:0,text:'Allowed'})});assert.equal(r.status,200);
 const stale=await fetch(route,{method:'PATCH',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({scope:'project',baseRevision:0,text:'Stale'})});assert.equal(stale.status,409);assert.equal((await stale.json()).code,'rules_conflict');
});

test('atomic replacement retries transient locks with a bound and immediately rejects permanent errors',async()=>{
 const {replaceFile}=await import('../lib/storage.mjs');let calls=0;const waits=[];
 await replaceFile('source','target',{renameImpl:async(a,b)=>{assert.equal(a,'source');assert.equal(b,'target');if(++calls<3)throw Object.assign(Error('scanner lock'),{code:'EPERM'});},delayImpl:async ms=>waits.push(ms)});
 assert.equal(calls,3);assert.deepEqual(waits,[50,100]);calls=0;
 await assert.rejects(replaceFile('source','target',{renameImpl:async()=>{calls++;throw Object.assign(Error('locked'),{code:'EBUSY'});},delayImpl:async()=>{}}),{code:'EBUSY'});assert.equal(calls,5);
 calls=0;await assert.rejects(replaceFile('source','target',{renameImpl:async()=>{calls++;throw Object.assign(Error('missing'),{code:'ENOENT'});},delayImpl:async()=>assert.fail('permanent errors must not wait')}),{code:'ENOENT'});assert.equal(calls,1);
});

test('rule authorizations cannot grant platform scope, target waiting agents or accept invalid expiry',async t=>{
 const {c,p,join,platform}=await fixture(t),a=await join('alpha',['AGENTS.md']),b=await join('beta',['AGENTS.md']);assert.equal(b.status,'waiting');
 const grant=input=>grantRules(c,p.id,{agentId:'alpha',scopes:['project'],reason:'Explicit user request',...input},c.ownerToken,platform);
 await assert.rejects(grant({scopes:['platform']}),{status:400});await assert.rejects(grant({reason:''}),{status:400});await assert.rejects(grant({expiresInMinutes:1441}),{status:400});await assert.rejects(grant({agentId:'beta'}),{status:400});
 await assert.rejects(writeRules(c,p.id,{scope:'project',baseRevision:0,text:'bad\x00text'},c.ownerToken,platform),{status:400});
 assert.equal(c.state.projectRules?.length,0);
});

test('backend build fingerprint changes when rule or storage modules change',async t=>{
 const {coreBuildId}=await import('../lib/build-id.mjs');const {readdir,copyFile}=await import('node:fs/promises');
 const dir=await mkdtemp(path.join(os.tmpdir(),'rules-build-'));t.after(()=>rm(dir,{recursive:true,force:true}));await mkdir(path.join(dir,'lib'));
 await copyFile(path.resolve('server.mjs'),path.join(dir,'server.mjs'));
 for(const file of await readdir(path.resolve('lib')))if(file.endsWith('.mjs'))await copyFile(path.resolve('lib',file),path.join(dir,'lib',file));
 const before=await coreBuildId(dir);await writeFile(path.join(dir,'lib/rules.mjs'),'// rule module changed');const afterRules=await coreBuildId(dir);assert.notEqual(before,afterRules);
 await writeFile(path.join(dir,'lib/storage.mjs'),'// storage module changed');assert.notEqual(afterRules,await coreBuildId(dir));
});
