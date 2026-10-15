import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ApiError, CoordinatorClient, CredentialStore, SessionClient, registerSession,
  startWatching, runSession, publicResult, normalizeBaseUrl,
} from '../lib/client.mjs';
import { installShutdownSignals, main, parseArgs } from '../cli.mjs';
import { Coordinator } from '../lib/coordinator.mjs';
import { createHttpServer } from '../lib/http-server.mjs';

async function flush() {
  for (let i = 0; i < 80; i += 1) await Promise.resolve();
}

class FakeClock {
  time = 0;
  nextId = 0;
  jobs = new Map();
  now = () => this.time;
  setTimeout = (callback, delay) => {
    const id = ++this.nextId;
    this.jobs.set(id, { callback, at: this.time + delay });
    return id;
  };
  clearTimeout = id => this.jobs.delete(id);
  async tick(ms) {
    const until = this.time + ms;
    await flush();
    for (;;) {
      const pending = [...this.jobs].filter(([, job]) => job.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!pending) break;
      const [id, job] = pending;
      this.time = job.at;
      this.jobs.delete(id);
      job.callback();
      await flush();
    }
    this.time = until;
    await flush();
  }
}

function fixture({ status = 'working', files = ['a.txt'], idleMs = 300_000, withInbox = true } = {}) {
  const clock = new FakeClock();
  const calls = [], saved = [], events = [], pending = new Set();
  const session = { id: 's-1', token: 'secret-token', status, projectId: 'p1', agentId: 'agent-real', task: 'task', files: [...files], claimedFiles: status === 'working' ? [...files] : [], conflicts: [], lastActivity: 0 };
  let cursor = 0;
  const state = { busy: status === 'waiting', heartbeatError: false, eventError: false, idleMs, session, messages: [], abortedPolls: 0, heartbeatHook: null };
  const response = (data, code = 200) => new Response(JSON.stringify(data), { status: code });
  const envelope = () => ({ session: structuredClone(session) });
  const inboxSummary = () => {
    const messages = state.messages.filter(message => (!message.projectId || message.projectId === session.projectId)
      && [session.agentId, '*'].includes(message.toAgentId) && !message.deliveredTo?.includes(session.agentId));
    return { unreadCount: messages.length, requiresCheck: messages.length > 0, messages: messages.slice(0, 20), hasMore: messages.length > 20 };
  };
  const activityEnvelope = () => ({ ...envelope(), ...(withInbox ? { inbox: inboxSummary() } : {}) });
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url: parsed, path, method: options.method, headers: options.headers, body });
    if (options.signal?.aborted) throw options.signal.reason;
    if (path === '/api/projects') return response({ projects: [{ id: 'p1' }] });
    if (path === '/api/agents/join') {
      Object.assign(session, body, { status: state.busy ? 'waiting' : 'working', lastActivity: clock.now() });
      session.claimedFiles = state.busy ? [] : [...body.files];
      return response({ ...envelope(), heartbeatIntervalMs: 10_000, leaseMs: 45_000, idleMs, cursor });
    }
    if (options.headers.Authorization !== 'Bearer secret-token') return response({ error: 'Unauthorized' }, 401);
    if (path === '/api/projects/p1' && options.method === 'GET') return response({ project: { id: 'p1' }, agents: [session] });
    if (path.endsWith('/notes') && options.method === 'GET') return response({ notes: [{ title: 'Decision', text: parsed.searchParams.get('q') || 'All notes' }] });
    if (path === '/api/sessions/s-1' && options.method === 'PATCH') {
      if (!['working', 'waiting'].includes(session.status)) return response({ error: 'closed' }, 409);
      if (state.busy && session.status === 'working' && body.files?.includes('busy.txt')) return response({ error: 'conflict', session: { ...session, files: ['busy.txt'] } }, 409);
      const previousStatus = session.status;
      Object.assign(session, body);
      session.status = state.busy ? 'waiting' : 'working';
      if (Object.keys(body).length || previousStatus !== session.status) session.lastActivity = clock.now();
      session.claimedFiles = state.busy ? [] : [...session.files];
      session.conflicts = state.busy ? [{ agentId: 'other' }] : [];
      return response(activityEnvelope());
    }
    if (path.endsWith('/heartbeat')) {
      if (state.heartbeatHook) await state.heartbeatHook(body, options.signal);
      if (state.heartbeatError) return response({ error: 'expired' }, 409);
      if (body.state === 'idle') session.status = 'closed';
      else if (clock.now() - session.lastActivity >= idleMs) session.status = 'closed';
      if (session.status === 'closed') session.claimedFiles = [];
      session.leaseUpdatedAt = clock.now();
      return response(activityEnvelope());
    }
    if (path.endsWith('/leave')) {
      session.status = 'closed';
      session.claimedFiles = [];
      session.reason = body.reason;
      if (body.summary) state.summary = body.summary;
      return response(envelope());
    }
    if (path.endsWith('/events')) {
      if (state.eventError) return response({ error: 'events unavailable' }, 503);
      if (events.length) return response({ ...envelope(), cursor: ++cursor, events: events.splice(0) });
      return new Promise((resolve, reject) => {
        const poll = { deliver: values => {
          options.signal.removeEventListener('abort', abort);
          pending.delete(poll);
          resolve(response({ ...envelope(), cursor: ++cursor, events: values }));
        } };
        const abort = () => {
          pending.delete(poll);
          state.abortedPolls += 1;
          reject(options.signal.reason);
        };
        options.signal.addEventListener('abort', abort, { once: true });
        pending.add(poll);
      });
    }
    if (path.endsWith('/inbox')) return response({ messages: state.messages, cursor: 999 });
    if (path.endsWith('/ack')) {
      if (!['working', 'waiting'].includes(session.status)) return response({ error: 'closed', session }, 409);
      for (const message of state.messages) if (body.messageIds.includes(message.id)) message.deliveredTo.push(session.agentId);
      return response({ acknowledged: body.messageIds });
    }
    if (path === '/api/messages') {
      const message = { id: 'm-new', fromAgentId: session.agentId, createdAt: 'now', deliveredTo: [], ...body };
      state.messages.push(message);
      return response({ message });
    }
    if (path.endsWith('/notes')) return response({ note: body });
    throw new Error(`Unexpected request: ${options.method} ${url}`);
  };
  const store = { save: async record => { saved.push(structuredClone(record)); }, load: async () => structuredClone(saved.at(-1)) };
  const client = new CoordinatorClient({ fetchImpl });
  const record = { version: 1, baseUrl: client.baseUrl, session: structuredClone(session), cursor: 0, heartbeatIntervalMs: 10_000, leaseMs: 45_000, idleMs };
  const handle = new SessionClient({ client, store, record });
  const deliver = values => {
    const poll = [...pending][0];
    if (poll) poll.deliver(values);
    else events.push(...values);
  };
  return { clock, calls, saved, client, handle, store, state, session, deliver, pending, fetchImpl };
}

function childMock({ refuseTerm = false, refuseAll = false } = {}) {
  const child = new EventEmitter();
  child.kills = [];
  child.kill = signal => {
    child.kills.push(signal);
    if (!refuseAll && !(refuseTerm && signal === 'SIGTERM')) child.emit('exit', null, signal);
    return true;
  };
  child.finish = code => child.emit('exit', code, null);
  return child;
}

function capture() {
  let text = '';
  return { write: chunk => { text += chunk; }, get text() { return text; } };
}

function pendingMessage(id, overrides = {}) {
  return { id, projectId: 'p1', fromAgentId: 'owner', toAgentId: 'agent-real',
    text: `Message ${id}`, kind: 'message', createdAt: '2026-10-02T00:00:00Z', deliveredTo: [], ...overrides };
}

test('public project list, authenticated snapshot, join contract, credentials and token redaction', async () => {
  const f = fixture();
  assert.equal((await f.client.projects()).projects[0].id, 'p1');
  await f.handle.snapshot();
  const handle = await registerSession(f.client, f.store, { projectId: 'p1', agentId: 'actual-agent-id', task: 'write', files: ['a,b.txt', 'space file.txt'] });
  assert.deepEqual(f.calls[2].body, { projectId: 'p1', agentId: 'actual-agent-id', task: 'write', files: ['a,b.txt', 'space file.txt'] });
  assert.equal(f.calls[0].headers.Authorization, undefined);
  assert.equal(f.calls[1].headers.Authorization, 'Bearer secret-token');
  assert.equal(f.saved[0].session.token, 'secret-token');
  assert.equal(handle.record.leaseMs, 45_000);
  assert.equal(handle.record.idleMs, 300_000);
  assert.equal(JSON.stringify(publicResult({ session: handle.session, nested: [{ token: 'also secret' }] })).includes('secret'), false);
});

test('files [] is a valid read-only registration and update', async () => {
  const f = fixture();
  const h = await registerSession(f.client, f.store, { projectId: 'p1', agentId: 'reader', task: 'inspect', files: [] });
  assert.deepEqual(h.session.files, []);
  await h.update({ files: [] });
  assert.equal(h.session.status, 'working');
  assert.deepEqual(h.session.files, []);
});

