// An MCP server that hands an AI agent a shell inside the dev server pod.
//
// This is the far end of the loop the rest of this project builds. MetaExtension puts
// DevExtension's dev server in the cluster and points Rancher's dashboard at it, so an edit
// to /app hot-reloads into the running instance. Rancher's own MCP server cannot make that
// edit - it has 33 tools and not one of them reaches into a container - so the pod exposes
// its own, and Rancher's AI assistant is pointed at it with an AIAgentConfig.
//
// What that means in practice: a tool call here edits code that is, seconds later, running
// in the browser of whoever is looking at this Rancher. That is the whole point, and it is
// also the entire risk. Access is gated by the AIAgentConfig, which MetaExtension creates
// and deletes on request - deleting it is what revokes this, not stopping the pod.
//
// The interface is a shell, not a set of file operations. There were readFile/writeFile/
// listFiles tools here and they were removed: an agent with `sed`, `grep`, `find`, `git` and
// heredocs can do everything they did and a great deal they could not, and a narrow toolset
// mostly succeeds at teaching the model that it is working in a sandbox rather than a pod.
// `exec` is an unrestricted shell as the pod's user, which is the honest description of it.
//
// Protocol: MCP over streamable HTTP. Hand-rolled rather than pulled from npm, because the
// pod installs its dependencies from the seeded package.json and adding one to it would
// rebuild node_modules on a tree that exists to be edited live.
import http from 'http';
import https from 'https';
import fs from 'fs';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';

const HTTP_PORT = Number(process.env.MCP_HTTP_PORT || 8006);
const HTTPS_PORT = Number(process.env.MCP_HTTPS_PORT || 8443);
const TLS_DIR = process.env.MCP_TLS_DIR || '/app/.mcp-tls';
const APP_DIR = process.env.MCP_APP_DIR || '/app';
const DEV_SERVER = process.env.MCP_DEV_SERVER || 'http://localhost:8005';

/** Enough to be useful in a transcript, small enough not to blow the agent's context. */
const MAX_OUTPUT = 60000;
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TIMEOUT_MS = 600000;

const log = (...args) => console.log(new Date().toISOString(), ...args); // eslint-disable-line no-console

function truncate(text) {
  if (text.length <= MAX_OUTPUT) {
    return text;
  }

  return `${ text.slice(0, MAX_OUTPUT) }\n\n[... truncated, ${ text.length - MAX_OUTPUT } more characters]`;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name:        'exec',
    description: [
      'Run a shell command inside the dev server pod and return its combined output and exit code.',
      '',
      'This is a real, unrestricted shell (`/bin/sh -c`) with the pod\'s whole toolchain: node, yarn,',
      'npm, git, openssl, sed, grep, find, curl and the usual coreutils. Anything you would type at a',
      'terminal works, including pipes, redirection, heredocs (`cat > file <<\'EOF\'` ... `EOF`, quoted',
      'so nothing is interpolated), chained commands and multi-line scripts.',
      '',
      'The working directory defaults to /app, the live DevExtension tree. /app/pkg/dev-extension is',
      'the extension; /app/node_modules/@rancher/shell is the Rancher dashboard itself, and it is',
      'watched too, so core pages like pages/auth/login.vue are as editable as the extension.',
      'Changing a file triggers a rebuild and hot-reloads it into the running Rancher.'
    ].join('\n'),
    inputSchema: {
      type:       'object',
      properties: {
        command:   { type: 'string', description: 'The shell command to run. Multi-line scripts and heredocs are fine.' },
        cwd:       { type: 'string', description: 'Working directory. Defaults to /app.' },
        timeoutMs: {
          type: 'number', description: `Kill the command after this long. Default ${ DEFAULT_TIMEOUT_MS }, max ${ MAX_TIMEOUT_MS }.`
        }
      },
      required: ['command']
    }
  },
  {
    name:        'devServerStatus',
    description: 'Report whether the dev server has compiled cleanly since the last edit, plus the tail of its log. Call this after writing a file: a compile error means the change did NOT reach the browser, and the log says why.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name:        'buildExtension',
    description: 'Start a production UMD build of DevExtension. Only needed when the dev loop is running with HMR off, where Rancher loads the extension from that built bundle rather than live. Returns as soon as the build starts; call devServerStatus or read the build state to see the outcome.',
    inputSchema: { type: 'object', properties: {} }
  }
];

function runShell(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const limit = Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const child = spawn('/bin/sh', ['-c', command], { cwd: cwd || APP_DIR, env: process.env });

    let out = '';
    let killed = false;
    const capture = (chunk) => {
      out += chunk;
      // Bound memory as well as the reply: a runaway command can produce gigabytes.
      if (out.length > MAX_OUTPUT * 4) {
        out = out.slice(0, MAX_OUTPUT * 4);
      }
    };

    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, limit);

    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ text: `failed to start: ${ e.message }`, isError: true });
    });

    child.on('close', (code) => {
      clearTimeout(timer);

      const status = killed ? `timed out after ${ limit }ms and was killed` : `exit code ${ code }`;

      resolve({ text: `${ truncate(out) }\n\n[${ status }]`, isError: killed || code !== 0 });
    });
  });
}

async function devServerJson(urlPath, method = 'GET') {
  const res = await fetch(`${ DEV_SERVER }${ urlPath }`, { method });

  if (!res.ok) {
    throw new Error(`dev server returned ${ res.status } for ${ urlPath }`);
  }

  return res.json();
}

