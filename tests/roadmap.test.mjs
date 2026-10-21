import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Coordinator} from '../lib/coordinator.mjs';
import {createHttpServer} from '../lib/http-server.mjs';
import {CoordinatorClient,CredentialStore,registerSession} from '../lib/client.mjs';
import {main as cli} from '../cli.mjs';
import {roadmapPolicy} from '../lib/roadmap.mjs';
async function fixture(t){
 const dir=await mkdtemp(path.join(os.tmpdir(),'roadmap-'));t.after(()=>rm(dir,{recursive:true,force:true}));let now=Date.now();
 const root=path.join(dir,'project');await mkdir(root);const c=await new Coordinator(path.join(dir,'state'),{now:()=>now}).init();
 const p=await c.createProject({name:'Roadmap test',root},c.ownerToken);
 const join=async(id,files=[])=> (await c.join({projectId:p.id,agentId:id,task:'Maintain roadmap',files})).session;
 return {c,p,dir,root,join,advance:ms=>now+=ms};
}
test('responsible agent claim, version conflicts, assignment and project isolation',async t=>{
 const {c,p,dir,join}=await fixture(t),a=await join('alpha'),b=await join('beta');
 assert.equal(c.roadmap(p.id,a.token).revision,0);
 await assert.rejects(c.updateRoadmap(p.id,{baseRevision:0,html:'<h1>not claimed</h1>'},a.token),{status:403});
 const claimed=await c.updateRoadmap(p.id,{baseRevision:0},a.token,{claim:true});assert.equal(claimed.roadmap.editorAgentId,'alpha');
 await assert.rejects(c.updateRoadmap(p.id,{baseRevision:1},b.token,{claim:true}),{status:409});
 await c.updateRoadmap(p.id,{baseRevision:1,html:'<h1>Stage 1</h1>'},a.token);
 await assert.rejects(c.updateRoadmap(p.id,{baseRevision:1,html:'stale'},a.token),{status:409});
 await assert.rejects(c.updateRoadmap(p.id,{baseRevision:2,editorAgentId:'beta'},a.token),{status:403});
 await c.updateRoadmap(p.id,{baseRevision:2,editorAgentId:'beta'},c.ownerToken);
 await assert.rejects(c.updateRoadmap(p.id,{baseRevision:3,html:'wrong writer'},a.token),{status:403});
 await c.updateRoadmap(p.id,{baseRevision:3,html:'<h1>Stage 2</h1>'},b.token);
 const otherRoot=path.join(dir,'other');await mkdir(otherRoot);const other=await c.createProject({name:'Other',root:otherRoot},c.ownerToken);
 assert.throws(()=>c.roadmap(other.id,b.token),{status:403});
 assert.equal(c.snapshot(p.id).roadmap.hasContent,true);assert.equal(c.snapshot(p.id).roadmap.html,undefined);
 assert.equal(c.state.events.at(-1).data.html,undefined);
});
test('waiting/expired/closed agents cannot update; saved HTML survives restart with bounded history',async t=>{
 const f=await fixture(t),{c,p,join}=f,a=await join('alpha',['file.js']),b=await join('beta',['file.js']);
 await assert.rejects(c.updateRoadmap(p.id,{baseRevision:0},b.token,{claim:true}),{status:409});
 await c.updateRoadmap(p.id,{baseRevision:0},a.token,{claim:true});
 for(let i=1;i<=8;i++)await c.updateRoadmap(p.id,{baseRevision:i,html:`<p>${i}</p>`},a.token);
 assert.equal(c.roadmap(p.id,a.token).history.length,5);
 await assert.rejects(c.updateRoadmap(p.id,{baseRevision:9,html:'中'.repeat(30000)},a.token));
 f.advance(45001);await assert.rejects(c.updateRoadmap(p.id,{baseRevision:9,html:'expired'},a.token));
 const next=await new Coordinator(c.directory).init();assert.equal(next.roadmap(p.id,next.ownerToken).html,'<p>8</p>');
 await assert.rejects(next.updateRoadmap(p.id,{baseRevision:9,html:'closed'},a.token));
 assert.equal(next.roadmap(p.id,a.token).html,'<p>8</p>');
});
test('HTTP rendering is authenticated, sandboxed and cannot weaken owner mutation auth',async t=>{
 const {c,p,join}=await fixture(t),a=await join('alpha');
 const {roadmap}=await c.updateRoadmap(p.id,{baseRevision:0,html:'<script>parent.hacked=1</script><h1>Roadmap</h1>'},c.ownerToken);
 const server=createHttpServer(c,path.resolve('public'),{port:0});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
 const base='http://localhost:'+server.address().port,url=base+'/api/projects/'+p.id+'/roadmap';
 assert.equal((await fetch(url+'/render')).status,401);
 const r=await fetch(url+'/render',{headers:{Authorization:'Bearer '+a.token}});assert.equal(r.status,200);assert.equal(r.headers.get('content-security-policy'),roadmapPolicy);assert.match(await r.text(),/<h1>Roadmap/);
 const ticket=server.ownerAccess.issueTicket();const login=await fetch(base+'/api/owner/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket:ticket.ticket})});const cookie=login.headers.get('set-cookie').split(';')[0];
 assert.equal((await fetch(url+'/render',{headers:{Cookie:cookie}})).status,200);
 assert.equal((await fetch(url,{method:'PATCH',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({baseRevision:roadmap.revision,html:'forged'})})).status,401);
});
test('agent CLI claims, reads and publishes an HTML file using only its session credentials',async t=>{
 const {c,p,dir}=await fixture(t),server=createHttpServer(c,path.resolve('public'),{port:0});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
 const client=new CoordinatorClient({baseUrl:'http://127.0.0.1:'+server.address().port}),store=new CredentialStore(path.join(dir,'clients'));
 const handle=await registerSession(client,store,{projectId:p.id,agentId:'cli-writer',task:'Update roadmap',files:[]});
 let output='',error='';const opts={store,stdout:{write:s=>output+=s},stderr:{write:s=>error+=s}};
 assert.equal(await cli(['roadmap-claim','--session',handle.session.id,'--revision','0'],opts),0);
 const file=path.join(dir,'roadmap.html');await writeFile(file,'<h1>Milestone A</h1>');
 assert.equal(await cli(['roadmap-write','--session',handle.session.id,'--revision','1','--html-file',file],opts),0);
 assert.equal(await cli(['roadmap','--session',handle.session.id],opts),0);
 assert.equal(c.roadmap(p.id,c.ownerToken).html,'<h1>Milestone A</h1>');assert.equal(error,'');assert.ok(!output.includes(handle.session.token));
 assert.equal(await cli(['roadmap-write','--session',handle.session.id,'--revision','1','--html-file',file],opts),1);assert.match(error,/409/);
});

test('theme rendering is allowlisted and preserves stored source and CSP', async t => {
 const {c,p,join}=await fixture(t),a=await join('theme-reader');
 const html='<!doctype html><html><head><title>Saved</title></head><body style="background:white;color:black"><h1>Saved milestone</h1></body></html>';
 await c.updateRoadmap(p.id,{baseRevision:0,html},c.ownerToken);
 const server=createHttpServer(c,path.resolve('public'),{port:0});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
 const base='http://localhost:'+server.address().port+'/api/projects/'+p.id+'/roadmap/render';
 for(const [requested,expected] of [['dark','dark'],['light','light'],['system','light'],['</style><script>bad()</script>','light']]) {
   const r=await fetch(base+'?theme='+encodeURIComponent(requested),{headers:{Authorization:'Bearer '+a.token}});
   assert.equal(r.headers.get('content-security-policy'),roadmapPolicy);
   const rendered=await r.text();assert.ok(rendered.startsWith(html));
   assert.ok(rendered.includes(`data-roadmap-theme="${expected}"`));
   assert.ok(rendered.includes('--roadmap-border:'));assert.ok(!rendered.includes('bad()'));
 }
 assert.equal(c.roadmap(p.id,a.token).html,html);assert.equal(c.roadmap(p.id,a.token).revision,1);
});