test('credential writes are atomic, local, resumable and reject unsafe session names', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-coordinator-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new CredentialStore(join(directory, 'private', 'clients'));
  const f = fixture();
  const h = await registerSession(f.client, store, { projectId: 'p1', agentId: 'real', task: 'test', files: [] });
  await h.heartbeat('working');
  assert.deepEqual(await store.load('s-1'), h.record);
  assert.deepEqual(await readdir(store.directory), ['s-1.json']);
  assert.match(await readFile(store.path('s-1'), 'utf8'), /secret-token/);
  for (const id of ['../outside', '..', 'CON', 'NUL.json', 'name.', 'C:\\path', '/x']) assert.throws(() => store.path(id));
  await assert.rejects(store.save({ ...h.record, version: 9 }), /Invalid/);
  assert.throws(() => new SessionClient({ record: h.record, client: new CoordinatorClient({ baseUrl: 'http://localhost:9999' }) }), /another base URL/);
});

test('failed credential storage releases an otherwise stranded join', async () => {
  const f = fixture();
  await assert.rejects(registerSession(f.client, { save: async () => { throw new Error('disk full'); } }, { projectId: 'p1', agentId: 'a', task: 't', files: ['a'] }), /disk full/);
  assert.equal(f.session.status, 'closed');
  assert.equal(f.calls.filter(call => call.path.endsWith('/leave')).length, 1);
});

test('working update HTTP 409 does not replace old claims, waiting update can acquire later', async () => {
  const f = fixture();
  f.state.busy = true;
  await assert.rejects(f.handle.update({ files: ['busy.txt'], progress: 'add file' }), error => error instanceof ApiError && error.status === 409);
  assert.deepEqual(f.handle.session.files, ['a.txt']);
  assert.equal(f.handle.session.status, 'working');
  const waiting = fixture({ status: 'waiting' });
  await waiting.handle.update({ files: ['a.txt'] });
  assert.equal(waiting.handle.session.status, 'waiting');
  waiting.state.busy = false;
  await waiting.handle.update({ progress: 'conflict resolved' });
  assert.equal(waiting.handle.session.status, 'working');
});

test('heartbeat renews without lastActivity, idle heartbeat closes even read-only work', async () => {
  const f = fixture({ files: [] });
  await f.clock.tick(10_000);
  await f.handle.heartbeat('working');
  assert.equal(f.handle.session.lastActivity, 0);
  assert.equal(f.handle.session.leaseUpdatedAt, 10_000);
  await f.handle.heartbeat('idle');
  assert.equal(f.handle.active, false);
  assert.deepEqual(f.calls.at(-1).body, { state: 'idle' });
  assert.throws(() => f.handle.heartbeat('closed'), /heartbeat state/);
});

test('messages and notes use bound project and bearer auth; inbox is offline readable and ack is explicit', async () => {
  const f = fixture();
  await f.handle.send({ toAgentId: 'offline-agent', text: 'Please review', kind: 'schedule' });
  assert.deepEqual(f.calls.at(-1).body, { projectId: 'p1', toAgentId: 'offline-agent', text: 'Please review', kind: 'schedule' });
  await f.handle.note({ title: 'Decision', text: 'Use API', tags: ['design'] });
  assert.equal(f.calls.at(-1).path, '/api/projects/p1/notes');
  f.state.messages = [
    { id: 'm1', toAgentId: 'agent-real', fromAgentId: 'other', deliveredTo: [] },
    { id: 'wrong', toAgentId: 'someone', fromAgentId: 'other', deliveredTo: [] },
    { id: 'cross', projectId: 'other-project', toAgentId: 'agent-real', deliveredTo: [] },
  ];
  const inbox = await f.handle.inbox();
  assert.deepEqual(inbox.messages.map(message => message.id), ['m1']);
  assert.deepEqual(inbox.messages[0].deliveredTo, []);
  assert.equal(f.handle.cursor, 0);
  await f.handle.ack(['m1', 'm1']);
  assert.deepEqual(f.calls.at(-1).body, { messageIds: ['m1'] });
  assert.deepEqual((await f.handle.inbox()).messages[0].deliveredTo, ['agent-real']);
  await f.handle.leave('completed', 'Finished review');
  assert.equal(f.state.summary, 'Finished review');
  await f.handle.inbox();
  await f.handle.snapshot();
  await f.handle.notes('closed session search');
  await assert.rejects(f.handle.ack(['m1']), error => error.status === 409);
  assert.ok(f.calls.filter(call => !['/api/agents/join', '/api/projects'].includes(call.path)).every(call => call.headers.Authorization === 'Bearer secret-token'));
});

test('events filter project and addressed agents, persist cursor, and do not auto-ack', async () => {
  const f = fixture();
  f.deliver([
    { id: 1, type: 'message.created', projectId: 'p1', at: 'now', data: { toAgentId: 'agent-real', text: 'hello' } },
    { id: 2, type: 'message', projectId: 'p1', at: 'now', data: { toAgentId: 'someone', fromAgentId: 'other' } },
    { id: 3, type: 'message', projectId: 'p1', at: 'now', data: { toAgentId: 'someone', fromAgentId: 'agent-real' } },
    { id: 4, type: 'note.created', projectId: 'other', at: 'now', data: {} },
    { id: 5, type: 'message.sent', projectId: 'p1', at: 'now', data: { toAgentId: '*', fromAgentId: 'other' } },
  ]);
  const result = await f.handle.events();
  assert.deepEqual(result.events.map(event => event.id), [1, 3, 5]);
  assert.equal(f.handle.cursor, 1);
  assert.equal(f.saved.at(-1).cursor, 1);
  assert.equal(f.calls[0].url.searchParams.get('after'), '0');
  assert.equal(f.calls[0].url.searchParams.get('wait'), '25000');
  assert.equal(f.calls.some(call => call.path.endsWith('/ack')), false);
});

test('watch heartbeats continue during long poll and repeated shutdown leaves once', async () => {
  const f = fixture();
  const watcher = startWatching(f.handle, { clock: f.clock });
  await watcher.ready;
  await flush();
  assert.equal(f.pending.size, 1);
  await f.clock.tick(30_000);
  assert.equal(f.calls.filter(call => call.path.endsWith('/heartbeat')).length, 4);
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 0);
  const done = watcher.stop('idle');
  assert.equal(watcher.stop('failed'), done);
  assert.equal((await done).reason, 'idle');
  assert.equal(f.calls.filter(call => call.path.endsWith('/leave')).length, 1);
  assert.equal(f.calls.at(-1).body.reason, 'idle');
  assert.equal(f.pending.size, 0);
  assert.equal(f.clock.jobs.size, 0);
  assert.equal(f.state.abortedPolls, 1);
});

test('watch probes waiting without editing and acquires when conflicts clear', async () => {
  const f = fixture({ status: 'waiting' });
  const statuses = [];
  const watcher = startWatching(f.handle, { clock: f.clock, onSession: session => statuses.push(session.status) });
  await watcher.ready;
  assert.equal(f.handle.session.status, 'waiting');
  f.state.busy = false;
  await f.clock.tick(10_000);
  assert.equal(f.handle.session.status, 'working');
  assert.ok(statuses.includes('waiting') && statuses.includes('working'));
  assert.ok(f.calls.filter(call => call.method === 'PATCH').every(call => Object.keys(call.body).length === 0));
  await watcher.stop('cancelled');
});

test('watch exits when session becomes nonworking/nonwaiting and does not invent activity', async () => {
  const f = fixture({ idleMs: 20_000 });
  const watcher = startWatching(f.handle, { clock: f.clock });
  await watcher.ready;
  await f.clock.tick(20_000);
  const result = await watcher.done;
  assert.equal(result.session.status, 'closed');
  assert.equal(f.calls.filter(call => call.path.endsWith('/leave')).length, 0);
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 0);
  assert.equal(f.pending.size, 0);
  const closed = fixture({ status: 'expired' });
  const second = startWatching(closed.handle, { clock: closed.clock });
  await second.ready;
  await second.done;
  assert.equal(closed.calls.length, 0);
});

test('run verifies working lease, starts exact argv, reports activity, and cleans up on completion', async () => {
  const f = fixture();
  const child = childMock();
  const spawns = [];
  const running = runSession(f.handle, 'node', ['job.mjs', '--help', 'a,b'], { clock: f.clock, spawnImpl: (...args) => { spawns.push(args); return child; }, summary: 'Completed job' });
  await flush();
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0], ['node', ['job.mjs', '--help', 'a,b'], { stdio: 'inherit', shell: false }]);
  assert.equal(f.calls.filter(call => call.path.endsWith('/heartbeat')).length, 2);
  await f.clock.tick(360_000);
  const updates = f.calls.filter(call => call.method === 'PATCH');
  assert.equal(updates.length, 6);
  assert.ok(updates.every(call => typeof call.body.progress === 'string'));
  assert.equal(f.handle.session.status, 'working');
  child.finish(0);
  const result = await running;
  assert.equal(result.exitCode, 0);
  assert.equal(result.reason, 'completed');
  assert.equal(f.state.summary, 'Completed job');
  assert.equal(child.kills.length, 0);
  assert.equal(f.pending.size, 0);
  assert.equal(f.clock.jobs.size, 0);
  assert.equal(f.calls.filter(call => call.path.endsWith('/leave')).length, 1);
});