async function callTool(name, args = {}) {
  switch (name) {
  case 'exec':
    if (!args.command) {
      return { text: 'command is required', isError: true };
    }

    log('exec:', String(args.command).slice(0, 200));

    return runShell(args.command, args.cwd, args.timeoutMs);

  case 'devServerStatus':
    try {
      const state = await devServerJson('/__dev/state');
      const compile = state.compile || {};
      const age = compile.at ? `${ Math.round((Date.now() - compile.at) / 1000) }s ago` : 'never';

      return {
        text: [
          `last compile : ${ compile.ok ? 'OK' : 'FAILED' } (${ age }, hash ${ compile.hash })`,
          ...(compile.errors?.length ? ['', 'compile errors:', ...compile.errors] : []),
          '',
          `UMD build    : ${ JSON.stringify(state.build) }`,
          `page headline: ${ state.headline }`,
          `nav visible  : ${ state.navVisible }`
        ].join('\n'),
        // A failed compile means the edit did not reach the browser. Reporting that as an
        // error is what stops an agent concluding its change landed when it did not.
        isError: compile.ok === false
      };
    } catch (e) {
      return { text: `could not reach the dev server: ${ e.message }`, isError: true };
    }

  case 'buildExtension':
    try {
      const state = await devServerJson('/__dev/build', 'POST');

      return { text: `build started: ${ JSON.stringify(state.build) }` };
    } catch (e) {
      return { text: `could not start a build: ${ e.message }`, isError: true };
    }

  default:
    return { text: `unknown tool ${ name }`, isError: true };
  }
}

// ---------------------------------------------------------------------------
// MCP over streamable HTTP
// ---------------------------------------------------------------------------

const sessions = new Set();

async function handleRpc(msg) {
  const { id, method, params } = msg;
  const reply = (result) => ({ jsonrpc: '2.0', id, result });

  switch (method) {
  case 'initialize':
    return reply({
      // Echo the client's version rather than asserting our own: this server implements the
      // handful of methods every revision shares, and refusing on a version mismatch would
      // be a lie about what is actually incompatible.
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities:    { tools: { listChanged: false } },
      serverInfo:      { name: 'devserver pod shell', version: '1.0.0' }
    });

  case 'ping':
    return reply({});

  case 'tools/list':
    return reply({ tools: TOOLS });

  case 'tools/call': {
    const { text, isError } = await callTool(params?.name, params?.arguments || {});

    // A failed tool is reported through isError, not a JSON-RPC error: the agent is supposed
    // to read the message and try something else, and a protocol-level error ends the turn.
    return reply({ content: [{ type: 'text', text }], isError: !!isError });
  }

  default:
    return {
      jsonrpc: '2.0', id, error: { code: -32601, message: `method "${ method }" is not supported` }
    };
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

/**
 * Answer in whichever framing the client asked for.
 *
 * Streamable-HTTP clients send `Accept: application/json, text/event-stream` and expect a
 * single SSE-framed message back; plainer clients want JSON. Rancher's own MCP server
 * answers SSE, so that is the branch that matters here, but honouring the header costs
 * nothing and makes the server testable with curl.
 */
function respond(req, res, payload, extraHeaders = {}) {
  const accept = req.headers.accept || '';
  const body = JSON.stringify(payload);

  if (accept.includes('text/event-stream')) {
    return send(res, 200, `event: message\ndata: ${ body }\n\n`, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', ...extraHeaders
    });
  }

  send(res, 200, body, { 'Content-Type': 'application/json', ...extraHeaders });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';

    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://placeholder');

  if (req.method === 'GET' && url.pathname === '/healthz') {
    return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });
  }

  // The self-signed certificate this server presents, so MetaExtension can copy it into the
  // Secret the agent's caBundleRef points at. Public half only - the key never leaves /app.
  if (req.method === 'GET' && url.pathname === '/ca.pem') {
    try {
      return send(res, 200, fs.readFileSync(`${ TLS_DIR }/cert.pem`), { 'Content-Type': 'application/x-pem-file' });
    } catch (e) {
      return send(res, 503, 'no certificate has been generated', { 'Content-Type': 'text/plain' });
    }
  }

  if (req.method !== 'POST') {
    return send(res, 405, 'method not allowed', { 'Content-Type': 'text/plain' });
  }

  let msg;

  try {
    msg = JSON.parse(await readBody(req));
  } catch (e) {
    return respond(req, res, {
      jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' }
    });
  }

  // Notifications have no id and take no reply. `notifications/initialized` is the common
  // one; answering it with a JSON-RPC response confuses clients that are not expecting one.
  if (msg.id === undefined || msg.id === null) {
    return send(res, 202, '');
  }

  const extra = {};

  if (msg.method === 'initialize') {
    const sessionId = randomUUID();

    sessions.add(sessionId);
    extra['Mcp-Session-Id'] = sessionId;
    log('session opened', sessionId, 'client', JSON.stringify(msg.params?.clientInfo || {}));
  }

  try {
    respond(req, res, await handleRpc(msg), extra);
  } catch (e) {
    log('handler failed', e);
    respond(req, res, {
      jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message }
    });
  }
}

http.createServer(handler).listen(HTTP_PORT, '0.0.0.0', () => log(`mcp http on ${ HTTP_PORT }`));

// TLS is optional so the server still comes up if certificate generation failed - better a
// working http endpoint and a loud log line than a pod that refuses to start. The agent may
// use either scheme: mcpURL is a bare host, so which one it picks is its choice, not ours.
try {
  const key = fs.readFileSync(`${ TLS_DIR }/key.pem`);
  const cert = fs.readFileSync(`${ TLS_DIR }/cert.pem`);

  https.createServer({ key, cert }, handler).listen(HTTPS_PORT, '0.0.0.0', () => log(`mcp https on ${ HTTPS_PORT }`));
} catch (e) {
  log(`no TLS certificate in ${ TLS_DIR }, serving http only:`, e.message);
}
