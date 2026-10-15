import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, readFile, rm} from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';

async function freePort() {
  const probe = net.createServer();await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));const port = probe.address().port;await new Promise(resolve => probe.close(resolve));return port;
}
function service(directory, port) {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'server.mjs')], {env: {...process.env,AGENT_COORD_DATA: directory,AGENT_COORD_PORT: String(port)},stdio: ['ignore', 'pipe', 'pipe']});let output = '';
  child.stdout.on('data', data => output += data);child.stderr.on('data', data => output += data);
  const done = new Promise((resolve, reject) => {child.once('exit', code => resolve(code));child.once('error', reject);});
  return {child,done,output: () => output};
}
async function waitHealth(base, process) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {const response = await fetch(base + '/health');if (response.ok) return;} catch {}
    if (process.child.exitCode !== null) throw Error(process.output());await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw Error('Synthetic test service did not become ready.');
}
test('duplicate launch does not retire sessions or rewrite a running coordinator state', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-startup-')),data = path.join(directory, 'data'),root = path.join(directory, 'project');await mkdir(root);
  const port = await freePort(),base = 'http://127.0.0.1:' + port,first = service(data, port);let token;
  t.after(async () => {
    if (token && first.child.exitCode === null) await fetch(base + '/api/shutdown', {method: 'POST',headers: {'Content-Type': 'application/json',Authorization: 'Bearer ' + token},body: '{}'}).catch(() => {});
    const timeout = setTimeout(() => first.child.kill(), 3000);try {await first.done;} finally {clearTimeout(timeout);await rm(directory, {recursive: true,force: true});}
  });
  await waitHealth(base, first);token = JSON.parse(await readFile(path.join(data, 'owner.json'), 'utf8')).token;
  const call = (route, input) => fetch(base + route, {method: 'POST',headers: {'Content-Type': 'application/json',Authorization: 'Bearer ' + token},body: JSON.stringify(input)}).then(r => r.json());
  const project = (await call('/api/projects', {name: 'Synthetic project',root})).project;
  const joined = await call('/api/agents/join', {projectId: project.id,agentId: 'synthetic-agent',task: 'Verify duplicate startup',files: ['app.js']});assert.equal(joined.session.status, 'working');
  const before = await readFile(path.join(data, 'state.json'), 'utf8'),duplicate = service(data, port);
  assert.equal(await duplicate.done, 1);assert.match(duplicate.output(), /already in use/);assert.equal(await readFile(path.join(data, 'state.json'), 'utf8'), before);
  if (process.platform === 'win32') {
    const otherPort = await freePort(),other = service(data, otherPort);assert.equal(await other.done, 1);assert.match(other.output(), /already in use/);assert.equal(await readFile(path.join(data, 'state.json'), 'utf8'), before);
  }
  const snapshot = await fetch(base + '/api/projects/' + project.id, {headers: {Authorization: 'Bearer ' + token}}).then(r => r.json());assert.equal(snapshot.agents[0].status, 'working');
});