test('run waits for a claim and never launches after cancellation while waiting', async () => {
  const f = fixture({ status: 'waiting' });
  let launches = 0;
  const controller = new AbortController();
  const running = runSession(f.handle, 'editor', [], { clock: f.clock, signal: controller.signal, spawnImpl: () => { launches += 1; return childMock(); } });
  await flush();
  await f.clock.tick(30_000);
  assert.equal(launches, 0);
  controller.abort();
  const result = await running;
  assert.equal(result.exitCode, 130);
  assert.equal(launches, 0);
  assert.equal(f.calls.at(-1).body.reason, 'idle');
});

test('run launches only once after waiting acquires a working claim', async () => {
  const f = fixture({ status: 'waiting' });
  let launches = 0;
  const child = childMock();
  const running = runSession(f.handle, 'editor', [], { clock: f.clock, spawnImpl: () => { launches += 1; return child; } });
  await flush();
  assert.equal(launches, 0);
  f.state.busy = false;
  await f.clock.tick(20_000);
  assert.equal(launches, 1);
  child.finish(7);
  const result = await running;
  assert.equal(result.exitCode, 7);
  assert.equal(result.reason, 'failed');
});

test('stale heartbeat stops run child before leaving; force kill escalates and shutdown is deduplicated', async () => {
  const f = fixture();
  const child = childMock({ refuseTerm: true });
  let aliveAtLeave;
  const originalLeave = f.handle.leave.bind(f.handle);
  f.handle.leave = (...args) => { aliveAtLeave = child.kills.length < 2; return originalLeave(...args); };
  const running = runSession(f.handle, 'editor', [], { clock: f.clock, spawnImpl: () => child, killGraceMs: 1_000 });
  await flush();
  f.state.heartbeatError = true;
  await f.clock.tick(10_000);
  assert.deepEqual(child.kills, ['SIGTERM']);
  assert.equal(f.calls.some(call => call.path.endsWith('/leave')), false);
  await f.clock.tick(1_000);
  const result = await running;
  assert.equal(result.error.status, 409);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
  assert.equal(aliveAtLeave, false);
  assert.equal(f.calls.filter(call => call.path.endsWith('/leave')).length, 1);
});

test('lost files or closed session from events immediately stops run work', async () => {
  for (const change of [{ claimedFiles: [] }, { status: 'expired' }]) {
    const f = fixture();
    const child = childMock();
    const running = runSession(f.handle, 'editor', [], { clock: f.clock, spawnImpl: () => child });
    await flush();
    Object.assign(f.session, change);
    f.deliver([{ id: 1, type: 'session.updated', projectId: 'p1', at: 'now', data: {} }]);
    await flush();
    const result = await running;
    assert.match(result.error.message, /claim was lost/);
    assert.deepEqual(child.kills, ['SIGTERM']);
    assert.equal(result.exitCode, 1);
  }
});

test('event transport failure and initial stale heartbeat both fail closed', async () => {
  const f = fixture();
  f.state.eventError = true;
  const child = childMock();
  const result = await runSession(f.handle, 'editor', [], { clock: f.clock, spawnImpl: () => child });
  assert.equal(result.error.status, 503);
  assert.deepEqual(child.kills, ['SIGTERM']);
  const initial = fixture();
  initial.state.heartbeatError = true;
  let launches = 0;
  const second = await runSession(initial.handle, 'editor', [], { clock: initial.clock, spawnImpl: () => { launches += 1; return childMock(); } });
  assert.equal(launches, 0);
  assert.equal(second.error.status, 409);
});

test('spawn errors clean up listener and release claims with failed reason', async () => {
  const f = fixture();
  const result = await runSession(f.handle, 'missing', [], { clock: f.clock, spawnImpl: () => { throw new Error('ENOENT fixture'); } });
  assert.match(result.error.message, /ENOENT/);
  assert.equal(result.exitCode, 1);
  assert.equal(f.calls.at(-1).body.reason, 'failed');
  assert.equal(f.pending.size, 0);
});

test('Ctrl+C is idle cleanup, repeated signals do not duplicate kills or leave', async () => {
  const f = fixture();
  const child = childMock();
  const processLike = new EventEmitter();
  const controller = new AbortController();
  const remove = installShutdownSignals(processLike, controller);
  const running = runSession(f.handle, 'editor', [], { clock: f.clock, signal: controller.signal, spawnImpl: () => child });
  await flush();
  processLike.emit('SIGINT');
  processLike.emit('SIGINT');
  processLike.emit('SIGTERM');
  const result = await running;
  remove();
  assert.equal(result.exitCode, 130);
  assert.deepEqual(child.kills, ['SIGTERM']);
  assert.equal(f.calls.filter(call => call.path.endsWith('/leave')).length, 1);
  assert.equal(f.calls.at(-1).body.reason, 'idle');
  assert.equal(processLike.listenerCount('SIGINT'), 0);
});

test('interrupt during prelaunch lease verification never starts child', async () => {
  const f = fixture();
  const controller = new AbortController();
  let heartbeats = 0, launches = 0;
  f.state.heartbeatHook = async (_body, signal) => {
    if (++heartbeats === 2) await new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  const running = runSession(f.handle, 'editor', [], { clock: f.clock, signal: controller.signal, spawnImpl: () => { launches += 1; return childMock(); } });
  await flush();
  controller.abort();
  await running;
  assert.equal(launches, 0);
  assert.equal(f.calls.at(-1).body.reason, 'idle');
});

test('unresponsive child is not voluntarily released before termination is confirmed', async () => {
  const f = fixture();
  const child = childMock({ refuseAll: true });
  const controller = new AbortController();
  const running = runSession(f.handle, 'editor', [], { clock: f.clock, signal: controller.signal, spawnImpl: () => child, killGraceMs: 100 });
  await flush();
  controller.abort();
  await f.clock.tick(200);
  const result = await running;
  assert.match(result.error.message, /Child did not stop/);
  assert.equal(f.calls.some(call => call.path.endsWith('/leave')), false);
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
  child.finish(0);
});

test('CLI parser preserves spaces, comma filenames and literal child flags; rejects ambiguous input', () => {
  const args = parseArgs(['run', '--project', 'p1', '--agent', 'real', '--task', 'Task', '--file', 'a,b.txt', '--file', 'space file.txt', '--', 'node', '--help', '--file', 'child']);
  assert.deepEqual(args.options.file, ['a,b.txt', 'space file.txt']);
  assert.deepEqual(args.child, ['node', '--help', '--file', 'child']);
  assert.equal(parseArgs(['join', '--watch']).options.watch, true);
  assert.equal(parseArgs(['update', '--progress=--literal']).options.progress, '--literal');
  for (const input of [['create'], ['run'], ['join', '--project'], ['join', '--agent', 'a', '--agent', 'b'], ['projects', 'extra'], ['join', '--wat'], ['join', '--watch=true']]) assert.throws(() => parseArgs(input));
});

test('CLI one-shot commands, JSON file lists, resume, inbox ack and no admin surface', async () => {
  const f = fixture();
  const stdout = capture(), stderr = capture();
  const options = { stdout, stderr, store: f.store, fetchImpl: f.fetchImpl };
  assert.equal(await main(['join', '--project', 'p1', '--agent', 'real', '--task', 'test', '--files', '["a,b.txt","space file.txt"]'], options), 0);
  assert.deepEqual(f.session.files, ['a,b.txt', 'space file.txt']);
  assert.equal(stdout.text.includes('secret-token'), false);
  assert.equal(await main(['update', '--session', 's-1', '--files', '[]', '--progress', 'Read-only now'], options), 0);
  assert.deepEqual(f.session.files, []);
  assert.equal(await main(['send', '--session', 's-1', '--to', 'offline', '--text', 'hello'], options), 0);
  assert.equal(await main(['note', '--session', 's-1', '--title', 'Summary', '--text', 'text', '--tag', 'decision'], options), 0);
  assert.equal(await main(['inbox', '--session', 's-1', '--ack', 'm-new'], options), 0);
  assert.equal(await main(['done', '--session', 's-1', '--summary', 'Finished'], options), 0);
  assert.equal(await main(['snapshot', '--session', 's-1'], options), 0);
  assert.equal(await main(['notes', '--session', 's-1', '--search', 'a,b & text'], options), 0);
  assert.equal(f.calls.at(-1).url.searchParams.get('q'), 'a,b & text');
  assert.equal(await main(['projects'], options), 0);
  assert.equal(await main(['join', '--project', 'p1', '--agent', 'a', '--task', 'x', '--files', 'a,b'], options), 1);
  assert.match(stderr.text, /JSON array/);
  assert.equal(await main(['create', '--project', 'p2'], options), 1);
  assert.equal(await main(['watch', '--session', 's-1', '--base', 'http://localhost:9999'], options), 1);
  assert.match(stderr.text, /another base URL/);
});

test('CLI managed run returns child code and removes signal handlers without spawning a real process', async () => {
  const f = fixture();
  const processLike = new EventEmitter(), stdout = capture(), stderr = capture();
  const child = childMock();
  const result = main(['run', '--project', 'p1', '--agent', 'real', '--task', 'test', '--file', 'a.txt', '--', 'mock-editor', '--help'], {
    processLike, stdout, stderr, store: f.store, fetchImpl: f.fetchImpl, clock: f.clock, spawnImpl: () => child,
  });
  await flush();
  await f.clock.tick(360_000);
  assert.equal(f.session.status, 'working');
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 6);
  child.finish(3);
  assert.equal(await result, 3);
  assert.equal(stderr.text, '');
  assert.equal(stdout.text.includes('secret-token'), false);
  assert.equal(processLike.listenerCount('SIGINT'), 0);
  assert.equal(processLike.listenerCount('SIGTERM'), 0);
});

