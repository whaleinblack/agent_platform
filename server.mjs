import path from 'node:path';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {mkdir, realpath, readFile, access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Coordinator} from './lib/coordinator.mjs';
import {createHttpServer} from './lib/http-server.mjs';
import {ensureAliases} from './lib/aliases.mjs';
import {coreBuildId} from './lib/build-id.mjs';

const root = import.meta.dirname,port = Number(process.env.AGENT_COORD_PORT || 8793);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid AGENT_COORD_PORT.');
const data = process.env.AGENT_COORD_DATA || path.join(root, '.data'),coordinator = new Coordinator(data);
const server = createHttpServer(coordinator, path.join(root, 'public'), {port,onShutdown: shutdown,buildId: await coreBuildId(root)});
let closing = false,sweep,guard;
async function openBrowser(url) {
  if (process.platform !== 'win32') return;
  // Explorer may silently ignore a URL launched by a detached service.
  let executable = 'explorer.exe';
  for (const directory of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]) {
    if (!directory) continue;
    const candidate = path.join(directory, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    try {await access(candidate);executable = candidate;break;} catch {}
  }
  const browser = spawn(executable, [url], {detached: true,stdio: 'ignore',windowsHide: true});
  await new Promise((resolve, reject) => {browser.once('spawn', resolve);browser.once('error', reject);});browser.unref();
}
async function ownerEntry(url) {
  const credentials = JSON.parse(await readFile(path.join(data, 'owner.json'), 'utf8'));
  const response = await fetch(`http://127.0.0.1:${port}/api/owner/ticket`, {method: 'POST',headers: {'Content-Type': 'application/json',Authorization: 'Bearer ' + credentials.token},body: '{}',signal: AbortSignal.timeout(2000)});
  if (!response.ok) throw Error('Could not authorize the owner browser.');
  const ticket = await response.json();return url + '#owner=' + ticket.ticket;
}
async function start() {
  // Reserve the port before loading state: a second launcher must not retire
  // sessions owned by the first service.
  await new Promise((resolve, reject) => {server.once('error', reject);server.listen(port, '127.0.0.1', () => {server.removeListener('error', reject);resolve();});});
  await mkdir(data, {recursive: true});
  if (process.platform === 'win32') {
    const canonical = (await realpath(data)).toLowerCase(),name = createHash('sha256').update(canonical).digest('hex').slice(0, 24);
    guard = net.createServer(socket => socket.destroy());
    await new Promise((resolve, reject) => {guard.once('error', reject);guard.listen('\\\\.\\pipe\\agent-coordinator-' + name, resolve);});
  }
  await coordinator.init();
  sweep = setInterval(() => coordinator.sweep().catch(error => console.error(error.message)), 1000);sweep.unref();
  server.on('error', error => console.error(error.message));
  let browserUrl = `http://127.0.0.1:${port}/`;
  try {const aliases = await ensureAliases(data);if (aliases.running) {browserUrl = aliases.url;console.log('Alias entry: ' + aliases.url);}} catch (error) {console.error('Alias entry: ' + error.message);}
  if (closing) return;
  console.log(`Agent Coordinator: http://127.0.0.1:${port}/`);if (process.argv.includes('--open')) try {await openBrowser(await ownerEntry(browserUrl));} catch (error) {console.error('Owner browser: ' + error.message);}
}
async function shutdown() {
  if (closing) return;closing = true;clearInterval(sweep);
  if (coordinator.ready) await coordinator.shutdown();server.close();server.closeIdleConnections();guard?.close();
  const timeout = setTimeout(() => server.closeAllConnections(), 3000);timeout.unref();
}
process.on('SIGINT', () => shutdown().catch(error => {console.error(error.message);process.exitCode = 1;}));
process.on('SIGTERM', () => shutdown().catch(error => {console.error(error.message);process.exitCode = 1;}));
try {await start();} catch (error) {
  clearInterval(sweep);if (server.listening) server.close();if (guard?.listening) guard.close();
  if (error.code === 'EADDRINUSE' && process.argv.includes('--open')) {
    try {const health = await fetch(`http://127.0.0.1:${port}/health`, {signal: AbortSignal.timeout(1500)}).then(r => r.json());if (health.product !== 'local-agent-coordinator') throw error;console.log(`Coordinator already running: http://127.0.0.1:${port}/`);let url = `http://127.0.0.1:${port}/`;try {const aliases = await ensureAliases(data);if (aliases.running) url = aliases.url;} catch {}await openBrowser(await ownerEntry(url));} catch {console.error(`Port ${port} or this coordinator data directory is already in use, or owner authorization failed.`);process.exitCode = 1;}
  } else {console.error(error.code === 'EADDRINUSE' ? `Port ${port} or this coordinator data directory is already in use.` : error.message);process.exitCode = 1;}
}
