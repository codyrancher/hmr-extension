// Bakes the DevExtension source into MetaExtension as a seed.
//
// MetaExtension has to be able to bring up a working dev server from a single click, which
// means the pod needs source before anything has synced to it. Generating the seed from the
// real tree keeps one source of truth - the alternative is a hand-copied duplicate that
// silently rots.
import fs from 'fs';
import path from 'path';

const APP = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(APP, 'pkg/meta-extension/lib/seed.generated.ts');

// The app skeleton the dev server needs, plus the extension itself. meta-extension is
// deliberately absent: it is installed as a UIPlugin, never compiled into the dev build.
const ROOT_FILES = ['package.json', 'babel.config.js', 'tsconfig.json'];
const PKG_DIR = 'pkg/dev-extension';

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(path.join(APP, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      walk(rel, acc);
    } else {
      acc.push(rel);
    }
  }

  return acc;
}

const files = {};

for (const f of ROOT_FILES) {
  if (fs.existsSync(path.join(APP, f))) {
    files[f] = fs.readFileSync(path.join(APP, f), 'utf8');
  }
}

for (const f of walk(PKG_DIR)) {
  files[f] = fs.readFileSync(path.join(APP, f), 'utf8');
}

/**
 * Read `export const NAME = 'value';` out of a TypeScript source file.
 *
 * Deliberately only handles that one shape. An earlier version of this lifted a whole
 * multi-line template literal out of manifests.ts with a regex, which silently left `\\`
 * and `${ ... }` unresolved and crashlooped the pod. Matching a single-line string literal
 * either works or throws.
 */
function tsConstant(file, name) {
  const src = fs.readFileSync(path.join(APP, file), 'utf8');
  const match = src.match(new RegExp(`export const ${ name } = '([^']*)';`));

  if (!match) {
    throw new Error(`could not find "export const ${ name }" in ${ file }`);
  }

  return match[1];
}

const SUBSTITUTIONS = {
  __PATH_SEPARATOR__: tsConstant('pkg/meta-extension/lib/manifests.ts', 'PATH_SEPARATOR'),
  __MCP_SERVICE__:    tsConstant('pkg/meta-extension/config/constants.ts', 'MCP_SERVICE'),
  __DEV_NAMESPACE__:  tsConstant('pkg/meta-extension/config/constants.ts', 'DEV_NAMESPACE')
};

// Files that run *in* the pod rather than being part of the extension. Real files in the
// repo, not template strings in this script: they are long enough to deserve linting and a
// syntax highlighter, and one of them is a shell script whose escaping has already bitten
// once. Only the __TOKENS__ above are substituted, so what is in the repo is what runs.
for (const f of fs.readdirSync(path.join(APP, 'pod'))) {
  let contents = fs.readFileSync(path.join(APP, 'pod', f), 'utf8');

  for (const [token, value] of Object.entries(SUBSTITUTIONS)) {
    contents = contents.split(token).join(value);
  }

  if (contents.includes('__') && /__[A-Z_]+__/.test(contents)) {
    throw new Error(`${ f } still has an unsubstituted token: ${ contents.match(/__[A-Z_]+__/)[0] }`);
  }

  files[f] = contents;
}

