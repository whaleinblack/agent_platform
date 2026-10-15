import {readFile, writeFile, rename, mkdir, open, realpath} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import {coreBuildId} from './lib/build-id.mjs';

// One owner-authorized maintenance job. It never cancels an agent or edits a
// registered project; all work here is confined to this platform's own service.
const root = import.meta.dirname,data = process.env.AGENT_COORD_DATA || path.join(root, '.data'),base = 'http://127.0.0.1:' + Number(process.env.AGENT_COORD_PORT || 8793);
const statusFile = path.join(data, 'deployment-status.json');let guard;
const controller = new AbortController();
process.on('SIGINT', () => controller.abort());process.on('SIGTERM', () => controller.abort());
const pause = ms => new Promise(resolve => {const timer = setTimeout(done, ms);function done() {clearTimeout(timer);controller.signal.removeEventListener('abort', done);resolve();}controller.signal.addEventListener('abort', done, {once: true});if (controller.signal.aborted) done();});
async function status(phase, detail = {}) {
  const value = {phase,...detail,pid: process.pid,updatedAt: new Date().toISOString()};await writeFile(statusFile + '.tmp', JSON.stringify(value, null, 2));await rename(statusFile + '.tmp', statusFile);
}
async function token() {return JSON.parse(await readFile(path.join(data, 'owner.json'), 'utf8')).token;}
async function api(route, body) {
  const response = await fetch(base + route, {method: body === undefined ? 'GET' : 'POST',headers: {Authorization: 'Bearer ' + await token(),...(body === undefined ? {} : {'Content-Type': 'application/json'})},...(body === undefined ? {} : {body: JSON.stringify(body)}),signal: AbortSignal.timeout(2000)});
  const result = await response.json();if (!response.ok) throw Object.assign(Error(result.error || 'Service request failed.'), {status: response.status});return result;
}
async function activeAgents() {
  const {projects} = await api('/api/projects');let count = 0;
  for (const project of projects) {const snapshot = await api('/api/projects/' + encodeURIComponent(project.id));count += snapshot.agents.filter(agent => ['working', 'waiting'].includes(agent.status)).length;}
  return count;
}
async function health() {const result = await fetch(base + '/health', {signal: AbortSignal.timeout(1500)}).then(r => r.json());if (result.product !== 'local-agent-coordinator') throw Error('The port belongs to another service.');return result;}
async function validate() {
  await status('validating');const log = await open(path.join(data, 'deployment-validation.log'), 'w');
  try {await new Promise((resolve, reject) => {const child = spawn(process.execPath, ['--test', 'tests/*.test.mjs'], {cwd: root,stdio: ['ignore', log.fd, log.fd],windowsHide: true});child.once('error', reject);child.once('exit', code => code === 0 ? resolve() : reject(Error('Validation failed; see deployment-validation.log.')));});} finally {await log.close();}
}
async function launch() {
  const output = await open(path.join(data, 'service.log'), 'w'),error = await open(path.join(data, 'service-error.log'), 'w');
  try {
    const child = spawn(process.execPath, [path.join(root, 'server.mjs'), '--open'], {cwd: root,detached: true,stdio: ['ignore', output.fd, error.fd],windowsHide: true});
    await new Promise((resolve, reject) => {child.once('spawn', resolve);child.once('error', reject);});child.unref();return child.pid;
  } finally {await output.close();await error.close();}
}
async function waitFor(predicate, milliseconds) {const deadline = Date.now() + milliseconds;while (!controller.signal.aborted && Date.now() < deadline) {if (await predicate()) return;await pause(150);}throw Error('Service transition timed out.');}
try {
  await mkdir(data, {recursive: true});
  if (process.argv.includes('--check')) {await health();console.log(JSON.stringify({phase: 'read-only',activeAgents: await activeAgents()}));}
  else {
    if (process.platform === 'win32') {
      const name = createHash('sha256').update((await realpath(data)).toLowerCase()).digest('hex').slice(0, 24);guard = net.createServer(socket => socket.destroy());
      await new Promise((resolve, reject) => {guard.once('error', reject);guard.listen('\\\\.\\pipe\\agent-coordinator-deploy-' + name, resolve);});
    }
    while (!controller.signal.aborted) {
      let service,count;
      try {service = await health();count = await activeAgents();} catch {await status('waiting-for-service');await pause(10000);continue;}
      if (count) {await status('waiting-for-agents', {activeAgents: count});await pause(10000);continue;}
      const expected = await coreBuildId(root);
      if (service.buildId === expected) {await status('completed', {alreadyUpdated: true,url: 'http://agents/'});break;}
      await validate();
      if (await activeAgents()) continue;
      await status('deploying', {activeAgents: 0});
      try {await api('/api/shutdown', {requireIdle: true});} catch (error) {if (error.status === 409) continue;throw error;}
      await waitFor(async () => {try {await health();return false;} catch {return true;}}, 10000);
      const pid = await launch();
      await waitFor(async () => {try {return (await health()).buildId === expected;} catch {return false;}}, 15000);
      const bootstrap = await fetch(base + '/api/bootstrap');if (bootstrap.status !== 401) throw Error('Anonymous owner bootstrap was not protected.');
      await status('completed', {servicePid: pid,buildId: expected,url: 'http://agents/'});break;
    }
    if (controller.signal.aborted) await status('cancelled');
  }
} catch (error) {
  if (error.code === 'EADDRINUSE') console.log('A deployment waiter is already running.');
  else {await status('failed', {error: error.message});console.error(error.message);process.exitCode = 1;}
} finally {if (guard?.listening) await new Promise(resolve => guard.close(resolve));}