test('HTTP errors, malformed JSON and invalid base URLs fail predictably without tokens in errors', async () => {
  const client = new CoordinatorClient({ fetchImpl: async () => new Response('broken', { status: 500 }) });
  await assert.rejects(client.projects(), error => error instanceof ApiError && error.status === 500 && !error.message.includes('secret'));
  const invalid = new CoordinatorClient({ fetchImpl: async () => new Response('not json') });
  await assert.rejects(invalid.projects(), /Invalid JSON/);
  for (const url of ['file:///x', 'http://user:secret@localhost', 'http://localhost/?x=1', 'http://localhost/#x', 'https://localhost', 'http://remote.invalid', 'http://127.0.0.2', 'http://localhost/path', 'http://localhost.evil.invalid']) assert.throws(() => normalizeBaseUrl(url));
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8793/'), 'http://127.0.0.1:8793');
  assert.equal(normalizeBaseUrl('http://localhost'), 'http://localhost');
  assert.equal(normalizeBaseUrl('http://localhost:9999'), 'http://localhost:9999');
});

test('credential environment overrides use a data root plus clients, with a dedicated override', () => {
  const oldRoot = process.env.AGENT_COORD_DATA, oldClient = process.env.AGENT_COORD_CLIENT_DATA;
  try {
    delete process.env.AGENT_COORD_CLIENT_DATA;
    process.env.AGENT_COORD_DATA = join(tmpdir(), 'coordinator-data-root');
    assert.equal(new CredentialStore().directory, join(process.env.AGENT_COORD_DATA, 'clients'));
    process.env.AGENT_COORD_CLIENT_DATA = join(tmpdir(), 'private-client-dir');
    assert.equal(new CredentialStore().directory, process.env.AGENT_COORD_CLIENT_DATA);
  } finally {
    if (oldRoot === undefined) delete process.env.AGENT_COORD_DATA; else process.env.AGENT_COORD_DATA = oldRoot;
    if (oldClient === undefined) delete process.env.AGENT_COORD_CLIENT_DATA; else process.env.AGENT_COORD_CLIENT_DATA = oldClient;
  }
});

test('safe server errors include useful conflict detail but never bearer tokens or control characters', () => {
  const error = new ApiError(409, {
    error: 'Claim rejected for secret-token\nBearer another-secret\u001b',
    conflicts: [{ agentId: 'other', files: ['a.txt'], token: 'secret-token' }],
  }, 'PATCH', '/api/sessions/s-1', 'secret-token');
  assert.match(error.message, /Claim rejected/);
  assert.match(error.message, /other/);
  assert.match(error.message, /a.txt/);
  assert.equal(error.message.includes('secret-token'), false);
  assert.equal(error.message.includes('another-secret'), false);
  assert.equal(/[\x00-\x1f]/.test(error.message), false);
});

test('CLI waiting run sustains its heartbeat phase within idle policy, then cancel leaves without spawning', async () => {
  const f = fixture({ status: 'waiting', idleMs: 3_600_000 });
  const processLike = new EventEmitter(), stdout = capture(), stderr = capture();
  let launches = 0;
  const running = main(['run', '--project', 'p1', '--agent', 'real', '--task', 'wait', '--file', 'a.txt', '--', 'mock-editor'], {
    processLike, stdout, stderr, store: f.store, fetchImpl: f.fetchImpl, clock: f.clock,
    spawnImpl: () => { launches += 1; return childMock(); },
  });
  await flush();
  await f.clock.tick(600_000);
  assert.equal(launches, 0);
  assert.equal(f.session.status, 'waiting');
  assert.equal(f.session.lastActivity, 0);
  assert.equal(f.calls.filter(call => call.path.endsWith('/heartbeat')).length, 61);
  assert.ok(f.calls.filter(call => call.method === 'PATCH').every(call => Object.keys(call.body).length === 0));
  processLike.emit('SIGINT');
  processLike.emit('SIGINT');
  assert.equal(await running, 130);
  assert.equal(launches, 0);
  assert.equal(f.calls.at(-1).body.reason, 'idle');
  assert.equal(f.calls.filter(call => call.path.endsWith('/leave')).length, 1);
  assert.equal(stderr.text, '');
  assert.equal(f.pending.size, 0);
});

test('CLI watch continues long polling plus heartbeats until cancelled', async () => {
  const f = fixture(), processLike = new EventEmitter(), stdout = capture(), stderr = capture();
  await f.handle.persist();
  const watching = main(['watch', '--session', 's-1'], { processLike, stdout, stderr, store: f.store, fetchImpl: f.fetchImpl, clock: f.clock });
  await flush();
  await f.clock.tick(40_000);
  assert.equal(f.calls.filter(call => call.path.endsWith('/heartbeat')).length, 5);
  assert.equal(f.pending.size, 1);
  processLike.emit('SIGINT');
  assert.equal(await watching, 130);
  assert.equal(stderr.text, '');
  assert.equal(f.pending.size, 0);
  assert.equal(processLike.listenerCount('SIGINT'), 0);
});

test('run refuses a working declaration without actual write claims', async () => {
  const f = fixture();
  f.session.claimedFiles = [];
  let launches = 0;
  const result = await runSession(f.handle, 'editor', [], { clock: f.clock, spawnImpl: () => { launches += 1; return childMock(); } });
  assert.equal(launches, 0);
  assert.match(result.error.message, /claim was not confirmed/);
  assert.equal(f.calls.at(-1).body.reason, 'failed');
});

test('HTTP 409 with closed session is persisted, stops watch and does not reacquire', async () => {
  const f = fixture();
  const fetchImpl = async (url, options) => url.endsWith('/heartbeat')
    ? new Response(JSON.stringify({ error: 'Lease expired', session: { ...f.session, status: 'timed_out', claimedFiles: [] } }), { status: 409 })
    : f.fetchImpl(url, options);
  const handle = new SessionClient({ record: f.handle.record, store: f.store, client: new CoordinatorClient({ fetchImpl }) });
  const watcher = startWatching(handle, { clock: f.clock });
  await assert.rejects(watcher.ready, error => error.status === 409);
  const result = await watcher.done;
  assert.equal(result.session.status, 'timed_out');
  assert.equal(f.saved.at(-1).session.status, 'timed_out');
  assert.equal(f.calls.length, 0);
});

