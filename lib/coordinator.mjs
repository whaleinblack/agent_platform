import {randomUUID, randomBytes, createHash, timingSafeEqual} from 'node:crypto';
import {mkdir, readFile, writeFile, rename, realpath, stat} from 'node:fs/promises';
import path from 'node:path';
import {emptyRoadmap,roadmapMeta,roadmapLimit} from './roadmap.mjs';

export class CoordinatorError extends Error {
  constructor(message, status = 400, details) {super(message);this.status = status;this.details = details;}
}
const fail = (message, status = 400, details) => {throw new CoordinatorError(message, status, details);};
const hash = token => createHash('sha256').update(String(token)).digest('hex');
const secret = () => randomBytes(32).toString('hex');
const active = session => ['working', 'waiting'].includes(session.status);
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
const text = (value, name, max, optional = false) => {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail(`Invalid ${name}.`);
  return value.trim();
};
const inside = (root, target) => {const relative = path.relative(root, target);return relative === '' || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);};
const publicSession = session => {const {tokenHash, ...safe} = session;return safe;};

export function filesOverlap(a, b) {
  a = key(a);b = key(b);
  const folderA = a.endsWith('/**'),folderB = b.endsWith('/**');
  const baseA = folderA ? a.slice(0, -3) : a,baseB = folderB ? b.slice(0, -3) : b;
  return baseA === baseB || folderA && baseB.startsWith(baseA + '/') || folderB && baseA.startsWith(baseB + '/');
}

export async function normalizeFiles(root, input) {
  if (!Array.isArray(input) || input.length > 500) fail('Declare at most 500 file paths.');
  const result = new Map();
  for (let value of input) {
    value = text(value, 'file path', 1024);
    if (/[\x00-\x1f\x7f]/.test(value) || value.split(/[\\/]/).includes('..')) fail('File paths cannot contain control characters or parent traversal.');
    let folder = /[\\/]\*\*$/.test(value) || /[\\/]$/.test(value);
    value = value.replace(/[\\/]\*\*$|[\\/]$/, '');
    if (value.includes('*') || value.includes('?')) fail('Only a trailing directory/** claim is supported.');
    const target = path.resolve(root, value);
    if (!inside(root, target) || target === root) fail('File declarations must stay inside the project directory.');
    let ancestor = target,missing = [];
    let canonical;
    while (!canonical) {
      try {canonical = await realpath(ancestor);} catch (error) {
        if (error.code !== 'ENOENT') throw error;
        missing.unshift(path.basename(ancestor));ancestor = path.dirname(ancestor);
        if (!inside(root, ancestor)) fail('File path cannot be resolved inside the project.');
      }
    }
    if (!inside(root, canonical)) fail('Symlinked file paths cannot leave the project.');
    if (!missing.length && (await stat(canonical)).isDirectory()) folder = true;
    if (!missing.length && folder && !(await stat(canonical)).isDirectory()) fail('Directory claims must name a directory.');
    const resolved = path.join(canonical, ...missing);
    const relative = path.relative(root, resolved).split(path.sep).join('/') + (folder ? '/**' : '');
    result.set(key(relative), relative);
  }
  return [...result.values()].sort();
}

