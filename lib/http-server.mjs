import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {CoordinatorError} from './coordinator.mjs';
import {installProjectPolicy} from './policy.mjs';
import {OwnerAccess} from './owner-access.mjs';
import {roadmapPolicy} from './roadmap.mjs';

export function createHttpServer(coordinator, publicDirectory, {port = 8793, onShutdown, buildId = null} = {}) {
  const json = (res, value, status = 200) => {res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8','Cache-Control': 'no-store','X-Content-Type-Options': 'nosniff'});res.end(JSON.stringify(value));};
  const assets = {'/roadmap.js':['roadmap.js','text/javascript'],'/': ['index.html', 'text/html'],'/app.js': ['app.js', 'text/javascript'],'/styles.css': ['styles.css', 'text/css'],'/icons.js': ['icons.js', 'text/javascript']};
  const ownerAccess = new OwnerAccess(() => coordinator.ownerToken, () => coordinator.now());
  const server = http.createServer(async (req, res) => {
    try {
      const actualPort = server.address()?.port || port,hosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`, `agents:${actualPort}`];
      if (!hosts.includes(req.headers.host) || req.headers.origin && !hosts.map(host => 'http://' + host).includes(req.headers.origin)) throw new CoordinatorError('Only the local coordinator origin is allowed.', 403);
      const url = new URL(req.url, 'http://127.0.0.1:' + actualPort),route = url.pathname,rawToken = req.headers.authorization?.replace(/^Bearer /, '') || '';
      if (!coordinator.ready) return json(res, {error: 'Coordinator is starting.'}, 503);
      const token = ownerAccess.resolveToken(rawToken, req.headers);
      let input = {};
      if (['POST', 'PATCH'].includes(req.method)) {
        if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new CoordinatorError('Send application/json.', 415);
        const chunks = [];let length = 0;for await (const chunk of req) {length += chunk.length;if (length > 128 * 1024) throw new CoordinatorError('Request is too large.', 413);chunks.push(chunk);}
        try {input = JSON.parse(Buffer.concat(chunks).toString() || '{}');} catch {throw new CoordinatorError('Invalid JSON.');}
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CoordinatorError('Send a JSON object.');
      }
      await coordinator.sweep();
      if (req.method === 'GET' && route === '/health') return json(res, {product: 'local-agent-coordinator',version: '0.1.0',port: actualPort,buildId,capabilities: {ownerAccess: true,heartbeatInbox: true,idleRestart: true,roadmap:true}});
      if (req.method === 'POST' && route === '/api/shutdown') {
        if (!coordinator.owner(token)) throw new CoordinatorError('Only the owner can stop the service.', 403);
        if (!onShutdown) throw new CoordinatorError('Shutdown is unavailable in this host.', 409);
        if (input.requireIdle === true) await coordinator.prepareIdleRestart();
        res.once('finish', () => {Promise.resolve(onShutdown()).catch(error => console.error(error.message));});return json(res, {accepted: true});
      }
      if (req.method === 'GET' && route === '/api/bootstrap') {
        if (!ownerAccess.canBootstrap(rawToken, req.headers)) throw new CoordinatorError('Owner sign-in required.', 401, {ownerSignInRequired: true});
        return json(res, {token: ownerAccess.bootstrapToken(rawToken, req.headers),snapshot: {projects: coordinator.state.projects,cursor: coordinator.state.sequence}});
      }
      if (req.method === 'POST' && route === '/api/owner/ticket') {
        if (!coordinator.owner(token)) throw new CoordinatorError('Only the owner can create a sign-in ticket.', 403);
        return json(res, ownerAccess.issueTicket());
      }
      if (req.method === 'POST' && route === '/api/owner/session') {
        const session = typeof input.ticket === 'string' && ownerAccess.redeem(input.ticket);
        if (!session) throw new CoordinatorError('Sign-in ticket expired or already used. Open the launcher again.', 401, {ownerSignInRequired: true});
        res.setHeader('Set-Cookie', session.setCookie);return json(res, {token: session.token,snapshot: {projects: coordinator.state.projects,cursor: coordinator.state.sequence}});
      }
      if (req.method === 'GET' && route === '/api/projects') return json(res, {projects: coordinator.state.projects});
      if (req.method === 'POST' && route === '/api/projects') {
        const created = await coordinator.createProject(input, token);let policy = null;
        if (input.installPolicy === true) try {policy = await installProjectPolicy(coordinator, created.id, token, `http://127.0.0.1:${actualPort}`, path.join(publicDirectory, '..', 'cli.mjs'));} catch (error) {policy = {installed: false,error: error.message};}
        return json(res, {project: created,policy}, 201);
      }
      const policy = route.match(/^\/api\/projects\/([^/]+)\/policy$/);
      if (req.method === 'POST' && policy) return json(res, await installProjectPolicy(coordinator, policy[1], token, `http://127.0.0.1:${actualPort}`, path.join(publicDirectory, '..', 'cli.mjs')));
      const project = route.match(/^\/api\/projects\/([^/]+)$/),notes = route.match(/^\/api\/projects\/([^/]+)\/notes$/),session = route.match(/^\/api\/sessions\/([^/]+)(?:\/(heartbeat|leave|events|inbox|ack))?$/);
      const roadmap=route.match(/^\/api\/projects\/([^/]+)\/roadmap(?:\/(claim|render))?$/);
      if(roadmap){
        const [,id,action]=roadmap;
        if(req.method==='GET'&&action==='render'){
          // Cookie authorization is read-only here; mutations still require the bound API token.
          const reader=ownerAccess.cookie(req.headers)?coordinator.ownerToken:token;
          const value=coordinator.roadmap(id,reader);
          res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':roadmapPolicy,'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Permissions-Policy':'camera=(), microphone=(), geolocation=()'});
          res.end(value.html||'<!doctype html><meta charset="utf-8"><title>Roadmap</title>');return;
        }
        if(req.method==='GET'&&!action)return json(res,{roadmap:coordinator.roadmap(id,token)});
        if(req.method==='PATCH'&&!action)return json(res,await coordinator.updateRoadmap(id,input,token));
        if(req.method==='POST'&&action==='claim')return json(res,await coordinator.updateRoadmap(id,input,token,{claim:true}));
      }
      if (req.method === 'GET' && project) {
        const principal = coordinator.authorizeProject(project[1], token, {requireActive: false}),snapshot = coordinator.snapshot(project[1]);
        if (!principal.owner) {
          const visible = message => ['*', principal.agentId].includes(message.toAgentId) || message.fromAgentId === principal.agentId;
          snapshot.messages = snapshot.messages.filter(visible);snapshot.events = snapshot.events.filter(event => event.type !== 'message.sent' || visible(event.data));
        }
        return json(res, snapshot);
      }
      if (notes && req.method === 'GET') {
        coordinator.authorizeProject(notes[1], token, {requireActive: false});const query = (url.searchParams.get('q') || '').toLowerCase();
        return json(res, {notes: coordinator.state.notes.filter(n => n.projectId === notes[1] && (!query || `${n.title}\n${n.text}\n${n.tags.join(' ')}`.toLowerCase().includes(query)))});
      }
      if (notes && req.method === 'POST') return json(res, await coordinator.postNote(notes[1], input, token), 201);
      if (req.method === 'POST' && route === '/api/agents/join') return json(res, await coordinator.join(input), 201);
      if (req.method === 'POST' && route === '/api/messages') return json(res, await coordinator.sendMessage(input, token), 201);
      if (session) {
        const [, id, action] = session;
        if (req.method === 'PATCH' && !action) return json(res, await coordinator.update(id, input, token));
        if (req.method === 'POST' && action === 'heartbeat') return json(res, await coordinator.heartbeat(id, input, token));
        if (req.method === 'POST' && action === 'leave') return json(res, await coordinator.leave(id, input, token));
        if (req.method === 'GET' && action === 'inbox') return json(res, coordinator.inbox(id, token));
        if (req.method === 'POST' && action === 'ack') return json(res, await coordinator.acknowledge(id, input, token));
        if (req.method === 'GET' && action === 'events') {
          const abort = new AbortController();res.once('close', () => abort.abort());
          const result = await coordinator.waitEvents(id, Number(url.searchParams.get('after') || 0), Number(url.searchParams.get('wait') || 0), token, abort.signal);
          if (!res.destroyed) return json(res, result);return;
        }
      }
      if (req.method === 'GET' && assets[route]) {
        const [file, mime] = assets[route],content = await readFile(path.join(publicDirectory, file));
        res.writeHead(200, {'Content-Type': mime + '; charset=utf-8','Cache-Control': 'no-store','X-Content-Type-Options': 'nosniff','Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'"});res.end(content);return;
      }
      return json(res, {error: 'Not found.'}, 404);
    } catch (error) {
      if (res.destroyed) return;
      json(res, {error: error.message,...(error.details || {})}, error.status || 500);
    }
  });
  server.ownerAccess = ownerAccess;return server;
}
