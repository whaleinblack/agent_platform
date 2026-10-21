import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile,readFile} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {Coordinator} from '../lib/coordinator.mjs';
import {createHttpServer} from '../lib/http-server.mjs';
async function fixture(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'project-settings-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const root=path.join(dir,'project'),next=path.join(dir,'next');await mkdir(root);await mkdir(next);
 const c=await new Coordinator(path.join(dir,'state')).init(),p=await c.createProject({name:'Original',root},c.ownerToken);
 return {dir,root,next,c,p};
}
test('settings validate metadata, preserve history and reject stale revisions',async t=>{
 const {c,p,next}=await fixture(t);
 await c.postNote(p.id,{title:'Keep',text:'History',tags:[]},c.ownerToken);
 const {project}=await c.updateProject(p.id,{baseRevision:0,name:'Renamed',description:'Notes',root:next,pageAddress:'https://chufa.wang/agents',repositoryPath:'git@example.test:team/repo.git',plannedMembers:['alice','alice','bob']},c.ownerToken);
 assert.equal(project.root,next);assert.deepEqual(project.plannedMembers,['alice','bob']);assert.equal(project.settingsRevision,1);
 await assert.rejects(c.updateProject(p.id,{baseRevision:0,name:'Stale'},c.ownerToken),{status:409});
 await assert.rejects(c.updateProject(p.id,{baseRevision:1,pageAddress:'javascript:alert(1)'},c.ownerToken));
 await assert.rejects(c.updateProject(p.id,{baseRevision:1,pageAddress:'https://user:secret@example.test'},c.ownerToken));
 await assert.rejects(c.updateProject(p.id,{baseRevision:1,plannedMembers:['']},c.ownerToken));
 await c.updateProject(p.id,{baseRevision:1,description:'',plannedMembers:[]},c.ownerToken);
 const restored=await new Coordinator(c.directory).init();assert.equal(restored.project(p.id).name,'Renamed');assert.equal(restored.project(p.id).description,'');assert.deepEqual(restored.project(p.id).plannedMembers,[]);assert.equal(restored.state.notes.length,1);
});
test('active sessions protect roots/deletion; archived projects retain files and records, reject joins',async t=>{
 const {c,p,root,next}=await fixture(t);await writeFile(path.join(root,'keep.txt'),'unchanged');
 const session=(await c.join({projectId:p.id,agentId:'test-agent',task:'Working',files:[]})).session;
 await assert.rejects(c.updateProject(p.id,{baseRevision:0,name:'Agent edit'},session.token),{status:403});
 await assert.rejects(c.updateProject(p.id,{baseRevision:0,root:next},c.ownerToken),{status:409});
 await assert.rejects(c.updateProject(p.id,{baseRevision:0},c.ownerToken,{remove:true}),{status:409});
 await c.updateProject(p.id,{baseRevision:0,name:'Metadata allowed'},c.ownerToken);
 await c.leave(session.id,{reason:'completed',summary:'Keep this history'},session.token);
 await c.updateProject(p.id,{baseRevision:1},c.ownerToken,{remove:true});
 assert.equal(c.visibleProjects().length,0);assert.ok(c.project(p.id).deletedAt);assert.equal(c.state.notes.length,1);assert.equal(c.state.sessions.length,1);
 assert.equal(await readFile(path.join(root,'keep.txt'),'utf8'),'unchanged');
 await assert.rejects(c.join({projectId:p.id,agentId:'new-agent',task:'No',files:[]}),{status:410});
 await assert.rejects(c.updateProject(p.id,{baseRevision:2,name:'Revive'},c.ownerToken),{status:410});
 const replacement=await c.createProject({name:'New project',root},c.ownerToken);assert.notEqual(replacement.id,p.id);
});
test('HTTP settings require owner auth, hide private metadata from public list and enforce revisions',async t=>{
 const {c,p}=await fixture(t);const server=createHttpServer(c,path.resolve('public'),{port:0});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
 const base='http://localhost:'+server.address().port,route=base+'/api/projects/'+p.id;
 const patch=(body,headers={})=>fetch(route,{method:'PATCH',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 assert.equal((await patch({baseRevision:0,name:'No'})).status,403);
 const ticket=server.ownerAccess.issueTicket();const login=await fetch(base+'/api/owner/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket:ticket.ticket})});const cookie=login.headers.get('set-cookie').split(';')[0],token=(await login.json()).token;
 assert.equal((await patch({baseRevision:0,name:'No'},{Cookie:cookie})).status,403);
 const headers={Cookie:cookie,Authorization:'Bearer '+token};
 assert.equal((await patch({baseRevision:0,plannedMembers:['private@example.test']},headers)).status,200);
 assert.equal((await patch({baseRevision:0,name:'Stale'},headers)).status,409);
 assert.equal((await (await fetch(base+'/api/projects')).json()).projects[0].plannedMembers,undefined);
 assert.deepEqual((await (await fetch(base+'/api/projects',{headers})).json()).projects[0].plannedMembers,['private@example.test']);
 assert.equal((await fetch(route+'/delete',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({baseRevision:1})})).status,200);
 assert.deepEqual((await (await fetch(base+'/api/projects')).json()).projects,[]);
});