test('real in-process HTTP contract: claims, scoped board/search, broadcast and offline inbox', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-coordinator-http-test-'));
  const root = join(directory, 'synthetic-project');
  await mkdir(root);
  const coordinator = await new Coordinator(join(directory, 'state')).init();
  // Owner operations only set up synthetic fixtures; the CLI has no owner surface.
  const project = await coordinator.createProject({ name: 'Synthetic', root }, coordinator.ownerToken);
  const otherProject = await coordinator.createProject({ name: 'Other', root: directory }, coordinator.ownerToken);
  const server = createHttpServer(coordinator, directory);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const client = new CoordinatorClient({ baseUrl: `http://127.0.0.1:${server.address().port}` });
  const store = new CredentialStore(join(directory, 'clients'));
  assert.equal((await client.projects()).projects.length, 2);
  await assert.rejects(client.snapshot(project.id), error => error.status === 401);
  const writer = await registerSession(client, store, { projectId: project.id, agentId: 'writer.actual', task: 'Write API', files: ['a,b.txt', 'space file.txt'] });
  assert.deepEqual(writer.session.claimedFiles, ['a,b.txt', 'space file.txt']);
  const waiter = await registerSession(client, store, { projectId: project.id, agentId: 'waiter.actual', task: 'Review', files: ['a,b.txt'] });
  assert.equal(waiter.session.status, 'waiting');
  assert.deepEqual(waiter.session.claimedFiles, []);
  await waiter.update({ progress: 'Waiting for handoff' });
  assert.equal(waiter.session.status, 'waiting');
  await writer.note({ title: 'API interface', text: 'Conflict keeps prior claims', tags: ['design'] });
  assert.equal((await writer.notes('INTERFACE')).notes.length, 1);
  assert.equal((await writer.notes('not present')).notes.length, 0);
  await writer.send({ toAgentId: 'offline.actual', text: 'Read after reconnect', kind: 'schedule' });
  await writer.send({ toAgentId: '*', text: 'Broadcast', kind: 'message' });
  const reader = await registerSession(client, store, { projectId: project.id, agentId: 'reader.actual', task: 'Read', files: [] });
  reader.record.cursor = 0;
  const readerEvents = await reader.events({ wait: 0 });
  assert.equal(readerEvents.events.some(event => event.data?.toAgentId === 'offline.actual'), false);
  const inbox = await reader.inbox();
  assert.deepEqual(inbox.messages.map(message => message.text), ['Broadcast']);
  const unreadHeartbeat = await reader.heartbeat();
  assert.equal(unreadHeartbeat.inbox.unreadCount, 1);
  assert.equal(unreadHeartbeat.inbox.requiresCheck, true);
  assert.equal(unreadHeartbeat.inbox.messages[0].id, inbox.messages[0].id);
  const unreadUpdate = await reader.update({ progress: 'Inspecting the broadcast' });
  assert.equal(unreadUpdate.inbox.requiresCheck, true);
  assert.deepEqual(coordinator.state.messages.find(message => message.id === inbox.messages[0].id).deliveredTo, []);
  await reader.ack([inbox.messages[0].id]);
  assert.deepEqual((await reader.inbox()).messages, []);
  assert.equal((await reader.heartbeat()).inbox.unreadCount, 0);
  reader.record.cursor = coordinator.state.sequence;
  const messagePoll = reader.events({ wait: 1_000 });
  const sent = await writer.send({ toAgentId: 'reader.actual', text: 'Immediate long-poll delivery' });
  assert.ok((await messagePoll).events.some(event => event.type === 'message.sent' && event.data.id === sent.message.id));
  assert.equal((await reader.heartbeat()).inbox.messages[0].id, sent.message.id);
  await reader.ack([sent.message.id]);
  assert.equal((await reader.heartbeat()).inbox.requiresCheck, false);
  await assert.rejects(client.snapshot(otherProject.id, { token: reader.session.token }), error => error.status === 403);
  await reader.heartbeat('idle');
  assert.equal(reader.session.status, 'idle');
  assert.equal((await reader.notes('design')).notes.length, 1);
  assert.equal((await reader.snapshot()).project.id, project.id);
  assert.deepEqual((await reader.inbox()).messages, []);
  await assert.rejects(reader.ack([inbox.messages[0].id]), error => error.status === 409);
  const offline = await registerSession(client, store, { projectId: project.id, agentId: 'offline.actual', task: 'Read pending', files: [] });
  assert.deepEqual((await offline.inbox()).messages.map(message => message.text), ['Read after reconnect', 'Broadcast']);
  await offline.leave('completed');
  assert.equal((await offline.inbox()).messages.length, 2);
  const recovered = await store.list({ agentId: 'offline.actual', projectId: project.id });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].id, offline.session.id);
  assert.equal(recovered[0].status, 'completed');
  const recoveredInbox = capture(), recoveredError = capture();
  assert.equal(await main(['inbox', '--session', recovered[0].id], { store, stdout: recoveredInbox, stderr: recoveredError }), 0);
  assert.equal(JSON.parse(recoveredInbox.text).messages.length, 2);
  assert.equal(recoveredError.text, '');
  await writer.leave('completed', 'API ready for review');
  await waiter.update({ progress: 'Taking handoff' });
  assert.equal(waiter.session.status, 'working');
  assert.deepEqual(waiter.session.claimedFiles, ['a,b.txt']);
  const third = await registerSession(client, store, { projectId: project.id, agentId: 'third.actual', task: 'Other file', files: ['other.txt'] });
  await assert.rejects(third.update({ files: ['a,b.txt'] }), error => error.status === 409 && error.message.includes('waiter.actual'));
  assert.deepEqual(third.session.claimedFiles, ['other.txt']);
  assert.equal((await third.notes('API ready')).notes.length, 1);
  assert.deepEqual(await readdir(root), []);
  await waiter.leave('completed');
  await third.leave('completed');
});

test('read-only run is valid; short idle policies shorten progress interval without fake work after exit', async () => {
  const f = fixture({ files: [], idleMs: 30_000 });
  const child = childMock();
  const running = runSession(f.handle, 'reader', [], { clock: f.clock, spawnImpl: () => child });
  await flush();
  await f.clock.tick(120_000);
  assert.equal(f.session.status, 'working');
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 12);
  child.finish(0);
  assert.equal((await running).exitCode, 0);
  const count = f.calls.length;
  await f.clock.tick(120_000);
  assert.equal(f.calls.length, count);
});

test('expired run exits with failure rather than an interrupt and never starts work', async () => {
  const f = fixture({ status: 'timed_out' });
  let launches = 0;
  const result = await runSession(f.handle, 'editor', [], { clock: f.clock, spawnImpl: () => { launches += 1; return childMock(); } });
  assert.equal(launches, 0);
  assert.equal(result.exitCode, 1);
  assert.equal(f.calls.length, 0);
});

test('requests disallow redirects and remote stored endpoints before any credential transport', async () => {
  let requests = 0;
  const client = new CoordinatorClient({ baseUrl: 'http://localhost:12345', fetchImpl: async (_url, options) => {
    requests += 1;
    assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify({ projects: [] }));
  } });
  await client.projects();
  const f = fixture();
  assert.throws(() => new SessionClient({ record: { ...f.handle.record, baseUrl: 'http://remote.invalid' }, client }), /base URL must be/);
  assert.equal(requests, 1);
});

test('a stale long-poll snapshot cannot roll back a newer claim update', async () => {
  const f = fixture();
  const stale = structuredClone(f.session);
  let resolveEvents;
  const fetchImpl = async (url, options) => url.includes('/events?')
    ? new Promise(resolve => { resolveEvents = () => resolve(new Response(JSON.stringify({ session: stale, cursor: 10, events: [] }))); })
    : f.fetchImpl(url, options);
  const h = new SessionClient({ record: f.handle.record, store: f.store, client: new CoordinatorClient({ fetchImpl }) });
  const poll = h.events();
  await flush();
  await h.update({ files: ['new.txt'] });
  resolveEvents();
  await poll;
  assert.deepEqual(h.session.claimedFiles, ['new.txt']);
  assert.equal(h.cursor, 10);
});

test('asynchronous child spawn errors stop the listener and leave failed once', async () => {
  const f = fixture();
  const child = childMock();
  const running = runSession(f.handle, 'missing', [], { clock: f.clock, spawnImpl: () => child });
  await flush();
  child.emit('error', new Error('Async ENOENT fixture'));
  const result = await running;
  assert.equal(result.exitCode, 1);
  assert.match(result.error.message, /Async ENOENT/);
  assert.equal(f.calls.filter(call => call.path.endsWith('/leave')).length, 1);
  assert.equal(f.calls.at(-1).body.reason, 'failed');
  assert.equal(f.pending.size, 0);
});

test('automatic waiting retries do not postpone idle expiry or start a waiting run child', async () => {
  const f = fixture({ status: 'waiting', idleMs: 30_000 });
  let launches = 0;
  const running = runSession(f.handle, 'editor', [], { clock: f.clock, spawnImpl: () => { launches += 1; return childMock(); } });
  await flush();
  await f.clock.tick(30_000);
  const result = await running;
  assert.equal(launches, 0);
  assert.equal(result.session.lastActivity, 0);
  assert.equal(result.session.status, 'closed');
  assert.equal(result.exitCode, 1);
  assert.equal(f.pending.size, 0);
  assert.ok(f.calls.filter(call => call.method === 'PATCH').every(call => Object.keys(call.body).length === 0));
});

