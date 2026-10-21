import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const DEFAULT_BASE_URL = 'http://127.0.0.1:8793';
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
export const DEFAULT_PROGRESS_INTERVAL_MS = 60_000;
export const DEFAULT_DATA_DIR = fileURLToPath(new URL('../.data/clients/', import.meta.url));
const ACTIVE = new Set(['working', 'waiting']);
const STATES = new Set(['working', 'waiting', 'idle']);
const REASONS = new Set(['completed', 'idle', 'failed', 'cancelled']);
const INBOX_REMINDER_INTERVAL_MS = 60_000;
// Long polls need headroom beyond the server wait when either process is CPU-starved.
const EVENTS_TIMEOUT_MARGIN_MS = 30_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 15_000;
// The server's minimum lease; assumed only when an old record lacks leaseMs.
const MIN_LEASE_MS = 15_000;
const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const timers = { setTimeout, clearTimeout, now: Date.now };

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a nonempty string`);
  return value;
}

function filesArray(files) {
  if (!Array.isArray(files) || files.some(file => typeof file !== 'string' || !file.trim())) {
    throw new TypeError('files must be an array of nonempty paths; [] is valid for read-only work');
  }
  return [...new Set(files)];
}

export function normalizeBaseUrl(value = DEFAULT_BASE_URL) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new TypeError('base URL must be http://localhost[:port] or http://127.0.0.1[:port], without credentials, path, query, or fragment');
  }
  return url.href.replace(/\/+$/, '');
}

function positiveInterval(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('interval must be a positive integer');
  return value;
}

function safeDetail(detail, token) {
  if (token) detail = detail.split(token).join('[redacted]');
  return detail.replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 800);
}

export class ApiError extends Error {
  constructor(status, body, method, path, token) {
    let detail = typeof body?.error === 'string' ? body.error : '';
    if (Array.isArray(body?.conflicts)) {
      const conflicts = body.conflicts.slice(0, 10).map(conflict => ({
        agentId: conflict.agentId, files: Array.isArray(conflict.files) ? conflict.files.slice(0, 10) : [],
      }));
      detail += ` Conflicts: ${JSON.stringify(conflicts)}`;
    }
    detail = safeDetail(detail, token);
    super(`${method} ${path.split('?')[0]} failed (HTTP ${status})${detail ? `: ${detail}` : ''}`);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

// A request that produced no HTTP response: a client timeout or a network failure.
export class TransportError extends Error {
  constructor(method, path, cause, { timeoutMs, token } = {}) {
    // Node network codes are strings; DOMException codes are legacy numbers.
    const code = [cause?.code, cause?.cause?.code].find(value => typeof value === 'string');
    const detail = timeoutMs === undefined
      ? `failed: ${safeDetail(`${cause?.message || 'network error'}${code ? ` (${code})` : ''}`, token)}`
      : `timed out after ${timeoutMs} ms`;
    super(`${method} ${path.split('?')[0]} ${detail}`, { cause });
    this.name = 'TransportError';
    this.timedOut = timeoutMs !== undefined;
  }
}

// Transient failures say nothing about the lease; HTTP 409 and other 4xx responses do.
export function isTransientError(error) {
  return error instanceof TransportError || (error instanceof ApiError && TRANSIENT_STATUSES.has(error.status));
}

export class CoordinatorClient {
  constructor({ baseUrl = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.fetch = fetchImpl;
    this.timeoutMs = positiveInterval(timeoutMs, 10_000);
  }

  async request(method, path, body, { token, signal, timeoutMs = this.timeoutMs } = {}) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response, text;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method, headers, signal: requestSignal, redirect: 'error',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      text = await response.text();
    } catch (error) {
      // Caller cancellation keeps its own reason; it is not a transport failure.
      if (signal?.aborted) throw error;
      throw new TransportError(method, path, error, { timeoutMs: timeout.aborted ? timeoutMs : undefined, token });
    }
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      if (!response.ok) throw new ApiError(response.status, null, method, path, token);
      throw new Error(`Invalid JSON from ${method} ${path.split('?')[0]}`);
    }
    if (!response.ok) throw new ApiError(response.status, data, method, path, token);
    return data;
  }

  projects(options) {
    return this.request('GET', '/api/projects', undefined, options);
  }

  snapshot(projectId, options) {
    return this.request('GET', `/api/projects/${encodeURIComponent(requiredString(projectId, 'projectId'))}`, undefined, options);
  }

  join({ projectId, agentId, task, files = [] }, options) {
    return this.request('POST', '/api/agents/join', {
      projectId: requiredString(projectId, 'projectId'),
      agentId: requiredString(agentId, 'agentId'),
      task: requiredString(task, 'task'),
      files: filesArray(files),
    }, options);
  }
}

function safeSessionId(id) {
  requiredString(id, 'session id');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(id) || /[.]$/.test(id)
      || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])([.]|$)/i.test(id)) {
    throw new TypeError('session id is not safe for a credential filename');
  }
  return id;
}

function validateRecord(record) {
  if (!record || record.version !== 1 || !record.session) throw new Error('Invalid session credential record');
  safeSessionId(record.session.id);
  requiredString(record.session.token, 'session token');
  requiredString(record.session.projectId, 'projectId');
  requiredString(record.session.agentId, 'agentId');
  requiredString(record.session.status, 'session status');
  filesArray(record.session.files);
  normalizeBaseUrl(record.baseUrl);
  positiveInterval(record.heartbeatIntervalMs, DEFAULT_HEARTBEAT_INTERVAL_MS);
  return record;
}

export class CredentialStore {
  constructor(directory = process.env.AGENT_COORD_CLIENT_DATA
      || (process.env.AGENT_COORD_DATA ? join(process.env.AGENT_COORD_DATA, 'clients') : DEFAULT_DATA_DIR)) {
    this.directory = resolve(directory);
  }

  path(sessionId) {
    return join(this.directory, `${safeSessionId(sessionId)}.json`);
  }

  async save(record) {
    validateRecord(record);
    const path = this.path(record.session.id);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      // Windows readers can briefly prevent atomic replacement of a credential file.
      for (let attempt = 0; ; attempt += 1) {
        try { await rename(temporary, path); break; } catch (error) {
          if (process.platform !== 'win32' || attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
          await new Promise(resolve => setTimeout(resolve, 10 * 2 ** attempt));
        }
      }
    } finally {
      await rm(temporary, { force: true });
    }
    return path;
  }

  async load(sessionId) {
    const record = validateRecord(JSON.parse(await readFile(this.path(sessionId), 'utf8')));
    if (record.session.id !== sessionId) throw new Error('Credential session id does not match its filename');
    return record;
  }

  async list({ agentId, projectId } = {}) {
    requiredString(agentId, 'agentId');
    if (projectId !== undefined) requiredString(projectId, 'projectId');
    let entries;
    try { entries = await readdir(this.directory, { withFileTypes: true }); } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new Error(`Cannot list local session credentials (${error.code || 'I/O error'})`);
    }
    const sessions = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      let record;
      try { record = await this.load(entry.name.slice(0, -5)); } catch {
        // Ignore malformed, unreadable or disappearing files without exposing JSON or secrets.
        continue;
      }
      const session = record.session;
      if (session.agentId !== agentId || (projectId !== undefined && session.projectId !== projectId)) continue;
      sessions.push({
        id: session.id, agentId: session.agentId, projectId: session.projectId,
        status: session.status, baseUrl: normalizeBaseUrl(record.baseUrl),
        task: typeof session.task === 'string' ? session.task : '', files: [...session.files],
      });
    }
    return sessions;
  }
}

export async function registerSession(client, store, registration, options) {
  const result = await client.join(registration, options);
  const record = validateRecord({
    version: 1, baseUrl: client.baseUrl,
    session: { projectId: registration.projectId, agentId: registration.agentId, files: registration.files || [], ...result.session },
    heartbeatIntervalMs: result.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    leaseMs: result.leaseMs, idleMs: result.idleMs, cursor: result.cursor ?? 0,
  });
  const handle = new SessionClient({ client, store, record });
  try {
    await handle.persist();
  } catch (error) {
    // Registration must not strand a write claim when local credential storage fails.
    try { await handle.leave('failed', 'Could not store local session credentials.'); } catch { /* Preserve the storage error. */ }
    throw error;
  }
  return handle;
}

export function messageVisible(message, session) {
  if (!message || typeof message !== 'object') return false;
  if (message.projectId && message.projectId !== session.projectId) return false;
  return !message.toAgentId || message.toAgentId === '*' || message.toAgentId === session.agentId || message.fromAgentId === session.agentId;
}

export function eventVisible(event, session) {
  if (!event || event.projectId !== session.projectId) return false;
  if (/^message([.:_-]|$)/.test(event.type)) return messageVisible(event.data?.message || event.data, session);
  return true;
}

export class SessionClient {
  constructor({ client, store, record }) {
    this.record = structuredClone(validateRecord(record));
    this.client = client || new CoordinatorClient({ baseUrl: record.baseUrl });
    if (this.client.baseUrl !== normalizeBaseUrl(record.baseUrl)) throw new Error('Refusing to send stored credentials to another base URL');
    this.store = store;
    this.revision = 0;
    this.mutations = Promise.resolve();
    this.saves = Promise.resolve();
    this.leavePromise = null;
    this.latestInbox = null;
  }

  get session() { return this.record.session; }
  get cursor() { return this.record.cursor; }
  get active() { return ACTIVE.has(this.session.status); }

  persist() {
    const record = structuredClone(this.record);
    const next = this.saves.catch(() => {}).then(() => this.store?.save(record));
    this.saves = next;
    return next;
  }

  request(method, suffix, body, options = {}) {
    return this.client.request(method, `/api/sessions/${encodeURIComponent(this.session.id)}${suffix}`, body, {
      ...options, token: this.session.token,
    });
  }

  async apply(result, { requireSession = false, revision } = {}) {
    const session = result?.session || (result?.id === this.session.id ? result : null);
    if (requireSession && (!session || typeof session.status !== 'string')) throw new Error('Server response is missing session status');
    if (session && (revision === undefined || revision === this.revision || !ACTIVE.has(session.status))
        && (this.active || !ACTIVE.has(session.status))) {
      if (session.id && session.id !== this.session.id) throw new Error('Server returned a different session');
      this.record.session = { ...this.session, ...session, token: this.session.token };
    }
    if ((revision === undefined || revision === this.revision)
        && result?.inbox && typeof result.inbox === 'object' && !Array.isArray(result.inbox)) {
      this.latestInbox = structuredClone(result.inbox);
    }
    await this.persist();
    return result;
  }

  mutate(operation) {
    const next = this.mutations.catch(() => {}).then(async () => {
      let result;
      try { result = await operation(); } catch (error) {
        const closed = error instanceof ApiError && error.body?.session;
        if (closed && typeof closed.status === 'string' && !ACTIVE.has(closed.status)) {
          this.revision += 1;
          await this.apply({ session: closed });
        }
        throw error;
      }
      this.revision += 1;
      await this.apply(result, { requireSession: true });
      return result;
    });
    this.mutations = next;
    return next;
  }

  update(patch = {}, options) {
    const body = {};
    for (const key of ['task', 'files', 'progress']) {
      if (Object.hasOwn(patch, key)) body[key] = key === 'files' ? filesArray(patch[key]) : requiredString(patch[key], key);
    }
    return this.mutate(async () => this.withInbox(await this.request('PATCH', '', body, options), options));
  }

  heartbeat(state, options) {
    if (state !== undefined && !STATES.has(state)) throw new TypeError('heartbeat state must be working, waiting, or idle');
    return this.mutate(async () => {
      const currentState = state ?? this.session.status;
      if (!STATES.has(currentState)) throw new TypeError('heartbeat state must be working, waiting, or idle');
      return this.withInbox(await this.request('POST', '/heartbeat', { state: currentState }, options), options);
    });
  }

  async withInbox(result, options) {
    if (result?.inbox && typeof result.inbox === 'object' && !Array.isArray(result.inbox)) return result;
    try {
      const response = await this.inbox(options);
      const messages = response.messages.filter(message => [this.session.agentId, '*'].includes(message.toAgentId)
        && !message.deliveredTo?.includes(this.session.agentId));
      return { ...result, inbox: { unreadCount: messages.length, requiresCheck: messages.length > 0,
        messages: messages.slice(0, 20), hasMore: messages.length > 20, source: 'fallback' } };
    } catch (error) {
      // Inbox availability must not invalidate a successful lease or claim update.
      const detail = safeDetail(String(error?.message || 'Inbox check failed'), this.session.token);
      return { ...result, inbox: { unreadCount: null, requiresCheck: true, messages: [], hasMore: null,
        source: 'fallback', checkFailed: true, error: detail } };
    }
  }

  leave(reason = 'completed', summary, options) {
    if (!REASONS.has(reason)) throw new TypeError('Invalid leave reason');
    if (summary !== undefined) requiredString(summary, 'summary');
    if (this.leavePromise) return this.leavePromise;
    this.leavePromise = this.mutations.catch(() => {}).then(async () => {
      if (!this.active) return { session: this.session };
      const result = await this.request('POST', '/leave', { reason, ...(summary === undefined ? {} : { summary }) }, options);
      this.revision += 1;
      await this.apply(result);
      if (this.active) {
        this.record.session = { ...this.session, status: 'closed', reason };
        await this.persist();
      }
      return result;
    });
    this.mutations = this.leavePromise;
    return this.leavePromise;
  }

  async events({ signal, wait = 25_000 } = {}) {
    const revision = this.revision;
    const query = new URLSearchParams({ after: String(this.cursor), wait: String(wait) });
    const result = await this.request('GET', `/events?${query}`, undefined, { signal, timeoutMs: wait + EVENTS_TIMEOUT_MARGIN_MS });
    if (!Array.isArray(result.events) || result.cursor === undefined) throw new Error('Invalid events response');
    this.record.cursor = result.cursor;
    await this.apply(result, { requireSession: true, revision });
    return { ...result, events: result.events.filter(event => eventVisible(event, this.session)) };
  }

  async inbox(options) {
    const result = await this.request('GET', '/inbox', undefined, options);
    if (!Array.isArray(result.messages)) throw new Error('Invalid inbox response');
    // Inbox reads do not acknowledge delivery or advance the event-stream cursor.
    return { ...result, messages: result.messages.filter(message => messageVisible(message, this.session)) };
  }

  snapshot(options = {}) {
    return this.client.snapshot(this.session.projectId, { ...options, token: this.session.token });
  }

  notes(search, options = {}) {
    if (search !== undefined && typeof search !== 'string') throw new TypeError('note search must be a string');
    const query = search === undefined ? '' : `?${new URLSearchParams({ q: search })}`;
    return this.client.request('GET', `/api/projects/${encodeURIComponent(this.session.projectId)}/notes${query}`, undefined, {
      ...options, token: this.session.token,
    });
  }

  ack(messageIds, options) {
    if (!Array.isArray(messageIds) || messageIds.some(id => typeof id !== 'string' || !id)) throw new TypeError('messageIds must be an array of ids');
    return this.request('POST', '/ack', { messageIds: [...new Set(messageIds)] }, options);
  }

  send({ toAgentId, text, kind = 'message' }, options = {}) {
    return this.client.request('POST', '/api/messages', {
      projectId: this.session.projectId, toAgentId: requiredString(toAgentId, 'toAgentId'),
      text: requiredString(text, 'text'), kind: requiredString(kind, 'kind'),
    }, { ...options, token: this.session.token });
  }

  note({ title, text, tags }, options = {}) {
    if (tags !== undefined && (!Array.isArray(tags) || tags.some(tag => typeof tag !== 'string'))) throw new TypeError('tags must be strings');
    return this.client.request('POST', `/api/projects/${encodeURIComponent(this.session.projectId)}/notes`, {
      title: requiredString(title, 'title'), text: requiredString(text, 'text'), ...(tags === undefined ? {} : { tags }),
    }, { ...options, token: this.session.token });
  }
  roadmap(options={}){return this.client.request('GET',`/api/projects/${encodeURIComponent(this.session.projectId)}/roadmap`,undefined,{...options,token:this.session.token});}
  claimRoadmap(baseRevision,options={}){return this.client.request('POST',`/api/projects/${encodeURIComponent(this.session.projectId)}/roadmap/claim`,{baseRevision},{...options,token:this.session.token});}
  writeRoadmap(html,baseRevision,options={}){return this.client.request('PATCH',`/api/projects/${encodeURIComponent(this.session.projectId)}/roadmap`,{html,baseRevision},{...options,token:this.session.token});}
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function pause(ms, signal, clock) {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const done = () => {
      clock.clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = clock.setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

export function startWatching(handle, {
  signal, onEvent = () => {}, onSession = () => {}, onStopping = () => {},
  heartbeatIntervalMs = handle.record.heartbeatIntervalMs,
  progressIntervalMs = DEFAULT_PROGRESS_INTERVAL_MS, isWorkActive = () => false,
  progress = elapsed => `Child process still running (${Math.floor(elapsed / 1000)}s).`,
  clock = timers,
} = {}) {
  const heartbeatMs = positiveInterval(heartbeatIntervalMs, DEFAULT_HEARTBEAT_INTERVAL_MS);
  const requestedProgressMs = positiveInterval(progressIntervalMs, DEFAULT_PROGRESS_INTERVAL_MS);
  if (requestedProgressMs > 120_000) throw new TypeError('progress interval must be at most two minutes');
  const progressMs = Math.min(requestedProgressMs,
    Math.max(1, Math.floor((handle.record.idleMs || 300_000) / 3)));
  const leaseMs = Number.isSafeInteger(handle.record.leaseMs) && handle.record.leaseMs > 0 ? handle.record.leaseMs : MIN_LEASE_MS;
  // A busy server gets more patience than one-shot commands; retries still end at lease expiry.
  const heartbeatTimeoutMs = Math.min(30_000, Math.max(5_000, Math.floor(leaseMs / 3)));
  const controller = new AbortController();
  const ready = deferred();
  const done = deferred();
  ready.promise.catch(() => {});
  const startedAt = clock.now();
  let shutdown;
  let reminderKey, reminderAt, reminderSequence = 0;
  // No lease renewed before this watcher started can outlive startedAt + leaseMs.
  let leaseRenewedAt = startedAt, leaseVerified = false, leaseTimer, lastTransientError, connectionSequence = 0;

  function stop(reason = 'idle', summary, error) {
    if (!REASONS.has(reason)) throw new TypeError('Invalid stop reason');
    if (!shutdown) {
      shutdown = { reason, summary, error };
      if (leaseTimer !== undefined) clock.clearTimeout(leaseTimer);
      leaseTimer = undefined;
      controller.abort();
    }
    return done.promise;
  }

  function leaseExpired() {
    leaseTimer = undefined;
    if (shutdown) return;
    const expiredAt = new Date(leaseRenewedAt + leaseMs).toISOString();
    const error = new Error(`Lease could not be renewed before it expired at ${expiredAt}`
      + `${lastTransientError ? ` (last error: ${lastTransientError.message})` : ''}.`
      + ' Stop writing; register again and re-check claims before resuming.', { cause: lastTransientError });
    error.code = 'LEASE_UNCONFIRMED';
    stop('failed', undefined, error);
  }

  // Only a confirmed heartbeat moves this deadline; transient failures never do.
  function watchLease() {
    if (shutdown) return;
    if (leaseTimer !== undefined) clock.clearTimeout(leaseTimer);
    leaseTimer = clock.setTimeout(leaseExpired, Math.max(0, leaseRenewedAt + leaseMs - clock.now()));
  }

  function renewLease(requestedAt) {
    if (shutdown || !handle.active) return;
    // The server renewed no earlier than the request started, so this deadline is conservative.
    leaseRenewedAt = Math.max(leaseRenewedAt, requestedAt);
    leaseVerified = true;
    lastTransientError = undefined;
    watchLease();
  }

  const onAbort = () => { stop('idle'); };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();

  async function publish() {
    if (controller.signal.aborted) return;
    await onSession(handle.session, controller.signal);
    if (!handle.active) stop('idle');
  }

  async function ping() {
    if (!handle.active || controller.signal.aborted) return;
    const requestedAt = clock.now();
    await handle.heartbeat(undefined, { signal: controller.signal, timeoutMs: heartbeatTimeoutMs });
    renewLease(requestedAt);
    await publish();
    await remindInbox();
    if (handle.session.status === 'waiting' && !controller.signal.aborted) {
      await handle.update({}, { signal: controller.signal });
      await publish();
      await remindInbox();
    }
  }

  async function remindInbox() {
    if (controller.signal.aborted || !handle.active) return;
    const inbox = handle.latestInbox;
    if (!inbox?.requiresCheck || (!(inbox.unreadCount > 0) && !inbox.checkFailed)) {
      reminderKey = undefined;
      reminderAt = undefined;
      return;
    }
    const messages = Array.isArray(inbox.messages) ? structuredClone(inbox.messages.slice(0, 20)) : [];
    const messageIds = [...new Set(messages.map(message => message?.id).filter(id => typeof id === 'string'))].sort();
    const key = JSON.stringify([messageIds, inbox.unreadCount, inbox.hasMore, inbox.checkFailed, inbox.error]);
    const now = clock.now();
    if (key === reminderKey && now - reminderAt < INBOX_REMINDER_INTERVAL_MS) return;
    // These reminders are local notifications, not server events or acknowledgements.
    reminderKey = key;
    reminderAt = now;
    await onEvent({
      id: `inbox:${handle.session.id}:${++reminderSequence}`, type: 'inbox.reminder',
      at: new Date(now).toISOString(), projectId: handle.session.projectId, synthetic: true,
      data: { sessionId: handle.session.id, agentId: handle.session.agentId,
        unreadCount: inbox.unreadCount, requiresCheck: inbox.requiresCheck,
        messageIds, messages, hasMore: inbox.checkFailed ? null : Boolean(inbox.hasMore),
        ...(inbox.checkFailed ? { checkFailed: true, error: inbox.error } : {}) },
    });
  }

  async function reportConnection(state, channel, failures, details = {}) {
    if (controller.signal.aborted) return;
    const now = clock.now(), expiresAt = leaseRenewedAt + leaseMs;
    // Local notifications, like inbox reminders: they neither come from nor renew the server lease.
    await onEvent({
      id: `connection:${handle.session.id}:${++connectionSequence}`, type: `connection.${state}`,
      at: new Date(now).toISOString(), projectId: handle.session.projectId, synthetic: true,
      data: { sessionId: handle.session.id, agentId: handle.session.agentId, channel, failures, ...details,
        leaseVerified, leaseExpiresAt: new Date(expiresAt).toISOString(), leaseRemainingMs: Math.max(0, expiresAt - now) },
    });
  }

  // Retry transient transport failures with backoff; the lease watchdog bounds the outage.
  async function retrying(channel, operation) {
    for (let failures = 0; ;) {
      try {
        await operation();
        if (failures) await reportConnection('recovered', channel, failures);
        return;
      } catch (error) {
        if (controller.signal.aborted || !isTransientError(error)) throw error;
        lastTransientError = error;
        failures += 1;
        const retryInMs = Math.min(RETRY_BASE_MS * 2 ** Math.min(failures - 1, 10), RETRY_MAX_MS);
        await reportConnection('retrying', channel, failures, { error: error.message, retryInMs });
        await pause(retryInMs, controller.signal, clock);
        if (controller.signal.aborted) return;
      }
    }
  }

  async function loop(interval, action) {
    while (!controller.signal.aborted) {
      await pause(interval, controller.signal, clock);
      if (!controller.signal.aborted) await action();
    }
  }

  async function listen() {
    while (!controller.signal.aborted) {
      let result;
      await retrying('events', async () => { result = await handle.events({ signal: controller.signal }); });
      if (!result || controller.signal.aborted) break;
      await publish();
      for (const event of result.events) {
        if (controller.signal.aborted) break;
        await onEvent(event);
      }
      // Also tolerate servers that return immediately on an empty poll.
      if (!controller.signal.aborted && result.events.length === 0) await pause(20, controller.signal, clock);
    }
  }

  async function activity() {
    if (isWorkActive() && handle.session.status === 'working') {
      await handle.update({ progress: progress(clock.now() - startedAt) }, { signal: controller.signal });
      await publish();
      await remindInbox();
    }
  }

  async function guard(operation) {
    try { await operation(); } catch (error) {
      if (!controller.signal.aborted) stop('failed', undefined, error);
    }
  }

  void (async () => {
    try {
      if (!controller.signal.aborted) {
        if (handle.active) watchLease();
        await retrying('heartbeat', ping);
        await publish();
      }
      if (shutdown?.error) ready.reject(shutdown.error);
      else ready.resolve(handle.session);
      if (!controller.signal.aborted) {
        await Promise.all([
          guard(() => loop(heartbeatMs, () => retrying('heartbeat', ping))), guard(listen),
          guard(() => loop(progressMs, () => retrying('progress', activity))),
        ]);
      }
    } catch (error) {
      if (!controller.signal.aborted) stop('failed', undefined, error);
      ready.reject(shutdown?.error || error);
    } finally {
      if (!shutdown) stop('idle');
      signal?.removeEventListener('abort', onAbort);
      let error = shutdown.error;
      try {
        // Stop work before releasing its claims, including on transport failure.
        await onStopping(shutdown.reason);
        if (handle.active) await handle.leave(shutdown.reason, shutdown.summary);
      } catch (cleanupError) {
        error ||= cleanupError;
      }
      done.resolve({ session: handle.session, reason: shutdown.reason, error });
    }
  })();
  return { ready: ready.promise, done: done.promise, stop };
}

function hasClaims(session, expectedFiles) {
  return session.status === 'working' && Array.isArray(session.claimedFiles)
    && expectedFiles.every(file => session.claimedFiles.includes(file));
}

export async function runSession(handle, command, args = [], {
  signal, spawnImpl = spawn, clock = timers, killGraceMs = 5_000,
  onEvent, onSession = () => {}, heartbeatIntervalMs, progressIntervalMs, summary,
} = {}) {
  requiredString(command, 'command');
  const expectedFiles = filesArray(handle.session.files);
  const exit = deferred();
  let child, childAlive = false, childResult, launched = false, launchError;
  let killPromise;
  let watcher;

  function stopChild() {
    if (!childAlive) return Promise.resolve();
    if (killPromise) return killPromise;
    killPromise = (async () => {
      child.kill('SIGTERM');
      const killController = new AbortController();
      const first = await Promise.race([
        exit.promise.then(() => 'exit'), pause(killGraceMs, killController.signal, clock).then(() => 'timeout'),
      ]);
      killController.abort();
      if (first === 'timeout' && childAlive) {
        child.kill('SIGKILL');
        const forceController = new AbortController();
        const final = await Promise.race([
          exit.promise.then(() => 'exit'), pause(killGraceMs, forceController.signal, clock).then(() => 'timeout'),
        ]);
        forceController.abort();
        if (final === 'timeout' && childAlive) throw new Error('Child did not stop; claims were not voluntarily released');
      }
    })();
    return killPromise;
  }

  async function observe(session, watchSignal) {
    await onSession(session);
    if (childAlive && !hasClaims(session, expectedFiles)) throw new Error('Current working write claim was lost; stopping child');
    if (launched || session.status !== 'working' || watchSignal.aborted) return;
    // Revalidate the server's current lease immediately before launching work.
    await handle.heartbeat('working', { signal: watchSignal });
    if (watchSignal.aborted || handle.session.status !== 'working') return;
    if (!hasClaims(handle.session, expectedFiles)) throw new Error('Current working write claim was not confirmed; child was not started');
    launched = true;
    try {
      child = spawnImpl(command, args, { stdio: 'inherit', shell: false });
      childAlive = true;
      const finish = result => {
        if (!childAlive) return;
        childAlive = false;
        childResult = result;
        exit.resolve(result);
        void watcher?.stop(result.code === 0 && !result.error ? 'completed' : 'failed', summary);
      };
      child.once('exit', (code, exitSignal) => finish({ code, signal: exitSignal }));
      child.once('error', error => finish({ code: 1, error }));
    } catch (error) {
      launchError = error;
      childResult = { code: 1, error };
      exit.resolve(childResult);
      throw error;
    }
  }

  watcher = startWatching(handle, {
    signal, clock, onEvent, onSession: observe, onStopping: stopChild,
    heartbeatIntervalMs, progressIntervalMs, isWorkActive: () => childAlive,
  });
  try { await watcher.ready; } catch { /* The final result includes initialization failures and cleanup. */ }
  if (childResult) void watcher.stop(childResult.code === 0 && !childResult.error ? 'completed' : 'failed', summary);
  const result = await watcher.done;
  return {
    ...result, child: childResult,
    error: result.error || childResult?.error || launchError,
    exitCode: result.error || childResult?.error || launchError ? 1
      : signal?.aborted && result.reason === 'idle' ? 130
        : !launched ? 1 : (childResult?.code ?? 1),
  };
}

export function publicResult(value) {
  if (Array.isArray(value)) return value.map(publicResult);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'token').map(([key, item]) => [key, publicResult(item)]));
  }
  return value;
}