// The dev server's vue.config.js is generated rather than copied: the pod addresses itself
// through the apiserver proxy, which the container-hosted version had no notion of.
files['vue.config.js'] = `const config = require('@rancher/shell/vue.config');

// Nothing here is configured by hand. DEV_PROXY_PATH is derived by MetaExtension from
// constants it already knows, and everything else is inferred from the browser's location,
// so this build has no idea what hostname Rancher is served on and does not need one.
const proxyPath = process.env.DEV_PROXY_PATH;
const assetBase = process.env.DEV_ASSET_BASE;
const assetDir = process.env.DEV_ASSET_DIR;

if (!proxyPath || !assetBase || !assetDir) {
  throw new Error('DEV_PROXY_PATH, DEV_ASSET_BASE and DEV_ASSET_DIR must be set');
}

const fs = require('fs');

const base = config(__dirname, { excludes: [] });
const previousSetupMiddlewares = base.devServer && base.devServer.setupMiddlewares;

// Assets are addressed at Rancher's unauthenticated static path, NOT the apiserver proxy.
// The proxy demands a Rancher session, and the login page is the dashboard SPA itself, so
// proxied assets would 401 for exactly the users who cannot log in yet.
base.publicPath = \`\${ assetBase }/\`;
base.outputDir = assetDir;

// Files the demo toggles edit. Editing them is what triggers a rebuild, so the toggles are
// deliberately plain file edits rather than runtime state: they exercise the same path a
// person typing in the pod would.
const HOME_PAGE = '/app/pkg/dev-extension/pages/DevHome.vue';
const PRODUCT = '/app/pkg/dev-extension/product.ts';
const LOGIN_PAGE = '/app/node_modules/@rancher/shell/pages/auth/login.vue';

const HELLO_MARKER = 'HELLO-TOGGLE';
const HELLO_LINE = '        <span style="display:block;text-align:center;font-weight:bold;font-size:24px">HELLO</span> <!--' + HELLO_MARKER + '-->';
const LOGIN_ANCHOR = '        <h1 class="text-center login-welcome">';

const read = (f) => fs.readFileSync(f, 'utf8');
const write = (f, s) => fs.writeFileSync(f, s);

// ---------------------------------------------------------------------------
// Building the extension the ordinary way, from inside the pod.
//
// Hot reload is expensive to leave running: it puts an unminified dev build of the entire
// dashboard in front of every page, and holds a websocket open from every tab. Most of the
// time what you actually want is the extension loaded the way Rancher loads any extension -
// from a built UMD bundle - and hot reload only while you are editing. So the pod also
// produces that bundle, and MetaExtension points a UIPlugin at it.
//
// The build is debounced rather than run per compile: it takes far longer than an
// incremental rebuild, and firing one per keystroke would keep a CPU busy for nothing.
// Waiting for the tree to go quiet means you get a bundle that reflects a finished edit.
// ---------------------------------------------------------------------------
const { spawn } = require('child_process');
const path = require('path');

const PKG_NAME = 'dev-extension';
const APP_DIR = '/app';
const PLUGIN_ROOT = '/app/.plugin-root';
const BUILD_STATE_FILE = '/app/.build-state.json';

/** How long the tree has to stay unchanged before an automatic build starts. */
const IDLE_MS = 5 * 60 * 1000;

let building = false;
let buildTimer = null;
let idleSince = null;
let buildState = { status: 'never' };

try {
  buildState = JSON.parse(read(BUILD_STATE_FILE));
} catch (e) {
  // No build has ever run in this tree. 'never' is the honest answer.
}

function setBuildState(next) {
  buildState = next;
  try {
    write(BUILD_STATE_FILE, JSON.stringify(next));
  } catch (e) {
    console.error('failed to record build state', e); // eslint-disable-line no-console
  }
}

/**
 * Lay the built package out the way Rancher's plugin controller expects to find it: a
 * files.txt listing every relative path, and those paths under plugin/. Copied out of
 * dist-pkg rather than served from it so a half-finished build can never be downloaded.
 */
function layoutPluginRoot() {
  const version = JSON.parse(read(\`\${ APP_DIR }/pkg/\${ PKG_NAME }/package.json\`)).version;
  const dist = \`\${ APP_DIR }/dist-pkg/\${ PKG_NAME }-\${ version }\`;

  if (!fs.existsSync(dist)) {
    throw new Error(\`the build produced no output at \${ dist }\`);
  }

  fs.rmSync(PLUGIN_ROOT, { recursive: true, force: true });
  fs.mkdirSync(\`\${ PLUGIN_ROOT }/plugin\`, { recursive: true });
  fs.cpSync(dist, \`\${ PLUGIN_ROOT }/plugin\`, { recursive: true });

  const found = [];

  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = \`\${ dir }/\${ entry.name }\`;

      if (entry.isDirectory()) {
        walk(full);
      } else {
        found.push(full.slice(PLUGIN_ROOT.length + 1));
      }
    }
  })(\`\${ PLUGIN_ROOT }/plugin\`);

  write(\`\${ PLUGIN_ROOT }/files.txt\`, \`\${ found.sort().join('\\n') }\\n\`);

  return version;
}

function runBuild(trigger) {
  if (building) {
    return Promise.resolve(buildState);
  }

  building = true;
  clearTimeout(buildTimer);
  buildTimer = null;
  idleSince = null;

  const startedAt = Date.now();

  // The previous run's fields are cleared rather than carried over: leaving finishedAt in
  // place puts an end time earlier than the start time on a build that is still running.
  setBuildState({
    status: 'building', trigger, startedAt, version: buildState.version
  });

  return new Promise((resolve) => {
    const child = spawn('./node_modules/@rancher/shell/scripts/build-pkg.sh', [PKG_NAME], {
      cwd: APP_DIR,
      env: {
        ...process.env, NODE_ENV: 'production', NODE_OPTIONS: '--max_old_space_size=4096'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // Only the tail is kept. A failed build's last few lines are what says why; the rest is
    // progress output nobody reads out of a JSON field.
    let tail = '';
    const capture = (chunk) => {
      tail = (tail + chunk).slice(-4000);
    };

    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    child.on('close', (code) => {
      building = false;

      const finishedAt = Date.now();
      const durationMs = finishedAt - startedAt;

      if (code === 0) {
        try {
          setBuildState({
            status: 'ok', trigger, startedAt, finishedAt, durationMs, version: layoutPluginRoot()
          });
        } catch (e) {
          setBuildState({
            status: 'failed', trigger, startedAt, finishedAt, durationMs, error: e.message
          });
        }
      } else {
        setBuildState({
          status:     'failed',
          trigger,
          startedAt,
          finishedAt,
          durationMs,
          // Stack frames are dropped. A failed extension build ends in a stack from inside
          // webpack, and keeping the last few lines verbatim reports that instead of the
          // compiler error above it - which is the only part that says what to fix.
          error:      tail
            .split('\\n')
            .map((l) => l.replace(/\\s+$/, ''))
            .filter((l) => l && !/^\\s+at /.test(l))
            .slice(-6)
            .join(' | ') || \`build-pkg exited \${ code }\`
        });
      }

      resolve(buildState);
    });

    child.on('error', (e) => {
      building = false;
      setBuildState({
        status: 'failed', trigger, startedAt, finishedAt: Date.now(), error: e.message
      });
      resolve(buildState);
    });
  });
}

/** Restart the quiet period. Called on every compile, so the timer only fires once edits stop. */
function scheduleAutoBuild() {
  clearTimeout(buildTimer);
  idleSince = Date.now();
  buildTimer = setTimeout(() => runBuild('auto'), IDLE_MS);
}

function buildStatus() {
  return {
    ...buildState,
    building,
    idleMs:       IDLE_MS,
    // Null when no build is queued, so the page can say "building" rather than count down.
    autoBuildInMs: buildTimer ? Math.max(0, IDLE_MS - (Date.now() - idleSince)) : null
  };
}

const PLUGIN_TYPES = {
  '.js': 'application/javascript', '.json': 'application/json', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.txt': 'text/plain', '.html': 'text/html'
};

/**
 * Serve the built package to Rancher's plugin controller.
 *
 * The controller downloads server-side from the Service's ClusterIP, so this never has to be
 * reachable from a browser - Rancher re-serves the files from its own origin afterwards.
 */
function servePluginFile(req, res, next) {
  const rel = decodeURIComponent(req.path).replace(/^\\/+/, '');
  const file = path.join(PLUGIN_ROOT, rel);

  if (!file.startsWith(\`\${ PLUGIN_ROOT }/\`) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return next();
  }

  res.setHeader('Content-Type', PLUGIN_TYPES[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
}

// Set on every compile. Also what index.html's asset URLs are stamped with, so the browser
// is never handed a cached bundle from an earlier build.
let currentHash = 'boot';

// The outcome of that compile, reported over /__dev/state. An agent editing files in this
// pod otherwise has no way to tell a change that hot-reloaded from one that failed to
// compile - the browser simply keeps running the last good bundle, silently.
let lastCompile = { hash: 'boot', ok: null, errors: [] };

/**
 * Serve index.html with the current build stamped onto its asset URLs.
 *
 * Rancher serves /dashboard/ with a one-year Cache-Control and these bundles have fixed
 * names, so without a changing query the browser keeps the first index.js it ever saw. Doing
 * this at build time does not work: html-webpack-plugin only regenerates index.html on the
 * initial build, so an incremental rebuild leaves the old token in place. Rewriting per
 * request is the only point where the current hash is reliably known.
 *
 * A stale bundle is not a cosmetic problem. The page comes back running an old build, and
 * the HMR client then tries to walk it forward from a hash whose update chunks were
 * overwritten builds ago - so it gives up and full-reloads, straight back onto the same
 * cached bundle. Kept even though the build stamp it was written alongside is gone: it costs
 * one string replace per index request and no polling at all.
 */
function indexMiddleware(req, res, next) {
  // Before the first compile finishes there is nothing current to serve, and the copy on
  // disk belongs to the previous build. Fall through to webpack-dev-middleware, which holds
  // the request until the build completes. That also keeps the readiness probe honest: the
  // pod must not look ready before it can serve, or MetaExtension would switch Rancher over
  // to a dev server that is not up yet.
  if (currentHash === 'boot') {
    return next();
  }

  let html;

  try {
    html = read(\`\${ assetDir }/index.html\`);
  } catch (e) {
    return next();
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(html.replace(/(\\/js\\/[A-Za-z0-9_.-]+\\.js)(\\?v=[^"']*)?/g, \`$1?v=\${ currentHash }\`));
}

function state() {
  const product = read(PRODUCT);
  const login = read(LOGIN_PAGE);
  const home = read(HOME_PAGE);
  const headline = home.match(/headline: '([^']*)'/);

  return {
    navVisible: /public: *true/.test(product),
    helloOn:    login.includes(HELLO_MARKER),
    headline:   headline ? headline[1] : null,
    build:      buildStatus(),
    compile:    lastCompile
  };
}

function setPageTime() {
  const stamp = new Date().toLocaleTimeString();

  write(HOME_PAGE, read(HOME_PAGE).replace(/headline: '[^']*'/, \`headline: 'Updated at \${ stamp }'\`));
}

function toggleNav() {
  const src = read(PRODUCT);

  write(PRODUCT, /public: *true/.test(src)
    ? src.replace(/public: *true/, 'public:              false')
    : src.replace(/public: *false/, 'public:              true'));
}

function toggleHello() {
  const src = read(LOGIN_PAGE);

  if (src.includes(HELLO_MARKER)) {
    write(LOGIN_PAGE, src.split('\\n').filter((l) => !l.includes(HELLO_MARKER)).join('\\n'));
  } else {
    write(LOGIN_PAGE, src.replace(LOGIN_ANCHOR, HELLO_LINE + '\\n' + LOGIN_ANCHOR));
  }
}

const ACTIONS = {
  'page-time':    setPageTime,
  'nav-toggle':   toggleNav,
  'hello-toggle': toggleHello
};

/**
 * Endpoints behind the dev server so MetaExtension can drive the same edits from a button.
 * A browser cannot write into the pod's filesystem, and doing it through the Kubernetes exec
 * subresource from a Vue page would be far more machinery than a POST.
 */
function registerToggleRoutes(app) {
  app.get('/__dev/state', (req, res) => res.json(state()));

  // Rancher's plugin controller fetches these. Registered before the catch-all so
  // webpack-dev-middleware never gets a chance to answer /plugin/... with the SPA.
  app.get('/files.txt', servePluginFile);
  app.get(/^\\/plugin\\//, servePluginFile);

  // Not in ACTIONS: a build takes minutes, so this answers as soon as it has started rather
  // than holding the request open. The page polls /__dev/state for the outcome.
  app.post('/__dev/build', (req, res) => {
    if (building) {
      return res.json(state());
    }

    runBuild('manual');
    res.json(state());
  });

  app.post('/__dev/:action', (req, res) => {
    const action = ACTIONS[req.params.action];

    if (!action) {
      return res.status(404).json({ error: \`unknown action \${ req.params.action }\` });
    }

    try {
      action();
      res.json(state());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

base.devServer = {
  ...base.devServer,

  // Rancher fetches index.html server-side with a stock http.Client, which sends no
  // credentials and rejects self-signed certs. Plain http, and Rancher's own TLS in front.
  server:        { type: 'http' },
  allowedHosts:  'all',
  // writeToDisk is what actually puts the bundle in Rancher's static directory; the dev
  // server otherwise keeps everything in memory where Rancher cannot serve it. The dev
  // server still serves at the root for its own sake, which is what carries the HMR socket.
  devMiddleware: { publicPath: '/', writeToDisk: true },

  // Hot reload over webpack's own websocket, which costs nothing while nothing is changing.
  // The socket reaches this pod through the apiserver proxy, and that proxy requires a
  // Rancher session - so live reload works on any page you are logged in for, and not on the
  // login page. That is the accepted trade: the alternative was polling a build stamp from
  // every open tab forever, which is a request every few seconds whether or not anyone is
  // editing anything.
  //
  // The sentinels are webpack-dev-server's "infer it from window.location": protocol 'auto',
  // hostname '0.0.0.0', port 0. They are what keep this build from needing to know the
  // hostname Rancher is served on. Only the path is ours, and it is derived, not configured.
  hot:             true,
  webSocketServer: { type: 'ws', options: { path: '/ws' } },
  client:          {
    webSocketURL: {
      protocol: 'auto',
      hostname: '0.0.0.0',
      port:     0,
      pathname: \`\${ proxyPath }/ws\`
    },
    // The full-screen error overlay belongs to the dev build, so it would cover Rancher's
    // whole UI for anyone who happens to be looking when a compile breaks.
    overlay: false
  },

  setupMiddlewares: (middlewares, devServer) => {
    const result = previousSetupMiddlewares
      ? previousSetupMiddlewares(middlewares, devServer)
      : middlewares;

    registerToggleRoutes(devServer.app);

    // Ahead of webpack-dev-middleware, which would otherwise serve the unstamped index.
    // This is the file Rancher fetches for ui-dashboard-index, so it is the one place that
    // decides which bundle every browser loads.
    result.unshift({
      name:       'index-cache-bust',
      path:       '/index.html',
      middleware: indexMiddleware
    });

    return result;
  }
};

// The shell ships with /node_modules/ in watchOptions.ignored, which makes its own pages
// (login, nav, anything outside pkg/) impossible to edit live. Watch @rancher/shell and
// keep ignoring the rest, so the whole dashboard is editable in the pod, not just the
// extension.
const previousConfigureWebpack = base.configureWebpack;

base.configureWebpack = (config) => {
  const result = typeof previousConfigureWebpack === 'function'
    ? previousConfigureWebpack(config)
    : previousConfigureWebpack;

  // dist-pkg and .plugin-root are the UMD build's own output, inside the watched tree. Left
  // watched, finishing a build would dirty the tree, which would restart the idle timer,
  // which would schedule another build - forever.
  config.watchOptions = {
    ...(config.watchOptions || {}),
    ignored: /node_modules\\/(?!@rancher\\/shell)|\\/app\\/dist-pkg\\/|\\/app\\/\\.plugin-root\\/|\\/app\\/\\.build-state\\.json|\\/app\\/\\.mcp-tls\\//
  };

  // Watching is not enough on its own. Webpack 5 treats node_modules as a "managed path"
  // and assumes its contents never change, so it caches them and skips the watcher
  // entirely. Clearing that is what actually makes shell edits rebuild.
  config.snapshot = {
    ...(config.snapshot || {}),
    managedPaths:    [],
    immutablePaths:  []
  };

  // Record the outcome of every compile. No file is written any more - the browser learns
  // about a rebuild over the HMR socket - but two things still need this in memory: the
  // index cache-bust below, and the MCP server's devServerStatus, which is how an agent
  // editing this tree finds out its change failed to compile.
  config.plugins = config.plugins || [];
  config.plugins.push({
    apply(compiler) {
      compiler.hooks.done.tap('DevCompileState', (stats) => {
        currentHash = stats.hash;
        lastCompile = {
          hash:   stats.hash,
          ok:     !stats.hasErrors(),
          at:     Date.now(),
          errors: stats.compilation.errors.slice(0, 5).map((e) => String(e.message || e).split('\\n').slice(0, 6).join(' | '))
        };

        // Every compile pushes the automatic UMD build back out. The first one after boot
        // arms it, so a pod left alone produces a bundle without anyone asking.
        scheduleAutoBuild();
      });
    }
  });

  return result;
};

module.exports = base;
`;

const header = `/* eslint-disable */
// GENERATED by scripts/generate-seed.mjs - do not edit.
// Source of truth is pkg/dev-extension/ and the app skeleton. Regenerate with:
//   node scripts/generate-seed.mjs

export const SEED_FILES: Record<string, string> = `;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${ header }${ JSON.stringify(files, null, 2) };\n`);

const bytes = Buffer.byteLength(JSON.stringify(files));

console.log(`seed: ${ Object.keys(files).length } files, ${ (bytes / 1024).toFixed(1) } KiB -> ${ path.relative(APP, OUT) }`);

// A ConfigMap tops out around 1 MiB. The seed is source only - node_modules is installed in
// the pod - so this should stay tiny, but fail loudly rather than at apply time.
if (bytes > 900 * 1024) {
  console.error('seed is too large for a ConfigMap');
  process.exit(1);
}