test('CredentialStore session listing requires an exact agent, filters projects and returns token-free metadata including closed sessions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-coordinator-list-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new CredentialStore(directory);
  const f = fixture();
  const agentId = 'agent-00000000-0000-4000-8000-000000000001';
  const records = [
    { id: 'own-active', agentId, projectId: 'p1', status: 'working', token: 'active-secret' },
    { id: 'own-closed', agentId, projectId: 'p1', status: 'completed', token: 'closed-secret' },
    { id: 'own-other-project', agentId, projectId: 'p2', status: 'waiting', token: 'other-project-secret' },
    { id: 'peer', agentId: 'peer.actual', projectId: 'p1', status: 'working', token: 'peer-secret' },
    { id: 'near-match', agentId: `${agentId}-different`, projectId: 'p1', status: 'working', token: 'near-match-secret' },
  ];
  for (const session of records) await store.save({
    ...f.handle.record, privateMetadata: { token: 'private-secret' },
    session: { ...f.handle.session, ...session, task: 'Recover session', files: ['a,b.txt', 'space file.txt'] },
  });
  await assert.rejects(store.list(), /agentId/);
  await assert.rejects(store.list({ projectId: 'p1' }), /agentId/);
  await assert.rejects(store.list({ agentId: ' ' }), /agentId/);
  await assert.rejects(store.list({ agentId, projectId: '' }), /projectId/);
  const allOwn = await store.list({ agentId });
  assert.deepEqual(allOwn.map(session => session.id), ['own-active', 'own-closed', 'own-other-project']);
  const projectOwn = await store.list({ agentId, projectId: 'p1' });
  assert.deepEqual(projectOwn.map(session => session.status), ['working', 'completed']);
  assert.deepEqual(projectOwn[0], {
    id: 'own-active', agentId, projectId: 'p1', status: 'working',
    baseUrl: 'http://127.0.0.1:8793', task: 'Recover session', files: ['a,b.txt', 'space file.txt'],
  });
  assert.equal(JSON.stringify(allOwn).includes('secret'), false);
  assert.equal(JSON.stringify(allOwn).includes('token'), false);
  assert.deepEqual(await store.list({ agentId: 'missing' }), []);
  assert.deepEqual(await store.list({ agentId: '*' }), []);
  assert.deepEqual(await store.list({ agentId, projectId: 'missing-project' }), []);
});

test('session listing is read-only, handles a missing directory, and skips corrupt, mismatched and non-credential entries without secret output', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-coordinator-list-invalid-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const absent = new CredentialStore(join(directory, 'missing'));
  assert.deepEqual(await absent.list({ agentId: 'agent-real' }), []);
  await assert.rejects(readdir(absent.directory), error => error.code === 'ENOENT');
  const store = new CredentialStore(directory);
  const f = fixture();
  await store.save(f.handle.record);
  const before = await readFile(store.path('s-1'), 'utf8');
  await writeFile(join(directory, 'corrupt.json'), '{"token":"corrupt-secret",');
  await writeFile(join(directory, 'wrong-name.json'), JSON.stringify(f.handle.record));
  await writeFile(join(directory, 'owner.json'), JSON.stringify({ token: 'owner-secret' }));
  await writeFile(join(directory, 's-2.json.tmp'), JSON.stringify(f.handle.record));
  await mkdir(join(directory, 'directory.json'));
  const remote = { ...f.handle.record, baseUrl: 'http://remote.invalid', session: { ...f.session, id: 'remote' } };
  await writeFile(join(directory, 'remote.json'), JSON.stringify(remote));
  const entries = await readdir(directory);
  const stdout = capture(), stderr = capture();
  assert.equal(await main(['sessions', '--agent', 'agent-real'], {
    store, stdout, stderr, fetchImpl: () => { throw new Error('Local session listing must not call the server'); },
  }), 0);
  const result = JSON.parse(stdout.text);
  assert.equal(result.source, 'local');
  assert.equal(result.statusSource, 'stored');
  assert.deepEqual(result.sessions.map(session => session.id), ['s-1']);
  assert.equal(stdout.text.includes('secret'), false);
  assert.equal(stdout.text.includes('token'), false);
  assert.equal(stderr.text, '');
  assert.equal(await readFile(store.path('s-1'), 'utf8'), before);
  assert.deepEqual(await readdir(directory), entries);
});

test('CLI sessions rejects unfiltered reads before store access or network calls', async () => {
  const queries = [], stdout = capture(), stderr = capture();
  const options = {
    stdout, stderr,
    store: { list: async filters => { queries.push(filters); return []; } },
    fetchImpl: () => { throw new Error('sessions must not call any endpoint, including bootstrap'); },
  };
  assert.equal(await main(['sessions'], options), 1);
  assert.equal(await main(['sessions', '--project', 'p1'], options), 1);
  assert.deepEqual(queries, []);
  assert.match(stderr.text, /--agent is required/);
  assert.equal(await main(['sessions', '--agent', 'agent.actual', '--project', 'p1'], options), 0);
  assert.deepEqual(queries, [{ agentId: 'agent.actual', projectId: 'p1' }]);
  assert.equal(await main(['sessions', '--agent', 'agent.actual', '--base', 'http://localhost:8793'], options), 1);
  assert.equal(queries.length, 1);
});

test('background join-watch SID is recoverable from local sessions and usable for inbox and done without bootstrap', { timeout: 5_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-coordinator-recover-test-'));
  const processLike = new EventEmitter();
  let watching;
  t.after(async () => {
    processLike.emit('SIGINT');
    await watching;
    await rm(directory, { recursive: true, force: true });
  });
  const store = new CredentialStore(directory);
  const f = fixture(), stderr = capture();
  const agentId = 'agent-00000000-0000-4000-8000-000000000001';
  let registrationPrinted, monitorPrinted, writes = 0;
  const printed = new Promise(resolve => { registrationPrinted = resolve; });
  const monitorReady = new Promise(resolve => { monitorPrinted = resolve; });
  watching = main(['join', '--project', 'p1', '--agent', agentId, '--task', 'Background task', '--file', 'a,b.txt', '--watch'], {
    store, processLike, stderr, stdout: { write: () => {
      if (++writes === 1) registrationPrinted();
      else monitorPrinted();
    } }, fetchImpl: f.fetchImpl, clock: f.clock,
  });
  await printed;
  await flush();
  const stdout = capture();
  assert.equal(await main(['sessions', '--agent', agentId, '--project', 'p1'], {
    store, stdout, stderr, fetchImpl: () => { throw new Error('Recovery cannot call bootstrap or other endpoints'); },
  }), 0);
  const recovered = JSON.parse(stdout.text).sessions;
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].id, 's-1');
  assert.equal(stdout.text.includes('secret-token'), false);
  await monitorReady;
  await flush();
  const commands = { store, stdout: capture(), stderr, fetchImpl: f.fetchImpl };
  assert.equal(await main(['inbox', '--session', recovered[0].id], commands), 0);
  assert.equal(await main(['done', '--session', recovered[0].id, '--summary', 'Background work done'], commands), 0);
  await f.clock.tick(10_000);
  assert.equal(await watching, 0, stderr.text);
  assert.equal(f.calls.some(call => call.path.includes('bootstrap')), false);
  assert.equal(f.session.reason, 'completed');
  assert.equal(f.pending.size, 0);
  assert.equal(stderr.text, '');
  assert.equal((await store.list({ agentId }))[0].status, 'closed');
});

test('heartbeat and update cache the latest agent-scoped unread summary without persisting it or acknowledging', async () => {
  const f = fixture();
  f.state.messages = [
    ...Array.from({ length: 22 }, (_, index) => pendingMessage(`m-${index}`)),
    pendingMessage('peer', { toAgentId: 'someone-else' }),
    pendingMessage('other-project', { projectId: 'p2' }),
    pendingMessage('already-acked', { deliveredTo: ['agent-real'] }),
  ];
  assert.equal(f.handle.latestInbox, null);
  await f.clock.tick(10_000);
  const heartbeat = await f.handle.heartbeat();
  assert.equal(heartbeat.inbox.unreadCount, 22);
  assert.equal(heartbeat.inbox.requiresCheck, true);
  assert.equal(heartbeat.inbox.hasMore, true);
  assert.equal(heartbeat.inbox.messages.length, 20);
  assert.deepEqual(f.handle.latestInbox, heartbeat.inbox);
  heartbeat.inbox.messages[0].text = 'Mutated by caller';
  assert.equal(f.handle.latestInbox.messages[0].text, 'Message m-0');
  assert.equal(f.session.lastActivity, 0);
  const update = await f.handle.update({ progress: 'Checking the requested work' });
  assert.equal(update.inbox.requiresCheck, true);
  assert.equal(f.handle.latestInbox.unreadCount, 22);
  assert.equal(f.session.lastActivity, 10_000);
  assert.equal(Object.hasOwn(f.handle.record, 'latestInbox'), false);
  assert.equal(Object.hasOwn(f.saved.at(-1), 'inbox'), false);
  assert.equal(f.calls.some(call => call.path.endsWith('/ack')), false);
  await f.handle.ack(Array.from({ length: 22 }, (_, index) => `m-${index}`));
  await f.handle.heartbeat();
  assert.deepEqual(f.handle.latestInbox, { unreadCount: 0, requiresCheck: false, messages: [], hasMore: false });
});

test('default heartbeat state is computed after earlier queued claim acquisition', async () => {
  const f = fixture({ status: 'waiting' });
  f.state.busy = false;
  const update = f.handle.update({ progress: 'Ready to acquire' });
  const heartbeat = f.handle.heartbeat();
  await update;
  await heartbeat;
  assert.equal(f.handle.session.status, 'working');
  assert.deepEqual(f.calls.at(-1).body, { state: 'working' });
});

