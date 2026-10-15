import {readFile, stat} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import http from 'node:http';

export function probeAlias({port = 80} = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({hostname: '127.0.0.1',port,path: '/',headers: {Host: 'agents'}}, response => {
      response.resume();response.once('end', () => resolve({status: response.statusCode,location: response.headers.location}));
    });
    request.setTimeout(1000, () => request.destroy(Object.assign(Error('Alias service timed out.'), {code: 'ETIMEDOUT'})));request.once('error', reject);request.end();
  });
}

export async function ensureAliases(directory, {probeImpl = probeAlias, spawnImpl = spawn} = {}) {
  let config;
  try {config = JSON.parse(await readFile(path.join(directory, 'aliases.json'), 'utf8'));} catch (error) {if (error.code === 'ENOENT') return {configured: false};throw error;}
  if (!path.isAbsolute(config.scriptPath || '') || !path.isAbsolute(config.pythonPath || '') || path.basename(config.scriptPath) !== 'redirect_server.py' || !(await stat(config.scriptPath)).isFile() || !(await stat(config.pythonPath)).isFile()) throw Error('Invalid local alias configuration.');
  const workTarget = config.workTarget || 'http://localhost:8765/',agentTarget = config.agentTarget || 'http://localhost:8793/';
  for (const value of [workTarget, agentTarget]) {const url = new URL(value);if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('Alias targets must be local HTTP roots.');}
  async function probe() {
    const response = await probeImpl();
    if (![302, 307, 308].includes(response.status) || response.location !== agentTarget) throw Error('Port 80 is occupied by a different or outdated alias service.');
    return {configured: true,running: true,url: 'http://agents/'};
  }
  try {return await probe();} catch (error) {if (error.code !== 'ECONNREFUSED') throw error;}
  const child = spawnImpl(config.pythonPath, [config.scriptPath, '--port', '80', '--target', workTarget, '--agents-target', agentTarget], {detached: true,stdio: 'ignore',windowsHide: true});
  await new Promise((resolve, reject) => {child.once('spawn', resolve);child.once('error', reject);});child.unref();
  for (let attempt = 0; attempt < 20; attempt++) {try {return await probe();} catch (error) {if (error.code !== 'ECONNREFUSED') throw error;}await new Promise(resolve => setTimeout(resolve, 100));}
  throw Error('The local alias service did not become ready.');
}
