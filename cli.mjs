#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import {readFile} from 'node:fs/promises';
import {
  CoordinatorClient, CredentialStore, SessionClient, registerSession,
  runSession, startWatching, publicResult,
} from './lib/client.mjs';

const HELP = `Agent coordinator CLI (no project-administration commands)

  projects [--base URL]
  sessions --agent ACTUAL_ID [--project ID]
  snapshot --session ID
  join --project ID --agent ACTUAL_ID --task TEXT [--file PATH ... | --files JSON] [--watch]
  watch --session ID
  heartbeat --session ID [--state working|waiting|idle]
  update --session ID [--task TEXT] [--file PATH ... | --files JSON] [--progress TEXT]
  send --session ID --to ACTUAL_ID --text TEXT [--kind KIND]
  note --session ID --title TEXT --text TEXT [--tag TAG ... | --tags JSON]
  notes --session ID [--search TEXT]
  roadmap --session ID
  roadmap-claim --session ID --revision NUMBER
  roadmap-write --session ID --revision NUMBER --html-file PATH
  inbox --session ID [--ack MESSAGE_ID ...]
  done --session ID [--summary TEXT]
  leave --session ID [--reason completed|idle|failed|cancelled] [--summary TEXT]
  run --project ID --agent ACTUAL_ID --task TEXT [--file PATH ... | --files JSON] [--summary TEXT] -- EXECUTABLE [ARG ...]

  --base URL           Default: http://127.0.0.1:8793; session commands use stored URL
  AGENT_COORD_DATA      Server data root; credentials go in its clients subdirectory
  AGENT_COORD_CLIENT_DATA  Optional credential-directory override
                         Default: coordinator/.data/clients
  --files '[]'          Explicitly clear claims / register read-only work
  --file 'a,b.txt'      A comma is part of the filename, never a separator
  sessions             Local metadata only; stored status is not a verified lease
  heartbeat            Prints lease and optional unread inbox summary; does not acknowledge
  watch                Background output does not guarantee delivery into a model context
                       Retries timeouts/network/5xx until the last confirmed lease expires
  help | --help        Print this help
`;

const ALLOWED = {
  projects: ['base'], sessions: ['agent', 'project'], snapshot: ['base', 'session'],
  join: ['base', 'project', 'agent', 'task', 'file', 'files', 'watch'],
  watch: ['base', 'session'], update: ['base', 'session', 'task', 'file', 'files', 'progress'],
  heartbeat: ['base', 'session', 'state'],
  send: ['base', 'session', 'to', 'text', 'kind'], note: ['base', 'session', 'title', 'text', 'tag', 'tags'],
  notes: ['base', 'session', 'search'],
  roadmap: ['base','session'], 'roadmap-claim':['base','session','revision'], 'roadmap-write':['base','session','revision','html-file'],
  inbox: ['base', 'session', 'ack'], done: ['base', 'session', 'summary'],
  leave: ['base', 'session', 'reason', 'summary'],
  run: ['base', 'project', 'agent', 'task', 'file', 'files', 'summary'],
};
const REPEAT = new Set(['file', 'tag', 'ack']);