test('watch reminds unread inbox initially and each 60 seconds, not every heartbeat, without touching claims or cursor', async t => {
  const f = fixture(), seen = [];
  f.state.messages = [pendingMessage('m1')];
  const watcher = startWatching(f.handle, { clock: f.clock, onEvent: event => seen.push(event) });
  t.after(() => watcher.stop('cancelled'));
  await watcher.ready;
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'inbox.reminder');
  assert.equal(seen[0].synthetic, true);
  assert.equal(seen[0].projectId, 'p1');
  assert.deepEqual(seen[0].data, {
    sessionId: 's-1', agentId: 'agent-real', unreadCount: 1, requiresCheck: true,
    messageIds: ['m1'], messages: [pendingMessage('m1')], hasMore: false,
  });
  await f.clock.tick(50_000);
  assert.equal(seen.length, 1);
  await f.clock.tick(10_000);
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0].id, seen[1].id);
  assert.equal(seen[1].at, '1970-01-01T00:01:00.000Z');
  await f.clock.tick(10_000);
  assert.equal(seen.length, 2);
  assert.equal(f.calls.filter(call => call.path.endsWith('/heartbeat')).length, 8);
  assert.equal(f.calls.some(call => call.method === 'PATCH' || call.path.endsWith('/ack') || call.path.endsWith('/leave')), false);
  assert.equal(f.handle.cursor, 0);
  assert.equal(f.saved.at(-1).cursor, 0);
  assert.equal(f.session.lastActivity, 0);
  assert.equal(f.session.leaseUpdatedAt, 70_000);
  assert.equal(f.handle.active, true);
  assert.deepEqual(f.state.messages[0].deliveredTo, []);
});

test('changed message IDs remind immediately, reordered IDs do not spam, and explicit ack resets reminders', async t => {
  const f = fixture(), seen = [];
  f.state.messages = [pendingMessage('a'), pendingMessage('b')];
  const watcher = startWatching(f.handle, { clock: f.clock, onEvent: event => seen.push(event) });
  t.after(() => watcher.stop('cancelled'));
  await watcher.ready;
  f.state.messages.reverse();
  await f.clock.tick(10_000);
  assert.equal(seen.length, 1);
  f.state.messages.push(pendingMessage('c'));
  await f.clock.tick(10_000);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1].data.messageIds, ['a', 'b', 'c']);
  await f.handle.ack(['a']);
  await f.clock.tick(10_000);
  assert.equal(seen.length, 3);
  assert.deepEqual(seen[2].data.messageIds, ['b', 'c']);
  await f.handle.ack(['b', 'c']);
  await f.clock.tick(10_000);
  assert.equal(seen.length, 3);
  assert.equal(f.handle.latestInbox.requiresCheck, false);
  f.state.messages = [pendingMessage('b'), pendingMessage('c')];
  await f.clock.tick(10_000);
  assert.equal(seen.length, 4);
  assert.equal(seen[3].data.requiresCheck, true);
  assert.equal(f.calls.filter(call => call.path.endsWith('/ack')).length, 2);
  assert.equal(f.handle.active, true);
});

test('count changes beyond the 20-message preview trigger a fresh reminder with hasMore', async t => {
  const f = fixture(), seen = [];
  f.state.messages = Array.from({ length: 21 }, (_, index) => pendingMessage(`m-${index}`));
  const watcher = startWatching(f.handle, { clock: f.clock, onEvent: event => seen.push(event) });
  t.after(() => watcher.stop('cancelled'));
  await watcher.ready;
  assert.equal(seen[0].data.unreadCount, 21);
  assert.equal(seen[0].data.messages.length, 20);
  assert.equal(seen[0].data.hasMore, true);
  f.state.messages.push(pendingMessage('m-21'));
  await f.clock.tick(10_000);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].data.unreadCount, 22);
  assert.deepEqual(seen[1].data.messageIds, seen[0].data.messageIds);
  assert.equal(f.calls.some(call => call.path.endsWith('/ack')), false);
});

test('message.sent long poll is delivered immediately; heartbeat reminder neither delays it nor auto-acks', async t => {
  const f = fixture(), seen = [];
  const watcher = startWatching(f.handle, { clock: f.clock, onEvent: event => seen.push({ event, at: f.clock.now() }) });
  t.after(() => watcher.stop('cancelled'));
  await watcher.ready;
  await flush();
  const message = pendingMessage('new-message');
  f.state.messages.push(message);
  f.deliver([{ id: 17, type: 'message.sent', at: message.createdAt, projectId: 'p1', data: message }]);
  await flush();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].event.type, 'message.sent');
  assert.equal(seen[0].at, 0);
  assert.equal(f.handle.cursor, 1);
  await f.clock.tick(10_000);
  assert.deepEqual(seen.map(item => item.event.type), ['message.sent', 'inbox.reminder']);
  assert.equal(f.handle.cursor, 1);
  assert.deepEqual(message.deliveredTo, []);
  assert.equal(f.calls.some(call => call.path.endsWith('/ack')), false);
  await f.handle.ack(['new-message']);
  await f.clock.tick(10_000);
  assert.equal(seen.length, 2);
  assert.equal(f.handle.latestInbox.unreadCount, 0);
  assert.equal(f.session.lastActivity, 0);
});

test('unread inbox does not renew waiting activity, block acquired run work, stop the child or release claims', async () => {
  const f = fixture({ status: 'waiting' }), child = childMock(), seen = [];
  f.state.messages = [pendingMessage('needs-explicit-check')];
  let launches = 0;
  const running = runSession(f.handle, 'mock-editor', [], {
    clock: f.clock, onEvent: event => seen.push(event), spawnImpl: () => { launches += 1; return child; },
  });
  await flush();
  await f.clock.tick(60_000);
  assert.equal(launches, 0);
  assert.equal(f.session.lastActivity, 0);
  assert.equal(f.session.status, 'waiting');
  assert.ok(f.calls.filter(call => call.method === 'PATCH').every(call => Object.keys(call.body).length === 0));
  assert.equal(seen.filter(event => event.type === 'inbox.reminder').length, 2);
  f.state.busy = false;
  await f.clock.tick(10_000);
  assert.equal(launches, 1);
  await f.clock.tick(120_000);
  assert.equal(f.session.status, 'working');
  assert.equal(f.handle.latestInbox.requiresCheck, true);
  assert.equal(f.calls.some(call => call.path.endsWith('/ack') || call.path.endsWith('/leave')), false);
  assert.deepEqual(child.kills, []);
  child.finish(0);
  const result = await running;
  assert.equal(result.error, undefined);
  assert.equal(result.exitCode, 0);
  assert.equal(result.reason, 'completed');
  assert.equal(f.calls.filter(call => call.path.endsWith('/leave')).length, 1);
});

test('CLI one-shot heartbeat and update print full optional inbox summaries without auto-ack or unread failure', async () => {
  const f = fixture(), stderr = capture();
  f.state.messages = [pendingMessage('ask-for-review')];
  await f.handle.persist();
  const heartbeatOut = capture();
  assert.equal(await main(['heartbeat', '--session', 's-1'], {
    store: f.store, fetchImpl: f.fetchImpl, stdout: heartbeatOut, stderr,
  }), 0);
  const heartbeat = JSON.parse(heartbeatOut.text);
  assert.equal(heartbeat.inbox.requiresCheck, true);
  assert.equal(heartbeat.inbox.messages[0].text, 'Message ask-for-review');
  assert.deepEqual(f.calls.at(-1).body, { state: 'working' });
  assert.equal(heartbeatOut.text.includes('secret-token'), false);
  const updateOut = capture();
  assert.equal(await main(['update', '--session', 's-1', '--progress', 'Review in progress'], {
    store: f.store, fetchImpl: f.fetchImpl, stdout: updateOut, stderr,
  }), 0);
  assert.equal(JSON.parse(updateOut.text).inbox.unreadCount, 1);
  assert.equal(JSON.parse(updateOut.text).inbox.messages[0].id, 'ask-for-review');
  assert.equal(f.calls.some(call => call.path.endsWith('/ack') || call.path.endsWith('/leave')), false);
  const calls = f.calls.length;
  assert.equal(await main(['heartbeat', '--session', 's-1', '--state', 'invalid'], {
    store: f.store, fetchImpl: f.fetchImpl, stdout: capture(), stderr,
  }), 1);
  assert.equal(f.calls.length, calls);
  const idleOut = capture();
  assert.equal(await main(['heartbeat', '--session', 's-1', '--state', 'idle'], {
    store: f.store, fetchImpl: f.fetchImpl, stdout: idleOut, stderr: capture(),
  }), 0);
  assert.equal(JSON.parse(idleOut.text).session.status, 'closed');
  assert.equal(JSON.parse(idleOut.text).inbox.requiresCheck, true);
  assert.equal(f.calls.some(call => call.path.endsWith('/ack')), false);
  assert.equal(parseArgs(['heartbeat', '--session', 's-1', '--state', 'waiting']).options.state, 'waiting');
});

