import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {ensureAliases, probeAlias} from '../lib/aliases.mjs';

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-alias-'));t.after(() => rm(directory, {recursive: true,force: true}));
  const script = path.join(directory, 'redirect_server.py');await writeFile(script, '# Synthetic script\n');return {directory,script};
}
test('unconfigured services never touch the machine alias gateway', async t => {
  const f = await fixture(t);assert.deepEqual(await ensureAliases(f.directory, {probeImpl: () => assert.fail('No probe'),spawnImpl: () => assert.fail('No spawn')}), {configured: false});
});
test('existing gateway is reused; an unknown listener is not displaced', async t => {
  const f = await fixture(t);await writeFile(path.join(f.directory, 'aliases.json'), JSON.stringify({scriptPath: f.script,pythonPath: process.execPath}));
  const result = await ensureAliases(f.directory, {probeImpl: async () => ({status: 302,location: 'http://localhost:8793/'}),spawnImpl: () => assert.fail('Existing gateway')});assert.equal(result.url, 'http://agents/');
  await assert.rejects(ensureAliases(f.directory, {probeImpl: async () => ({status: 302,location: 'http://localhost:8765/'}),spawnImpl: () => assert.fail('Do not overwrite gateway')}), /outdated/);
});
test('gateway starts hidden only after connection refusal', async t => {
  const f = await fixture(t);await writeFile(path.join(f.directory, 'aliases.json'), JSON.stringify({scriptPath: f.script,pythonPath: process.execPath}));let probes = 0,spawns = 0;
  const result = await ensureAliases(f.directory, {
    probeImpl: async () => {if (!probes++) throw Object.assign(Error('No listener'), {code: 'ECONNREFUSED'});return {status: 302,location: 'http://localhost:8793/'};},
    spawnImpl: (executable, args, options) => {spawns++;assert.equal(executable, process.execPath);assert.equal(args[0], f.script);assert.equal(options.windowsHide, true);const child = new EventEmitter();child.unref = () => {};queueMicrotask(() => child.emit('spawn'));return child;}
  });assert.equal(result.running, true);assert.equal(spawns, 1);
});
test('probe sends the agents Host header over loopback rather than relying on fetch forbidden headers', async t => {
  let received;const server = http.createServer((req, res) => {received = req.headers.host;res.writeHead(302, {Location: 'http://localhost:8793/'});res.end();});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));t.after(() => new Promise(resolve => {server.close(resolve);server.closeAllConnections();}));
  const result = await probeAlias({port: server.address().port});assert.equal(received, 'agents');assert.equal(result.location, 'http://localhost:8793/');
});
