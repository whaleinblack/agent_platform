import {replaceFile} from './storage.mjs';
import {readFile,lstat,realpath,writeFile,unlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {CoordinatorError,filesOverlap} from './coordinator.mjs';
const start='<!-- agent-coordinator:start -->',end='<!-- agent-coordinator:end -->';
const digest=value=>createHash('sha256').update(value).digest('hex');
const active=s=>s.status==='working'||s.status==='waiting';
const fail=(message,status=400,code='invalid_rules')=>{throw new CoordinatorError(message,status,{code});};
const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const ruleText=value=>{if(typeof value!=='string'||Buffer.byteLength(value,'utf8')>64*1024||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))fail('Rules must be text up to 64 KiB.');return value;};
function record(state,projectId,create=false){
 const records=state.projectRules??(create?(state.projectRules=[]):[]);
 let item=records.find(r=>r.projectId===projectId);
 if(!item){item={projectId,text:'',revision:0,updatedAt:null,updatedBy:null,history:[],grants:[],confirmations:[]};if(create)records.push(item);}
 return item;
}
function principal(coordinator,projectId,token,write=false){
 const who=coordinator.authorizeProject(projectId,token,{requireActive:write});
 return {...who,actor:who.owner?'owner':who.agentId};
}
function canEdit(coordinator,state,projectId,who,scope){
 if(who.owner)return true;
 const session=coordinator.session(who.sessionId,state);
 return session.status==='working'&&record(state,projectId).grants.some(g=>g.sessionId===who.sessionId&&!g.revokedAt&&Date.parse(g.expiresAt)>coordinator.now()&&g.scopes.includes(scope))&&
   (scope!=='local'||session.claimedFiles.some(f=>filesOverlap(f,'AGENTS.md')));
}
async function localSource(project){
 const root=await realpath(project.root);
 if(!same(root,project.root))fail('Project directory changed. Reopen settings.',409,'rules_path_changed');
 const filename=path.join(root,'AGENTS.md');let raw='';
 try{const info=await lstat(filename);if(!info.isFile()||info.isSymbolicLink())fail('Local rules must be an ordinary AGENTS.md file.',409,'rules_path_unsafe');if(info.size>128*1024)fail('Local rule file is too large to edit.');raw=await readFile(filename,'utf8');}
 catch(error){if(error.code!=='ENOENT')throw error;}
 const a=raw.indexOf(start),b=raw.indexOf(end);
 if((a<0)!==(b<0)||b>=0&&b<a||a>=0&&(raw.indexOf(start,a+start.length)>=0||raw.indexOf(end,b+end.length)>=0))fail('Coordination block is incomplete or duplicated; repair it first.',409,'rules_managed_block');
 let managedEnd=b+end.length;
 if(a>=0&&raw.slice(managedEnd,managedEnd+2)==='\r\n')managedEnd+=2;
 else if(a>=0&&raw[managedEnd]==='\n')managedEnd++;
 const managedText=a<0?'':raw.slice(a,managedEnd);
 const text=a<0?raw:raw.slice(0,a)+raw.slice(managedEnd);
 return {filename,raw,text,managedText,revision:digest(raw)};
}
async function view(coordinator,projectId,token,platformFile){
 const who=principal(coordinator,projectId,token),project=coordinator.project(projectId);
 const [platformText,local]=await Promise.all([readFile(platformFile,'utf8'),localSource(project)]);
 const item=record(coordinator.state,projectId);
 return {rules:{
  platform:{text:platformText,revision:digest(platformText),source:'AGENT_PROTOCOL.md',readOnly:true},
  project:{text:item.text,revision:item.revision,updatedAt:item.updatedAt,updatedBy:item.updatedBy},
  local:{text:local.text,revision:local.revision,source:local.filename,managedText:local.managedText},
  permissions:{manageGrants:who.owner&&!project.deletedAt,editProject:!project.deletedAt&&canEdit(coordinator,coordinator.state,projectId,who,'project'),editLocal:!project.deletedAt&&canEdit(coordinator,coordinator.state,projectId,who,'local')},
  grants:structuredClone(item.grants.filter(g=>who.owner||g.sessionId===who.sessionId)),
  confirmation:structuredClone(item.confirmations.find(c=>c.confirmedBy===who.actor)||null)
 }};
}
export async function readRules(coordinator,projectId,token,platformFile){return view(coordinator,projectId,token,platformFile);}
export async function writeRules(coordinator,projectId,input,token,platformFile){
 if(!['project','local'].includes(input.scope))fail('Choose project or local rules.');
 const text=ruleText(input.text),who=principal(coordinator,projectId,token,true);
 if(input.scope==='local'&&(text.includes(start)||text.includes(end)))fail('The managed coordination block is read-only.');
 await coordinator.mutate(async state=>{
  coordinator.expire(state);const project=coordinator.project(projectId,state);
  if(project.deletedAt)fail('Project was deleted.',410);
  if(!canEdit(coordinator,state,projectId,who,input.scope))fail('Explicit current-project rules authorization is required.',403,'rules_forbidden');
  const item=record(state,projectId,true),at=new Date(coordinator.now()).toISOString();let savedRevision;
  if(input.scope==='project'){
   if(!Number.isInteger(input.baseRevision)||input.baseRevision!==item.revision)fail('Rules changed. Reload and reconcile your draft.',409,'rules_conflict');
   item.history.push({text:item.text,revision:item.revision,updatedAt:item.updatedAt,updatedBy:item.updatedBy});item.history=item.history.slice(-10);
   item.text=text;item.revision++;item.updatedAt=at;item.updatedBy=who.actor;savedRevision=item.revision;
  }else{
   if(state.sessions.some(s=>s.projectId===projectId&&s.status==='working'&&s.id!==who.sessionId&&s.claimedFiles.some(f=>filesOverlap(f,'AGENTS.md'))))fail('Another agent is editing local rules.',409,'rules_claim_conflict');
   const local=await localSource(project);
   if(input.baseRevision!==local.revision)fail('Rules changed. Reload and reconcile your draft.',409,'rules_conflict');
   const next=local.managedText ? local.managedText+(local.managedText.endsWith('\n')?'':'\n')+text : text;
   const temporary=local.filename+'.'+randomUUID()+'.tmp';
   try{
    await writeFile(temporary,next,{flag:'wx'});
    const again=await localSource(project);if(again.revision!==local.revision)fail('Rules changed. Reload and reconcile your draft.',409,'rules_conflict');
    await replaceFile(temporary,local.filename);savedRevision=digest(next);
   }finally{await unlink(temporary).catch(()=>{});}
   item.localHistory??=[];item.localHistory.push({text:local.text,revision:local.revision,at,by:who.actor});item.localHistory=item.localHistory.slice(-10);
  }
  if(!who.owner)coordinator.session(who.sessionId,state).lastActivityAt=at;
  coordinator.event(state,projectId,'rules.updated',{scope:input.scope,updatedBy:who.actor,revision:savedRevision});
 });
 return view(coordinator,projectId,token,platformFile);
}
export async function grantRules(coordinator,projectId,input,token,platformFile){
 const who=principal(coordinator,projectId,token,true);if(!who.owner)fail('Only the project manager can authorize rule edits.',403,'rules_forbidden');
 await coordinator.mutate(state=>{
  coordinator.expire(state);const project=coordinator.project(projectId,state);if(project.deletedAt)fail('Project was deleted.',410);
  const item=record(state,projectId,true),at=new Date(coordinator.now()).toISOString();let grant;
  if(input.revoke===true){grant=item.grants.find(g=>g.id===input.grantId);if(!grant)fail('Rule authorization not found.',404);grant.revokedAt=at;}
  else{
   const session=state.sessions.find(s=>s.projectId===projectId&&s.agentId===input.agentId&&s.status==='working');
   if(!session)fail('Select a working agent in this project.');
   if(!Array.isArray(input.scopes)||!input.scopes.length||input.scopes.some(s=>!['project','local'].includes(s)))fail('Select project and/or local scope.');
   if(typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>2000)fail('Explicit authorization needs a reason.');
   const minutes=input.expiresInMinutes??60;if(!Number.isInteger(minutes)||minutes<1||minutes>1440)fail('Authorization expiry must be 1–1440 minutes.');
   grant={id:randomUUID(),agentId:session.agentId,sessionId:session.id,scopes:[...new Set(input.scopes)],reason:input.reason.trim(),createdAt:at,createdBy:who.actor,expiresAt:new Date(coordinator.now()+minutes*60000).toISOString()};
   item.grants.push(grant);
  }
  coordinator.event(state,projectId,input.revoke===true?'rules.grantRevoked':'rules.granted',{id:grant.id,agentId:grant.agentId,sessionId:grant.sessionId,scopes:grant.scopes,expiresAt:grant.expiresAt});
 });return view(coordinator,projectId,token,platformFile);
}
export async function confirmRules(coordinator,projectId,input,token,platformFile){
 const who=principal(coordinator,projectId,token,true);
 await coordinator.mutate(async state=>{
  coordinator.expire(state);if(!who.owner&&!active(coordinator.session(who.sessionId,state)))fail('Session is closed.',409);
  const project=coordinator.project(projectId,state);if(project.deletedAt)fail('Project was deleted.',410);
  const item=record(state,projectId,true),local=await localSource(project),platform=await readFile(platformFile,'utf8');
  if(!input.revisions||input.revisions.project!==item.revision||input.revisions.local!==local.revision||input.revisions.platform!==digest(platform))fail('Rules changed. Reload before confirming.',409,'rules_conflict');
  const confirmation={revisions:{platform:digest(platform),project:item.revision,local:local.revision},confirmedAt:new Date(coordinator.now()).toISOString(),confirmedBy:who.actor};
  item.confirmations=item.confirmations.filter(c=>c.confirmedBy!==who.actor);item.confirmations.push(confirmation);
  coordinator.event(state,projectId,'rules.confirmed',confirmation);
 });return view(coordinator,projectId,token,platformFile);
}