export function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const separator = rest.indexOf('--');
  if (command === 'help' || command === '--help' || rest.slice(0, separator < 0 ? rest.length : separator).includes('--help')) return { command: 'help', options: {}, child: [] };
  if (!Object.hasOwn(ALLOWED, command)) throw new Error(`Unknown command: ${command}`);
  const options = {};
  let child = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--') {
      if (command !== 'run') throw new Error('-- EXECUTABLE is only supported by run');
      child = rest.slice(i + 1);
      break;
    }
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument: ${arg}`);
    const equal = arg.indexOf('=');
    const key = arg.slice(2, equal < 0 ? undefined : equal);
    if (!ALLOWED[command].includes(key)) throw new Error(`Unknown option for ${command}: --${key}`);
    if (key === 'watch') {
      if (equal >= 0 || Object.hasOwn(options, key)) throw new Error('--watch is a single boolean flag');
      options.watch = true;
      continue;
    }
    let value;
    if (equal >= 0) value = arg.slice(equal + 1);
    else {
      value = rest[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`--${key} requires a value (use --${key}=VALUE for values starting with --)`);
    }
    if (!value.trim()) throw new Error(`--${key} requires a nonempty value`);
    if (REPEAT.has(key)) (options[key] ||= []).push(value);
    else {
      if (Object.hasOwn(options, key)) throw new Error(`--${key} may only be supplied once`);
      options[key] = value;
    }
  }
  if (command === 'run' && child.length === 0) throw new Error('run requires -- EXECUTABLE [ARG ...]');
  return { command, options, child };
}

function required(options, key) {
  if (!options[key]) throw new Error(`--${key} is required`);
  return options[key];
}

function stringList(options, repeated, json) {
  if (options[repeated] && options[json]) throw new Error(`Use --${repeated} or --${json}, not both`);
  if (options[repeated]) return options[repeated];
  if (!Object.hasOwn(options, json)) return undefined;
  let value;
  try { value = JSON.parse(options[json]); } catch { throw new Error(`--${json} must be a JSON array, not a comma-separated list`); }
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) throw new Error(`--${json} must be an array of nonempty strings`);
  return value;
}

// Watch output is JSON on stdout; transport retries are also summarized on stderr.
export function connectionWarning(event) {
  if (!event?.synthetic || !['connection.retrying', 'connection.recovered'].includes(event.type)) return '';
  const { channel, failures, error, retryInMs, leaseVerified, leaseRemainingMs } = event.data;
  if (event.type === 'connection.recovered') {
    return `Coordinator ${channel} request recovered after ${failures} failed attempt(s); lease renewal continues.`;
  }
  const lease = leaseVerified
    ? `last confirmed lease expires in ${Math.ceil(leaseRemainingMs / 1000)}s; claims are released if it cannot be renewed by then`
    : `lease not yet verified (gives up in ${Math.ceil(leaseRemainingMs / 1000)}s); do not start editing`;
  return `Coordinator ${channel} request failed (attempt ${failures}): ${error}. Retrying in ${Math.ceil(retryInMs / 1000)}s; ${lease}.`;
}

export function installShutdownSignals(processLike, controller) {
  const stop = () => { if (!controller.signal.aborted) controller.abort(); };
  processLike.on('SIGINT', stop);
  processLike.on('SIGTERM', stop);
  return () => {
    processLike.removeListener('SIGINT', stop);
    processLike.removeListener('SIGTERM', stop);
  };
}

export async function main(argv = process.argv.slice(2), {
  stdout = process.stdout, stderr = process.stderr, processLike = process,
  store = new CredentialStore(), fetchImpl = globalThis.fetch, spawnImpl, clock,
  heartbeatIntervalMs, progressIntervalMs,
} = {}) {
  const write = value => stdout.write(`${JSON.stringify(publicResult(value), null, 2)}\n`);
  try {
    const { command, options, child } = parseArgs(argv);
    if (command === 'help') { stdout.write(HELP); return 0; }
    if (command === 'sessions') {
      write({ source: 'local', statusSource: 'stored', sessions: await store.list({ agentId: required(options, 'agent'), projectId: options.project }) });
      return 0;
    }
    const files = stringList(options, 'file', 'files');
    const tags = stringList(options, 'tag', 'tags');
    const client = new CoordinatorClient({ baseUrl: options.base, fetchImpl });
    if (command === 'projects') { write(await client.projects()); return 0; }

    let handle;
    let controller;
    let removeSignals;
    const managed = command === 'watch' || command === 'run' || (command === 'join' && options.watch);
    // Catch interrupts during registration too, so a newly acquired claim is not stranded.
    if (managed) {
      controller = new AbortController();
      removeSignals = installShutdownSignals(processLike, controller);
    }
    try {
      if (command === 'join' || command === 'run') {
        handle = await registerSession(client, store, {
          projectId: required(options, 'project'), agentId: required(options, 'agent'),
          task: required(options, 'task'), files: files ?? [],
        });
        write({ session: handle.session, cursor: handle.cursor, heartbeatIntervalMs: handle.record.heartbeatIntervalMs, leaseMs: handle.record.leaseMs, idleMs: handle.record.idleMs });
      } else {
        const record = await store.load(required(options, 'session'));
        handle = new SessionClient({ store, record, client: new CoordinatorClient({ baseUrl: options.base || record.baseUrl, fetchImpl }) });
      }

      const monitorOptions = {
        signal: controller?.signal, clock, heartbeatIntervalMs, progressIntervalMs,
        onEvent: event => {
          write({ event });
          const warning = connectionWarning(event);
          if (warning) stderr.write(`${warning}\n`);
        },
        onSession: session => {
          const key = JSON.stringify([session.status, session.files, session.conflicts]);
          if (key !== lastSession) { lastSession = key; write({ session }); }
        },
      };
      let lastSession;
      if (command === 'run') {
        const result = await runSession(handle, child[0], child.slice(1), { ...monitorOptions, spawnImpl, summary: options.summary });
        write({ session: result.session, reason: result.reason, child: result.child && { code: result.child.code, signal: result.child.signal } });
        if (result.error) throw result.error;
        return result.exitCode;
      }
      if (command === 'watch' || (command === 'join' && options.watch)) {
        const watcher = startWatching(handle, monitorOptions);
        try { await watcher.ready; } catch { /* Report the final, cleaned-up result below. */ }
        const result = await watcher.done;
        write({ session: result.session, reason: result.reason });
        if (result.error) throw result.error;
        return controller.signal.aborted ? 130 : 0;
      }
      if (command === 'join') return 0;
      if (command === 'snapshot') {
        write(await handle.snapshot());
      } else if(command==='roadmap'){
        write(await handle.roadmap());
      } else if(command==='roadmap-claim'||command==='roadmap-write'){
        const revision=Number(required(options,'revision'));
        if(!/^\d+$/.test(options.revision)||!Number.isSafeInteger(revision))throw Error('revision must be a nonnegative integer');
        if(command==='roadmap-claim')write(await handle.claimRoadmap(revision));
        else write(await handle.writeRoadmap(await readFile(required(options,'html-file'),'utf8'),revision));
      } else if (command === 'notes') {
        write(await handle.notes(options.search));
      } else if (command === 'heartbeat') {
        write(await handle.heartbeat(options.state));
      } else if (command === 'update') {
        const patch = {};
        for (const key of ['task', 'progress']) if (options[key] !== undefined) patch[key] = options[key];
        if (files !== undefined) patch.files = files;
        write(await handle.update(patch));
      } else if (command === 'send') {
        write(await handle.send({ toAgentId: required(options, 'to'), text: required(options, 'text'), kind: options.kind }));
      } else if (command === 'note') {
        write(await handle.note({ title: required(options, 'title'), text: required(options, 'text'), tags }));
      } else if (command === 'inbox') {
        if (options.ack) write({ acknowledgement: await handle.ack(options.ack) });
        write(await handle.inbox());
      } else if (command === 'done' || command === 'leave') {
        write(await handle.leave(command === 'done' ? 'completed' : (options.reason || 'cancelled'), options.summary));
      }
      return 0;
    } finally {
      removeSignals?.();
    }
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
