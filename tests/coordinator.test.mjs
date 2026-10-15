import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, readFile, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Coordinator, normalizeFiles, filesOverlap} from '../lib/coordinator.mjs';
import {createHttpServer} from '../lib/http-server.mjs';
import {installProjectPolicy} from '../lib/policy.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-coordinator-'));let now = 1000000;
  t.after(() => rm(directory, {recursive: true,force: true}));const root = path.join(directory, 'project');await mkdir(root);await mkdir(path.join(root, 'public'));
  const coordinator = await new Coordinator(path.join(directory, 'state'), {now: () => now}).init();
  const project = await coordinator.createProject({name: 'Test project',root}, coordinator.ownerToken);
  const join = (agentId, files = ['public/app.js']) => coordinator.join({projectId: project.id,agentId,task: 'Implement feature',files});
  return {coordinator,project,root,directory,join,advance: ms => now += ms};
}
test('projects require owner credentials and file declarations stay inside the root', async t => {
  const f = await fixture(t);await assert.rejects(f.coordinator.createProject({name: 'Other',root: f.root}, 'agent'), {status: 403});
  await assert.rejects(normalizeFiles(f.root, ['../outside.js']));await assert.rejects(normalizeFiles(f.root, [path.join(f.directory, 'outside.js')]));
  assert.deepEqual(await normalizeFiles(f.root, ['public/app.js', 'public/app.js']), ['public/app.js']);
  assert.equal(filesOverlap('public/**', 'public/app.js'), true);assert.equal(filesOverlap('public/**', 'publication/app.js'), false);
});
test('concurrent registrations cannot both acquire overlapping files; waiting agents can retry after release', async t => {
  const f = await fixture(t),registrations = await Promise.all([f.join('agent-a'),f.join('agent-b')]);
  assert.deepEqual(registrations.map(r => r.session.status).sort(), ['waiting', 'working']);
  const owner = registrations.find(r => r.session.status === 'working').session,waiting = registrations.find(r => r.session.status === 'waiting').session;
  await f.coordinator.leave(owner.id, {reason: 'completed',summary: 'Shared schema now uses v2.'}, owner.token);
  const claimed = await f.coordinator.update(waiting.id, {progress: 'Taking over after handoff'}, waiting.token);
  assert.equal(claimed.session.status, 'working');assert.deepEqual(claimed.session.claimedFiles, ['public/app.js']);assert.equal(f.coordinator.snapshot(f.project.id).notes.length, 1);
});
test('failed scope expansion preserves existing claims', async t => {
  const f = await fixture(t),a = (await f.join('a', ['public/a.js'])).session,b = (await f.join('b', ['public/b.js'])).session;
  await assert.rejects(f.coordinator.update(a.id, {files: ['public/a.js', 'public/b.js']}, a.token), {status: 409});assert.deepEqual(f.coordinator.session(a.id).claimedFiles, ['public/a.js']);
  await assert.rejects(f.coordinator.heartbeat(b.id, {}, a.token), {status: 403});
});
test('automatic waiting retries do not count as progress or flood the event history', async t => {
  const f = await fixture(t);await f.join('owner');const waiting = (await f.join('waiting')).session,activity = waiting.lastActivityAt,cursor = f.coordinator.state.sequence;
  f.advance(10000);await f.coordinator.heartbeat(waiting.id, {state: 'waiting'}, waiting.token);await f.coordinator.update(waiting.id, {}, waiting.token);
  assert.equal(f.coordinator.session(waiting.id).lastActivityAt, activity);assert.equal(f.coordinator.state.sequence, cursor);
});
test('lease expiry and idle expiry release claims; heartbeat does not pretend to be task progress', async t => {
  const f = await fixture(t),a = (await f.join('a')).session;f.advance(45000);await f.coordinator.sweep();assert.equal(f.coordinator.session(a.id).status, 'timed_out');
  const b = (await f.join('b')).session;for (let i = 0; i < 10; i++) {f.advance(30000);try {await f.coordinator.heartbeat(b.id, {}, b.token);} catch (error) {assert.equal(error.status, 409);}}
  assert.equal(f.coordinator.session(b.id).status, 'idle');assert.deepEqual(f.coordinator.session(b.id).claimedFiles, []);
});
test('offline messages, acknowledgments and handoff notes survive server restart', async t => {
  const f = await fixture(t),a = (await f.join('a', [])).session;
  const message = (await f.coordinator.sendMessage({projectId: f.project.id,toAgentId: 'offline-agent',text: 'Use the new decoder.',kind: 'schedule'}, a.token)).message;
  await f.coordinator.postNote(f.project.id, {title: 'Decoder contract',text: 'Input DN is unchanged.',tags: ['raw']}, a.token);
  await f.coordinator.leave(a.id, {reason: 'completed',summary: 'Finished decoder task.'}, a.token);
  const next = await new Coordinator(path.join(f.directory, 'state')).init(),agent = (await next.join({projectId: f.project.id,agentId: 'offline-agent',task: 'Read handoff',files: []})).session;
  assert.equal(next.inbox(agent.id, agent.token).messages[0].id, message.id);await next.acknowledge(agent.id, {messageIds: [message.id]}, agent.token);assert.equal(next.inbox(agent.id, agent.token).messages.length, 0);
  assert.equal(next.snapshot(f.project.id).notes.length, 2);const serialized = JSON.stringify(next.snapshot(f.project.id));assert.equal(serialized.includes(agent.token), false);assert.equal(serialized.includes('tokenHash'), false);
});
test('heartbeats and progress updates remind the addressed agent without acknowledging or stopping work', async t => {
  const f = await fixture(t),a = (await f.join('a', ['one.js'])).session,b = (await f.join('b', ['two.js'])).session;
  const message = (await f.coordinator.sendMessage({projectId: f.project.id,toAgentId: 'b',text: 'Read the schema handoff.',kind: 'schedule'}, a.token)).message;
  const response = await f.coordinator.heartbeat(b.id, {state: 'working'}, b.token);assert.equal(response.inbox.requiresCheck, true);assert.equal(response.inbox.unreadCount, 1);assert.equal(response.inbox.messages[0].id, message.id);assert.equal(response.session.status, 'working');
  assert.equal((await f.coordinator.heartbeat(a.id, {}, a.token)).inbox.unreadCount, 0);assert.deepEqual(f.coordinator.state.messages[0].deliveredTo, []);
  assert.equal((await f.coordinator.update(b.id, {progress: 'Checking handoff'}, b.token)).inbox.unreadCount, 1);assert.equal(f.coordinator.state.messages[0].remindedTo[0].count, 2);
  assert.equal(f.coordinator.snapshot(f.project.id).agents.find(agent => agent.id === b.id).unreadCount, 1);
  await f.coordinator.acknowledge(b.id, {messageIds: [message.id]}, b.token);assert.equal((await f.coordinator.heartbeat(b.id, {}, b.token)).inbox.unreadCount, 0);
});
test('cross-project agent messages are rejected', async t => {
  const f = await fixture(t),a = (await f.join('a')).session,other = path.join(f.directory, 'other');await mkdir(other);
  const p = await f.coordinator.createProject({name: 'Other',root: other}, f.coordinator.ownerToken);
  await assert.rejects(f.coordinator.sendMessage({projectId: p.id,toAgentId: 'b',text: 'Invalid'}, a.token), {status: 403});
});
test('idle restart guard cannot begin while any agent is active and blocks racing joins after acceptance', async t => {
  const f = await fixture(t),agent = (await f.join('active-agent')).session;await assert.rejects(f.coordinator.prepareIdleRestart(), {status: 409});
  await f.coordinator.leave(agent.id, {reason: 'completed'}, agent.token);await f.coordinator.prepareIdleRestart();await assert.rejects(f.join('new-agent'), {status: 503});
});
test('project onboarding keeps existing instructions and replaces only its managed block', async t => {
  const f = await fixture(t),filename = path.join(f.root, 'AGENTS.md');await writeFile(filename, '# Existing rules\nKeep the firmware unchanged.\n');
  await installProjectPolicy(f.coordinator, f.project.id, f.coordinator.ownerToken, 'http://127.0.0.1:8793', '/tools/cli.mjs');
  await installProjectPolicy(f.coordinator, f.project.id, f.coordinator.ownerToken, 'http://127.0.0.1:8794', '/tools/cli.mjs');
  const content = await readFile(filename, 'utf8');assert.ok(content.startsWith('# Existing rules'));assert.equal(content.split('<!-- agent-coordinator:start -->').length, 2);assert.ok(content.includes('8794'));
  assert.ok(content.includes('Check unread messages after every heartbeat and progress update.'));
  assert.ok(content.includes('inbox.requiresCheck'));assert.ok(content.includes('explicitly acknowledge handled IDs'));
  assert.ok(content.includes('background output is inaccessible'));assert.ok(content.includes('not new user authorization'));
  const agent = (await f.join('rules-owner', ['AGENTS.md'])).session;await assert.rejects(installProjectPolicy(f.coordinator, f.project.id, f.coordinator.ownerToken, 'http://127.0.0.1:8793', '/tools/cli.mjs'), {status: 409});await f.coordinator.leave(agent.id, {reason: 'completed'}, agent.token);
});
test('long polling receives only relevant private messages and wakes when a session closes', async t => {
  const f = await fixture(t),a = (await f.join('a', [])).session,b = (await f.join('b', [])).session,cursor = f.coordinator.state.sequence;
  const waiting = f.coordinator.waitEvents(a.id, cursor, 1000, a.token);
  await f.coordinator.sendMessage({projectId: f.project.id,toAgentId: 'a',text: 'Coordinate schema'}, b.token);
  const event = await waiting;assert.equal(event.events[0].type, 'message.sent');
  const closing = f.coordinator.waitEvents(a.id, f.coordinator.state.sequence, 1000, a.token);await f.coordinator.leave(a.id, {reason: 'idle'}, a.token);assert.equal((await closing).session.status, 'idle');
});
test('HTTP protocol enforces host/origin and does not expose tokens in project snapshots', async t => {
  const f = await fixture(t),server = createHttpServer(f.coordinator, path.join(f.directory, 'public'), {port: 0});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));t.after(() => new Promise(resolve => {server.close(resolve);server.closeAllConnections();}));
  const base = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(base + '/health')).status, 200);
  assert.equal((await fetch(base + '/health', {headers: {Host: 'agents:' + server.address().port,Origin: 'http://agents:' + server.address().port}})).status, 200);
  assert.equal((await fetch(base + '/api/projects', {headers: {Origin: 'https://unrelated.example'}})).status, 403);
  const joined = await fetch(base + '/api/agents/join', {method: 'POST',headers: {'Content-Type': 'application/json'},body: JSON.stringify({projectId: f.project.id,agentId: 'http-agent',task: 'Test API',files: []})}).then(r => r.json());
  const snapshot = await fetch(base + '/api/projects/' + f.project.id, {headers: {Authorization: 'Bearer ' + joined.session.token}}).then(r => r.text());assert.equal(snapshot.includes(joined.session.token), false);assert.ok(snapshot.includes('http-agent'));
  assert.equal((await fetch(base + '/api/projects', {method: 'POST',headers: {'Content-Type': 'application/json'},body: JSON.stringify({name: 'No owner',root: f.root})})).status, 403);
  await f.coordinator.leave(joined.session.id, {reason: 'completed'}, joined.session.token);
});