test('legacy heartbeat/update responses check existing inbox and surface unread without restarting the server', async t => {
  const f = fixture({ withInbox: false }), seen = [];
  f.state.messages = [pendingMessage('legacy-unread')];
  const heartbeat = await f.handle.heartbeat();
  assert.equal(heartbeat.inbox.source, 'fallback');
  assert.equal(heartbeat.inbox.unreadCount, 1);
  const update = await f.handle.update({ progress: 'Working with older server' });
  assert.equal(update.inbox.requiresCheck, true);
  assert.equal(f.handle.latestInbox.messages[0].text, 'Message legacy-unread');
  assert.equal(f.calls.filter(call => call.path.endsWith('/inbox')).length, 2);
  const watcher = startWatching(f.handle, { clock: f.clock, onEvent: event => seen.push(event) });
  t.after(() => watcher.stop('cancelled'));
  await watcher.ready;
  await f.clock.tick(60_000);
  assert.equal(seen.length, 2);
  assert.ok(seen.every(event => event.type === 'inbox.reminder' && event.data.requiresCheck));
  assert.equal(f.handle.active, true);
  assert.equal(f.calls.some(call => call.path.endsWith('/ack')), false);
});

test('new server piggyback summary never performs a redundant inbox GET', async () => {
  const f = fixture();
  f.state.messages = [pendingMessage('piggyback')];
  await f.handle.heartbeat();
  await f.handle.update({ progress: 'Processing the new API' });
  assert.equal(f.calls.filter(call => call.path.endsWith('/inbox')).length, 0);
  assert.equal(f.handle.latestInbox.unreadCount, 1);
  assert.equal(f.handle.latestInbox.messages[0].id, 'piggyback');
});

test('legacy fallback counts only this agent unacked inbox, caps preview at 20 and preserves cursor', async () => {
  const f = fixture({ withInbox: false });
  f.state.messages = [
    ...Array.from({ length: 22 }, (_, index) => pendingMessage(`m-${index}`)),
    pendingMessage('already-acked', { deliveredTo: ['agent-real'] }),
    pendingMessage('peer', { toAgentId: 'peer.actual' }),
    pendingMessage('sent-by-self', { fromAgentId: 'agent-real', toAgentId: 'peer.actual' }),
    pendingMessage('other-project', { projectId: 'p2' }),
  ];
  const heartbeat = await f.handle.heartbeat();
  assert.equal(heartbeat.inbox.unreadCount, 22);
  assert.equal(heartbeat.inbox.messages.length, 20);
  assert.equal(heartbeat.inbox.hasMore, true);
  assert.equal(heartbeat.session.status, 'working');
  assert.deepEqual(heartbeat.session.claimedFiles, ['a.txt']);
  assert.equal(f.handle.cursor, 0);
  assert.equal(f.session.lastActivity, 0);
  assert.equal(f.calls.at(-1).headers.Authorization, 'Bearer secret-token');
  assert.equal(f.calls.some(call => call.path.endsWith('/ack')), false);
  await f.handle.ack(Array.from({ length: 22 }, (_, index) => `m-${index}`));
  const empty = await f.handle.heartbeat();
  assert.equal(empty.inbox.unreadCount, 0);
  assert.equal(empty.inbox.requiresCheck, false);
  assert.equal(f.handle.active, true);
});

test('legacy inbox check failure reports unknown unread with a safe error while preserving a valid lease and run work', async () => {
  const f = fixture({ withInbox: false }), child = childMock(), seen = [];
  const fetchImpl = async (url, options) => url.endsWith('/inbox')
    ? new Response(JSON.stringify({ error: 'Inbox unavailable secret-token\nBearer hidden-secret' }), { status: 503 })
    : f.fetchImpl(url, options);
  const handle = new SessionClient({ record: f.handle.record, store: f.store, client: new CoordinatorClient({ fetchImpl }) });
  const heartbeat = await handle.heartbeat();
  assert.equal(heartbeat.session.status, 'working');
  assert.equal(heartbeat.inbox.unreadCount, null);
  assert.equal(heartbeat.inbox.hasMore, null);
  assert.equal(heartbeat.inbox.requiresCheck, true);
  assert.equal(heartbeat.inbox.checkFailed, true);
  assert.match(heartbeat.inbox.error, /HTTP 503/);
  assert.equal(heartbeat.inbox.error.includes('secret-token'), false);
  assert.equal(heartbeat.inbox.error.includes('hidden-secret'), false);
  const running = runSession(handle, 'mock-editor', [], { clock: f.clock, spawnImpl: () => child, onEvent: event => seen.push(event) });
  await flush();
  await f.clock.tick(120_000);
  assert.equal(f.session.status, 'working');
  assert.equal(f.session.leaseUpdatedAt, 120_000);
  assert.deepEqual(child.kills, []);
  assert.equal(f.calls.some(call => call.path.endsWith('/leave') || call.path.endsWith('/ack')), false);
  assert.equal(seen.length, 3);
  assert.ok(seen.every(event => event.data.requiresCheck && event.data.checkFailed && event.data.unreadCount === null));
  child.finish(0);
  const result = await running;
  assert.equal(result.exitCode, 0);
  assert.equal(result.error, undefined);
});

test('failed heartbeat or conflicting update never attempts fallback or hides the original failure and old claims', async () => {
  const f = fixture({ withInbox: false });
  f.state.busy = true;
  await assert.rejects(f.handle.update({ files: ['busy.txt'] }), error => error.status === 409 && error.body.error === 'conflict');
  assert.deepEqual(f.handle.session.claimedFiles, ['a.txt']);
  assert.equal(f.calls.some(call => call.path.endsWith('/inbox')), false);
  f.state.heartbeatError = true;
  await assert.rejects(f.handle.heartbeat(), error => error.status === 409);
  assert.equal(f.calls.some(call => call.path.endsWith('/inbox')), false);
});

test('one-shot progress/heartbeat with old running server output unread fallback or explicit check error without requiring deploy', async () => {
  const f = fixture({ withInbox: false }), stderr = capture();
  f.state.messages = [pendingMessage('human-instruction', { text: 'Read this before proceeding' })];
  await f.handle.persist();
  const updateOut = capture();
  assert.equal(await main(['update', '--session', 's-1', '--progress', 'Reporting actual progress'], {
    store: f.store, fetchImpl: f.fetchImpl, stdout: updateOut, stderr,
  }), 0);
  const update = JSON.parse(updateOut.text);
  assert.equal(update.inbox.requiresCheck, true);
  assert.equal(update.inbox.source, 'fallback');
  assert.equal(update.inbox.messages[0].text, 'Read this before proceeding');
  assert.equal(f.calls.filter(call => call.path.endsWith('/inbox')).length, 1);
  const heartbeatOut = capture();
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/inbox')) throw new Error('Connection failed');
    return f.fetchImpl(url, options);
  };
  assert.equal(await main(['heartbeat', '--session', 's-1'], {
    store: f.store, fetchImpl, stdout: heartbeatOut, stderr,
  }), 0);
  const heartbeat = JSON.parse(heartbeatOut.text);
  assert.equal(heartbeat.session.status, 'working');
  assert.equal(heartbeat.inbox.checkFailed, true);
  assert.equal(heartbeat.inbox.unreadCount, null);
  assert.equal(heartbeat.inbox.requiresCheck, true);
  assert.equal(heartbeat.inbox.error, 'Connection failed');
  assert.equal(stderr.text, '');
  assert.equal(f.calls.some(call => call.path.endsWith('/ack') || call.path.endsWith('/leave')), false);
});

test('malformed legacy inbox data is an explicit check failure, not zero unread or a lost heartbeat lease', async () => {
  const f = fixture({ withInbox: false });
  const fetchImpl = async (url, options) => url.endsWith('/inbox')
    ? new Response(JSON.stringify({ messages: null })) : f.fetchImpl(url, options);
  const handle = new SessionClient({ record: f.handle.record, store: f.store, client: new CoordinatorClient({ fetchImpl }) });
  const result = await handle.heartbeat();
  assert.equal(handle.active, true);
  assert.equal(result.inbox.checkFailed, true);
  assert.equal(result.inbox.unreadCount, null);
  assert.equal(result.inbox.requiresCheck, true);
  assert.match(result.inbox.error, /Invalid inbox response/);
  assert.equal(f.calls.some(call => call.path.endsWith('/leave')), false);
});

test('a delayed legacy inbox fallback cannot reopen a session already reported closed by events', async () => {
  const f = fixture({ withInbox: false });
  let resolveInbox;
  const fetchImpl = async (url, options) => url.endsWith('/inbox')
    ? new Promise(resolve => { resolveInbox = () => resolve(new Response(JSON.stringify({ messages: [], cursor: 999 }))); })
    : f.fetchImpl(url, options);
  const handle = new SessionClient({ record: f.handle.record, store: f.store, client: new CoordinatorClient({ fetchImpl }) });
  const heartbeat = handle.heartbeat();
  await flush();
  f.session.status = 'timed_out';
  f.session.claimedFiles = [];
  f.deliver([{ id: 1, type: 'agent.left', at: 'now', projectId: 'p1', data: f.session }]);
  await handle.events({ wait: 0 });
  assert.equal(handle.active, false);
  resolveInbox();
  await heartbeat;
  assert.equal(handle.session.status, 'timed_out');
  assert.deepEqual(handle.session.claimedFiles, []);
  assert.equal(handle.cursor, 1);
});