export class Coordinator {
  constructor(directory, {now = Date.now} = {}) {
    this.directory = directory;this.now = now;this.queue = Promise.resolve();this.listeners = new Set();
  }
  async init() {
    await mkdir(this.directory, {recursive: true});
    const ownerFile = path.join(this.directory, 'owner.json');
    try {
      const credentials = JSON.parse(await readFile(ownerFile, 'utf8'));
      if (credentials.ownerAccessVersion === 2) this.ownerToken = credentials.token;
      else {this.ownerToken = secret();await writeFile(ownerFile, JSON.stringify({token: this.ownerToken,ownerAccessVersion: 2}), {mode: 0o600});}
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.ownerToken = secret();await writeFile(ownerFile, JSON.stringify({token: this.ownerToken,ownerAccessVersion: 2}), {mode: 0o600});
    }
    if (typeof this.ownerToken !== 'string' || this.ownerToken.length !== 64) throw Error('Invalid owner credentials.');
    this.filename = path.join(this.directory, 'state.json');
    try {this.state = JSON.parse(await readFile(this.filename, 'utf8'));} catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.state = {version: 1, sequence: 0, projects: [], sessions: [], messages: [], notes: [], events: []};
    }
    if (this.state.version !== 1 || !['projects', 'sessions', 'messages', 'notes', 'events'].every(field => Array.isArray(this.state[field]))) throw Error('Unsupported or damaged coordinator state.');
    this.state.roadmaps ??= [];
    if(!Array.isArray(this.state.roadmaps))throw Error('Invalid roadmap state.');
    await this.mutate(state => {
      state.maintenance = false;
      for (const session of state.sessions.filter(active)) this.close(state, session, 'timed_out', 'Coordinator restarted; register again before editing.');
    });
    this.ready = true;return this;
  }
  owner(token) {
    const a = Buffer.from(hash(token)),b = Buffer.from(hash(this.ownerToken));return timingSafeEqual(a, b);
  }
  principal(token) {
    if (this.owner(token)) return {owner: true};
    const session = this.state.sessions.find(s => s.tokenHash === hash(token));
    if (!session) fail('Invalid agent credentials.', 401);
    return {owner: false, sessionId: session.id, projectId: session.projectId, agentId: session.agentId};
  }
  project(id, state = this.state) {const project = state.projects.find(p => p.id === id);if (!project) fail('Project not found.', 404);return project;}
  session(id, state = this.state) {const session = state.sessions.find(s => s.id === id);if (!session) fail('Agent session not found.', 404);return session;}
  authorizeSession(id, token, {allowOwner = false, requireActive = true} = {}) {
    const principal = this.principal(token),session = this.session(id);
    if (principal.owner ? !allowOwner : principal.sessionId !== id) fail('This session belongs to another agent.', 403);
    if (requireActive && !active(session)) fail('Session is closed. Register again before working.', 409, {session: publicSession(session)});
    return principal;
  }
  authorizeProject(id, token, {requireActive = true} = {}) {
    const principal = this.principal(token);this.project(id);
    if (!principal.owner && (principal.projectId !== id || requireActive && !active(this.session(principal.sessionId)))) fail('Agent access is limited to its project.', 403);
    return principal;
  }
  event(state, projectId, type, data) {
    const event = {id: ++state.sequence, projectId, type, at: new Date(this.now()).toISOString(), data};
    state.events.push(event);if (state.events.length > 4000) state.events.splice(0, state.events.length - 4000);return event;
  }
  close(state, session, reason, summary = '') {
    if (!active(session)) return;
    session.status = reason;session.endedAt = new Date(this.now()).toISOString();session.summary = summary;session.claimedFiles = [];
    this.event(state, session.projectId, 'agent.left', publicSession(session));
    if (summary && reason === 'completed') {
      const note = {id: randomUUID(),projectId: session.projectId,title: session.task.slice(0, 200),text: summary,tags: ['handoff'],authorAgentId: session.agentId,createdAt: session.endedAt};
      state.notes.push(note);this.event(state, session.projectId, 'note.posted', note);
    }
  }
  expire(state) {
    for (const session of state.sessions.filter(active)) {
      const project = this.project(session.projectId, state);
      if (this.now() >= Date.parse(session.leaseExpiresAt)) this.close(state, session, 'timed_out', 'Heartbeat lease expired.');
      else if (this.now() - Date.parse(session.lastActivityAt) >= project.idleMs) this.close(state, session, 'idle', 'No progress was declared before the idle timeout.');
    }
  }
  async mutate(fn) {
    const operation = this.queue.then(async () => {
      const state = structuredClone(this.state),before = state.sequence,result = fn(state);
      const temporary = this.filename + '.tmp';
      await writeFile(temporary, JSON.stringify(state), {mode: 0o600});await rename(temporary, this.filename);this.state = state;
      if (state.sequence !== before) for (const listener of [...this.listeners]) listener();
      return result;
    });
    this.queue = operation.catch(() => {});return operation;
  }
  async sweep() {if (!this.state.sessions.some(s => active(s) && (this.now() >= Date.parse(s.leaseExpiresAt) || this.now() - Date.parse(s.lastActivityAt) >= this.project(s.projectId).idleMs))) return;await this.mutate(state => this.expire(state));}
  async createProject(input, token) {
    if (!this.owner(token)) fail('Only the project owner can create projects.', 403);
    const name = text(input.name, 'project name', 100),description = input.description ? text(input.description, 'description', 2000) : '';
    if (typeof input.root !== 'string' || !path.isAbsolute(input.root)) fail('Use an existing absolute project directory.');
    let root;try {root = await realpath(input.root);if (!(await stat(root)).isDirectory()) fail('Project root must be a directory.');} catch (error) {if (error instanceof CoordinatorError) throw error;fail('Project directory does not exist or cannot be read.');}
    const leaseMs = input.leaseMs ?? 45000,idleMs = input.idleMs ?? 300000;
    if (!Number.isInteger(leaseMs) || leaseMs < 15000 || leaseMs > 300000 || !Number.isInteger(idleMs) || idleMs < 60000 || idleMs > 3600000) fail('Lease must be 15–300 seconds; idle timeout must be 1–60 minutes.');
    return this.mutate(state => {
      if (state.projects.some(p => key(p.root) === key(root))) fail('This project directory is already registered.', 409);
      const project = {id: randomUUID(),name,root,description,leaseMs,idleMs,createdAt: new Date(this.now()).toISOString()};state.projects.push(project);this.event(state, project.id, 'project.created', project);return project;
    });
  }
  conflicts(state, projectId, files, ownId) {
    const conflicts = [];
    for (const session of state.sessions) {
      if (session.projectId !== projectId || session.id === ownId || session.status !== 'working') continue;
      const overlap = files.filter(file => session.claimedFiles.some(claim => filesOverlap(file, claim)));
      if (overlap.length) conflicts.push({sessionId: session.id,agentId: session.agentId,files: overlap});
    }
    return conflicts;
  }
  pendingMessages(state, session) {
    return state.messages.filter(message => message.projectId === session.projectId && [session.agentId, '*'].includes(message.toAgentId) && !(message.deliveredTo || []).includes(session.agentId));
  }
  remindInbox(state, session) {
    const pending = this.pendingMessages(state, session),at = new Date(this.now()).toISOString();
    if (active(session) && pending.length) {
      session.lastInboxReminderAt = at;
      for (const message of pending.slice(0, 20)) {
        message.remindedTo ??= [];
        let recipient = message.remindedTo.find(item => item.agentId === session.agentId);
        if (!recipient) {recipient = {agentId: session.agentId,count: 0};message.remindedTo.push(recipient);}
        recipient.count++;recipient.lastAt = at;
      }
    }
    return {unreadCount: pending.length,requiresCheck: pending.length > 0,hasMore: pending.length > 20,messages: pending.slice(0, 20).map(({id,fromAgentId,toAgentId,text,kind,createdAt}) => ({id,fromAgentId,toAgentId,text,kind,createdAt}))};
  }
  async join(input) {
    const project = this.project(input.projectId),agentId = text(input.agentId, 'agent ID', 120),task = text(input.task, 'task', 2000);
    if (!/^[\w.:-]+$/.test(agentId)) fail('Use the actual agent ID with letters, digits, dots, colons or hyphens.');
    const files = await normalizeFiles(project.root, input.files ?? []),token = secret();
    return this.mutate(state => {
      if (state.maintenance) fail('Coordinator is restarting. Retry registration shortly.', 503);
      this.expire(state);
      if (state.sessions.some(s => s.projectId === project.id && s.agentId === agentId && active(s))) fail('This agent already has an active session.', 409);
      const now = new Date(this.now()).toISOString(),conflicts = this.conflicts(state, project.id, files);
      const session = {id: randomUUID(),projectId: project.id,agentId,task,files,claimedFiles: conflicts.length ? [] : [...files],status: conflicts.length ? 'waiting' : 'working',progress: '',conflicts,joinedAt: now,lastHeartbeatAt: now,lastActivityAt: now,leaseExpiresAt: new Date(this.now() + project.leaseMs).toISOString(),tokenHash: hash(token)};
      state.sessions.push(session);this.event(state, project.id, 'agent.joined', publicSession(session));
      return {session: {...publicSession(session),token},heartbeatIntervalMs: Math.min(10000, Math.floor(project.leaseMs / 3)),leaseMs: project.leaseMs,idleMs: project.idleMs,cursor: state.sequence};
    });
  }
  async heartbeat(id, input, token) {
    await this.sweep();
    this.authorizeSession(id, token);if (input.state && !['working', 'waiting', 'idle'].includes(input.state)) fail('Invalid heartbeat state.');
    return this.mutate(state => {
      this.expire(state);const session = this.session(id, state);if (!active(session)) fail('Session expired. Register again.', 409, {session: publicSession(session)});
      if (input.state === 'idle') this.close(state, session, 'idle', 'Agent declared idle.');
      else {session.lastHeartbeatAt = new Date(this.now()).toISOString();session.leaseExpiresAt = new Date(this.now() + this.project(session.projectId, state).leaseMs).toISOString();}
      const inbox = this.remindInbox(state, session);return {session: {...publicSession(session),unreadCount: inbox.unreadCount},leaseExpiresAt: session.leaseExpiresAt,inbox};
    });
  }
  async update(id, input, token) {
    await this.sweep();
    this.authorizeSession(id, token);const existing = this.session(id),project = this.project(existing.projectId);
    const files = input.files === undefined ? existing.files : await normalizeFiles(project.root, input.files);
    const task = input.task === undefined ? existing.task : text(input.task, 'task', 2000);
    const progress = input.progress === undefined ? existing.progress : text(input.progress, 'progress', 2000);
    return this.mutate(state => {
      this.expire(state);const session = this.session(id, state);if (!active(session)) fail('Session expired. Register again.', 409);
      const conflicts = this.conflicts(state, project.id, files, id);
      if (conflicts.length && session.status === 'working') fail('New files conflict with an active agent. Existing claims are unchanged.', 409, {conflicts});
      const status = conflicts.length ? 'waiting' : 'working',activity = input.files !== undefined || input.task !== undefined || input.progress !== undefined || session.status !== status;
      const changed = activity || JSON.stringify(session.conflicts) !== JSON.stringify(conflicts);
      Object.assign(session, {files,task,progress,conflicts,status,claimedFiles: conflicts.length ? [] : [...files],lastActivityAt: activity ? new Date(this.now()).toISOString() : session.lastActivityAt});
      if (changed) this.event(state, project.id, 'agent.updated', publicSession(session));const inbox = this.remindInbox(state, session);return {session: {...publicSession(session),unreadCount: inbox.unreadCount},inbox};
    });
  }
  async leave(id, input, token) {
    this.authorizeSession(id, token, {allowOwner: true,requireActive: false});
    if (!['completed', 'idle', 'failed', 'cancelled'].includes(input.reason)) fail('Invalid leave reason.');
    const summary = input.summary ? text(input.summary, 'handoff summary', 8000) : '';
    return this.mutate(state => {const session = this.session(id, state);this.close(state, session, input.reason, summary);return {session: publicSession(session)};});
  }
  async sendMessage(input, token) {
    const principal = this.authorizeProject(input.projectId, token),toAgentId = text(input.toAgentId, 'recipient agent ID', 120),content = text(input.text, 'message', 8000),kind = input.kind || 'message';
    if (toAgentId !== '*' && !/^[\w.:-]+$/.test(toAgentId) || !['message', 'schedule'].includes(kind)) fail('Invalid message recipient or kind.');
    return this.mutate(state => {
      if (!principal.owner && !active(this.session(principal.sessionId, state))) fail('Session is closed.', 409);
      const message = {id: randomUUID(),projectId: input.projectId,fromAgentId: principal.owner ? 'owner' : principal.agentId,toAgentId,text: content,kind,createdAt: new Date(this.now()).toISOString(),deliveredTo: []};
      state.messages.push(message);this.event(state, input.projectId, 'message.sent', message);
      if (!principal.owner) this.session(principal.sessionId, state).lastActivityAt = message.createdAt;
      return {message};
    });
  }
  async postNote(projectId, input, token) {
    const principal = this.authorizeProject(projectId, token),title = text(input.title, 'note title', 200),content = text(input.text, 'note', 16000);
    const tags = input.tags ?? [];if (!Array.isArray(tags) || tags.length > 12 || tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 40)) fail('Invalid note tags.');
    return this.mutate(state => {
      if (!principal.owner && !active(this.session(principal.sessionId, state))) fail('Session is closed.', 409);
      const note = {id: randomUUID(),projectId,title,text: content,tags,authorAgentId: principal.owner ? 'owner' : principal.agentId,createdAt: new Date(this.now()).toISOString()};
      state.notes.push(note);this.event(state, projectId, 'note.posted', note);if (!principal.owner) this.session(principal.sessionId, state).lastActivityAt = note.createdAt;return {note};
    });
  }
  roadmap(projectId,token){
    this.authorizeProject(projectId,token,{requireActive:false});
    return structuredClone(this.state.roadmaps.find(r=>r.projectId===projectId)||emptyRoadmap(projectId));
  }
  async updateRoadmap(projectId,input,token,{claim=false}={}){
    const principal=this.authorizeProject(projectId,token);
    if(!Number.isSafeInteger(input.baseRevision)||input.baseRevision<0)fail('A roadmap baseRevision is required.');
    if(!claim&&input.html===undefined&&input.editorAgentId===undefined)fail('No roadmap changes supplied.');
    if(input.html!==undefined&&(typeof input.html!=='string'||Buffer.byteLength(input.html,'utf8')>roadmapLimit||input.html.includes('\0')))fail('Roadmap HTML must be at most 64 KiB.');
    if(input.editorAgentId!==undefined){
      if(!principal.owner)fail('Only the owner can assign the roadmap editor.',403);
      if(input.editorAgentId!==null)text(input.editorAgentId,'roadmap editor',120);
    }
    return this.mutate(state=>{
      this.expire(state);
      if(!principal.owner&&this.session(principal.sessionId,state).status!=='working')fail('A working session is required to edit the roadmap.',409);
      let value=state.roadmaps.find(r=>r.projectId===projectId);
      const current=value||emptyRoadmap(projectId);
      if(current.revision!==input.baseRevision)fail('Roadmap changed. Reload before saving.',409,{revision:current.revision});
      if(!principal.owner){
        if(claim){if(current.editorAgentId&&current.editorAgentId!==principal.agentId)fail('Another agent owns this roadmap.',409);}
        else if(current.editorAgentId!==principal.agentId)fail('Claim this roadmap or ask the owner to assign you first.',403);
      }
      if(!value){value=current;state.roadmaps.push(value);}
      if(input.html!==undefined){
        if(value.html)value.history=[...value.history,{revision:value.revision,html:value.html,updatedAt:value.updatedAt,updatedBy:value.updatedBy}].slice(-5);
        value.html=input.html;
      }
      if(claim&&!principal.owner)value.editorAgentId=principal.agentId;
      if(input.editorAgentId!==undefined)value.editorAgentId=input.editorAgentId===null?null:input.editorAgentId.trim();
      value.revision++;value.updatedAt=new Date(this.now()).toISOString();value.updatedBy=principal.owner?'owner':principal.agentId;
      if(!principal.owner)this.session(principal.sessionId,state).lastActivityAt=value.updatedAt;
      this.event(state,projectId,'roadmap.updated',roadmapMeta(value));
      return {roadmap:structuredClone(value)};
    });
  }
  inbox(id, token) {
    this.authorizeSession(id, token, {requireActive: false});const session = this.session(id);
    return {messages: this.pendingMessages(this.state, session),cursor: this.state.sequence};
  }
  async acknowledge(id, input, token) {
    this.authorizeSession(id, token);if (!Array.isArray(input.messageIds) || input.messageIds.length > 500 || input.messageIds.some(id => typeof id !== 'string')) fail('Invalid message acknowledgments.');
    return this.mutate(state => {
      const session = this.session(id, state);if (!active(session)) fail('Session is closed.', 409);let count = 0;
      for (const id of new Set(input.messageIds)) {
        const message = state.messages.find(m => m.id === id);
        if (!message || message.projectId !== session.projectId || ![session.agentId, '*'].includes(message.toAgentId)) fail('Cannot acknowledge another agent\'s message.', 403);
        if (!message.deliveredTo.includes(session.agentId)) {message.deliveredTo.push(session.agentId);count++;}
      }
      return {acknowledged: count};
    });
  }
  snapshot(id) {
    const project = this.project(id);
    return {project,roadmap:roadmapMeta(this.state.roadmaps.find(r=>r.projectId===id)||emptyRoadmap(id)),agents: this.state.sessions.filter(s => s.projectId === id).map(s => ({...publicSession(s),unreadCount: this.pendingMessages(this.state, s).length,...(active(s) ? {conflicts: this.conflicts(this.state, id, s.files, s.id)} : {})})),messages: this.state.messages.filter(m => m.projectId === id),notes: this.state.notes.filter(n => n.projectId === id),events: this.state.events.filter(e => e.projectId === id).slice(-100),cursor: this.state.sequence};
  }
  readEvents(id, after, token) {
    this.authorizeSession(id, token, {requireActive: false});const session = this.session(id);
    const events = this.state.events.filter(event => event.id > after && event.projectId === session.projectId && (event.type !== 'message.sent' || ['*', session.agentId].includes(event.data.toAgentId) || event.data.fromAgentId === session.agentId));
    return {cursor: this.state.sequence,events,session: publicSession(session),gap: this.state.events.length > 0 && after < this.state.events[0].id - 1};
  }
  async waitEvents(id, after, wait, token, signal) {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(wait) || wait < 0 || wait > 25000) fail('Invalid event cursor or wait.');
    const result = this.readEvents(id, after, token);if (result.events.length || !active(result.session) || !wait || signal?.aborted) return result;
    await new Promise(resolve => {
      let timer;
      const done = () => {clearTimeout(timer);this.listeners.delete(check);signal?.removeEventListener('abort', done);resolve();};
      const check = () => {const result = this.readEvents(id, after, token);if (result.events.length || !active(result.session)) done();};
      this.listeners.add(check);signal?.addEventListener('abort', done, {once: true});timer = setTimeout(done, wait);check();
    });
    return this.readEvents(id, after, token);
  }
  async prepareIdleRestart() {
    await this.mutate(state => {this.expire(state);const sessions = state.sessions.filter(active);if (sessions.length) fail('Agents are still active. Wait for their sessions to finish.', 409, {activeAgents: sessions.length});state.maintenance = true;});
  }
  async shutdown() {await this.mutate(state => {for (const session of state.sessions.filter(active)) this.close(state, session, 'timed_out', 'Coordinator stopped.');});}
}
