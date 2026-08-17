import {
  DEV_NAMESPACE, DEV_SERVER, STATE_CONFIGMAP, SETTING_INDEX, SETTING_OFFLINE,
  OFFLINE_REMOTE, DEFAULT_INDEX, DESIRED_ENABLED, DESIRED_DISABLED,
  HMR_ON, HMR_OFF, UIPLUGIN_NAMESPACE, DEV_PLUGIN_NAME, pluginEndpoint,
  AI_NAMESPACE, AI_AGENT_NAME, MCP_CA_SECRET, MCP_SERVICE, mcpUrl,
  indexUrl, proxyPath
} from '../config/constants';
import { devLoopManifests, devExtensionVersion, K8sObject } from './manifests';

/**
 * The Vuex store. The shell exposes no type for it - its own extension API takes it as
 * `any` - so narrow it to the one method used here rather than propagating `any`.
 */
interface Store {
  dispatch(action: string, payload?: unknown, opts?: { root: boolean }): Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

interface RequestOpt {
  url: string;
  method?: string;
  data?: unknown;
}

const CORE = `/k8s/clusters/local/api/v1/namespaces/${ DEV_NAMESPACE }`;
const APPS = `/k8s/clusters/local/apis/apps/v1/namespaces/${ DEV_NAMESPACE }`;
const PLUGINS = `/k8s/clusters/local/apis/catalog.cattle.io/v1/namespaces/${ UIPLUGIN_NAMESPACE }/uiplugins`;
const AI_CORE = `/k8s/clusters/local/api/v1/namespaces/${ AI_NAMESPACE }`;
const AI_AGENTS = `/k8s/clusters/local/apis/ai.cattle.io/v1alpha1/namespaces/${ AI_NAMESPACE }/aiagentconfigs`;

async function request(store: Store, opt: RequestOpt) {
  return store.dispatch('management/request', opt, { root: true });
}

/**
 * Does this rejection mean the object is already there?
 *
 * A rejected Steve request resolves to the Kubernetes `Status` body with the HTTP code
 * attached as `_status`. Note that `Status.status` is the string "Failure", not a number,
 * so reading `.status` and comparing it to 409 silently never matches.
 */
function isAlreadyExists(e: unknown): boolean {
  const err = e as { _status?: number; code?: number; reason?: string };

  return err?._status === 409 || err?.code === 409 || err?.reason === 'AlreadyExists';
}

/**
 * Create the object, or update it if it is already there. The k8s API has no upsert, and
 * enabling the dev loop twice in a row is the normal case, not an error.
 */
async function apply(store: Store, url: string, body: K8sObject) {
  try {
    return await request(store, {
      url, method: 'POST', data: body
    });
  } catch (e) {
    if (!isAlreadyExists(e)) {
      throw e;
    }

    // Already exists. Read it back for the resourceVersion, then replace.
    const name = body.metadata.name;
    const existing = await request(store, { url: `${ url }/${ name }` });

    return request(store, {
      url:    `${ url }/${ name }`,
      method: 'PUT',
      data:   { ...body, metadata: { ...body.metadata, resourceVersion: existing.metadata.resourceVersion } }
    });
  }
}

/** Read the `dev-loop-state` ConfigMap's data, or `{}` if it does not exist yet. */
async function getStateData(store: Store): Promise<Record<string, string>> {
  try {
    const cm = await request(store, { url: `${ CORE }/configmaps/${ STATE_CONFIGMAP }` });

    return cm?.data || {};
  } catch {
    return {};
  }
}

/** Write the ConfigMap's data verbatim. Callers merge first - this never does. */
async function putStateData(store: Store, data: Record<string, string>) {
  return apply(store, `${ CORE }/configmaps`, {
    apiVersion: 'v1',
    kind:       'ConfigMap',
    metadata:   { name: STATE_CONFIGMAP, namespace: DEV_NAMESPACE },
    data
  });
}

/**
 * Record what the user asked for. Read-modify-write: `previous` (the settings `disable()`
 * restores) lives in the same ConfigMap, and writing `desired` alone would erase it.
 */
async function setDesired(store: Store, value: string) {
  const data = await getStateData(store);

  await putStateData(store, { ...data, desired: value });
}

async function getSetting(store: Store, name: string): Promise<string> {
  const res = await request(store, { url: `/v3/settings/${ name }` });

  return res?.value ?? res?.default ?? '';
}

async function setSetting(store: Store, name: string, value: string) {
  return request(store, {
    url:    `/v3/settings/${ name }`,
    method: 'PUT',
    data:   { name, value }
  });
}

export interface DevLoopStatus {
  enabled: boolean;
  installed: boolean;
  serverReady: boolean;
  index: string;
  offline: string;
  proxyPath: string;
  clusterIp: string;
  /** What the user last asked for (`enabled`/`disabled`), independent of whether it ran. */
  desired: string;
  /** Which serving mode is wanted: `on` for the live dev build, `off` for the built UMD. */
  hmr: string;
  /** Whether the DevExtension UIPlugin exists, and whether Rancher has cached its bundle. */
  pluginInstalled: boolean;
  pluginCached: boolean;
  pluginVersion: string;
  /** Whether the AI assistant has been given a shell in the pod, and whether it accepted. */
  agentAccess: boolean;
  agentPhase: string;
}

export async function status(store: Store): Promise<DevLoopStatus> {
  const index = await getSetting(store, SETTING_INDEX);
  const offline = await getSetting(store, SETTING_OFFLINE);
  const stateData = await getStateData(store);

  let installed = false;
  let serverReady = false;
  let clusterIp = '';
  let pluginInstalled = false;
  let pluginCached = false;
  let pluginVersion = '';
  let agentAccess = false;
  let agentPhase = '';

  try {
    const dep = await request(store, { url: `${ APPS }/deployments/${ DEV_SERVER }` });

    installed = true;
    serverReady = (dep?.status?.readyReplicas || 0) > 0;
  } catch {}

  try {
    const svc = await request(store, { url: `${ CORE }/services/${ DEV_SERVER }` });

    clusterIp = svc?.spec?.clusterIP || '';
  } catch {}

  try {
    const plugin = await request(store, { url: `${ PLUGINS }/${ DEV_PLUGIN_NAME }` });

    pluginInstalled = true;
    pluginCached = plugin?.status?.cacheState === 'cached';
    pluginVersion = plugin?.spec?.plugin?.version || '';
  } catch {}

  try {
    const agent = await request(store, { url: `${ AI_AGENTS }/${ AI_AGENT_NAME }` });

    agentAccess = true;
    // The controller validates the MCP endpoint and reports back here, so this is where a
    // certificate the agent will not trust shows up rather than at the first prompt.
    agentPhase = agent?.status?.phase || 'Pending';
  } catch {}

  return {
    enabled:   offline === OFFLINE_REMOTE && !index.includes('releases.rancher.com'),
    installed,
    serverReady,
    index,
    offline,
    proxyPath: proxyPath(),
    clusterIp,
    desired:   stateData.desired || DESIRED_DISABLED,
    // Absent on a state ConfigMap written before this existed, and that state was the live
    // dev build, so `on` is the honest default rather than a preference.
    hmr:       stateData.hmr || HMR_ON,
    pluginInstalled,
    pluginCached,
    pluginVersion,
    agentAccess,
    agentPhase
  };
}

/** What the pod reports about the UMD build that `hmr: off` mode serves. */
export interface BuildState {
  /** `never` until one has run; then `building`, `ok` or `failed`. */
  status: string;
  /** `auto` for the idle-timer build, `manual` for the button. */
  trigger?: string;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  version?: string;
  error?: string;
  building: boolean;
  /** How long the tree must stay unchanged before a build starts. */
  idleMs: number;
  /** Time left on that timer, or null when no build is queued. */
  autoBuildInMs: number | null;
}

export interface DemoState {
  navVisible: boolean;
  helloOn: boolean;
  headline: string | null;
  build: BuildState;
}

/**
 * The dev server's own edit endpoints.
 *
 * A browser cannot write into the pod's filesystem, so the toggles are POSTs the dev server
 * turns into ordinary file edits - the same edits a person would type in the pod, which is
 * what makes them trigger a rebuild. Plain `fetch` rather than the Steve store: these are
 * not Kubernetes resources, and the session cookie already authenticates them same-origin.
 */
async function devFetch(path: string, method = 'GET'): Promise<DemoState> {
  const res = await fetch(`${ proxyPath() }/__dev/${ path }`, { method, credentials: 'same-origin' });

  if (!res.ok) {
    throw new Error(`dev server returned ${ res.status } for ${ path }`);
  }

  return res.json();
}

export const demoState = () => devFetch('state');
export const runDemoAction = (action: string) => devFetch(action, 'POST');

/**
 * Start a UMD build now instead of waiting out the idle timer.
 *
 * Returns as soon as the build has started, not when it finishes - it takes minutes. The
 * page's existing poll reports the outcome.
 */
export const buildNow = () => devFetch('build', 'POST');

/** Create the namespace, seed, dev server and Service. Safe to run repeatedly. */
export async function install(store: Store) {
  for (const entry of devLoopManifests()) {
    await apply(store, entry.url, entry.body);
  }
}

/**
 * Block until the dev server answers.
 *
 * Flipping the settings before it does would take the whole UI down - including this page,
 * which is the only way back - so activation must never run ahead of readiness. The first
 * start installs node_modules and compiles, so the budget is generous.
 */
export async function waitReady(store: Store, onProgress?: (msg: string) => void, timeoutMs = 15 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const s = await status(store);

    if (s.serverReady) {
      return true;
    }

    onProgress?.('waiting for the dev server to finish installing and compile (first start takes a few minutes)');
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  throw new Error('the dev server did not become ready; settings were left untouched');
}

/**
 * Point Rancher at the dev server.
 *
 * The previous settings are stashed first: once ui-offline-preferred is flipped, the values
 * needed to undo it have to be readable without a working UI.
 */
export async function activate(store: Store) {
  const svc = await request(store, { url: `${ CORE }/services/${ DEV_SERVER }` });
  const clusterIp = svc?.spec?.clusterIP;

  if (!clusterIp) {
    throw new Error(`Service ${ DEV_SERVER } has no ClusterIP`);
  }

  const current = {
    [SETTING_INDEX]:   await getSetting(store, SETTING_INDEX),
    [SETTING_OFFLINE]: await getSetting(store, SETTING_OFFLINE)
  };

  // Never stash our own values over the real ones - enabling twice would make the saved
  // state point back at the dev server and disabling would then be a no-op.
  if (current[SETTING_OFFLINE] !== OFFLINE_REMOTE) {
    // Merge rather than replace: `enable()` already wrote `desired` into this same
    // ConfigMap before this ran, and a bare write here would wipe it back out.
    const data = await getStateData(store);

    await putStateData(store, { ...data, previous: JSON.stringify(current) });
  }

  await setSetting(store, SETTING_INDEX, indexUrl(clusterIp));
  await setSetting(store, SETTING_OFFLINE, OFFLINE_REMOTE);
}

/**
 * Wait for Rancher to finish downloading the plugin.
 *
 * Reloading before this is what makes `hmr: off` look broken: the settings already point at
 * Rancher's own dashboard, but the extension is not cached yet, so the page comes back with
 * no DevExtension in it and nothing says why.
 */
export async function waitPluginCached(store: Store, onProgress?: (msg: string) => void, timeoutMs = 90 * 1000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if ((await status(store)).pluginCached) {
      return true;
    }

    onProgress?.('waiting for Rancher to download the extension bundle');
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  return false;
}

/**
 * Register DevExtension as an ordinary UIPlugin pointing at the bundle the pod built.
 *
 * This is the whole point of `hmr: off` - nothing here is special-cased for development.
 * Rancher's controller downloads the UMD, caches it, and injects the script tag exactly as
 * it does for any installed extension, so what you are looking at is the real loading path.
 *
 * `buildStamp` is bumped on every call because the controller only re-downloads when the
 * spec changes. Without it, a rebuild at the same version would never reach the browser.
 */
export async function installDevPlugin(store: Store) {
  const svc = await request(store, { url: `${ CORE }/services/${ DEV_SERVER }` });
  const clusterIp = svc?.spec?.clusterIP;

  if (!clusterIp) {
    throw new Error(`Service ${ DEV_SERVER } has no ClusterIP`);
  }

  return apply(store, PLUGINS, {
    apiVersion: 'catalog.cattle.io/v1',
    kind:       'UIPlugin',
    metadata:   { name: DEV_PLUGIN_NAME, namespace: UIPLUGIN_NAMESPACE },
    spec:       {
      plugin: {
        name:     DEV_PLUGIN_NAME,
        version:  devExtensionVersion(),
        endpoint: pluginEndpoint(clusterIp),
        noCache:  false,
        noAuth:   false,
        metadata: {
          'catalog.cattle.io/ui-extensions-version': '>= 3.0.0',
          buildStamp:                                String(Date.now())
        }
      }
    }
  });
}

/**
 * Remove it again. Required when turning HMR on, not merely tidy: the dev build compiles
 * DevExtension in directly, so leaving the UIPlugin would load a second copy of the same
 * extension and both would try to register the same product.
 */
export async function removeDevPlugin(store: Store) {
  try {
    await request(store, { url: `${ PLUGINS }/${ DEV_PLUGIN_NAME }`, method: 'DELETE' });
  } catch (e) {
    // Already gone is the normal case when switching modes twice.
  }
}

/**
 * Give Rancher's AI assistant a shell in the dev server pod.
 *
 * Rancher's own MCP server has 33 tools and not one of them reaches inside a container, so
 * the assistant can inspect this cluster but cannot change the code running in it. The pod
 * exposes its own MCP server to close that gap, and an `AIAgentConfig` is what introduces
 * the two. Creating that CR is the grant; deleting it is the revocation. Stopping the pod is
 * not - the config would simply point at something unreachable.
 *
 * Worth being clear-eyed about what this is: the assistant gets an unrestricted shell as the
 * pod's user, on a tree whose edits hot-reload into the Rancher every viewer is looking at.
 * That is the feature. It is also why it is a separate, explicit toggle rather than part of
 * enabling the dev loop.
 */
const MCP_PROXY = `/k8s/clusters/local/api/v1/namespaces/${ DEV_NAMESPACE }/services/http:${ MCP_SERVICE }:80/proxy`;

/**
 * The certificate the pod's MCP server presents.
 *
 * Self-signed, so it is its own CA and can go straight into the Secret the agent's
 * `caBundleRef` names - no signing step, and nothing to distribute. Generated in the pod on
 * first boot because that is the only place the private key should ever exist.
 */
async function mcpCertificate(): Promise<string> {
  const res = await fetch(`${ MCP_PROXY }/ca.pem`, { credentials: 'same-origin' });

  if (!res.ok) {
    throw new Error(`the pod's MCP server did not return a certificate (${ res.status })`);
  }

  const pem = await res.text();

  // The proxy answers a dead backend with something HTML-shaped, and a Secret full of that
  // would fail much later and much less legibly.
  if (!pem.includes('BEGIN CERTIFICATE')) {
    throw new Error('the MCP server answered, but not with a certificate');
  }

  return pem;
}

const AGENT_DESCRIPTION = [
  'This agent has a root shell inside the pod that serves this Rancher instance\'s dashboard, and can',
  'run any command in it. It is the only agent that can change how Rancher itself looks and behaves',
  'at runtime: the tree it edits is compiled into the dashboard being served, so an edit hot-reloads',
  'into every open browser within seconds.',
  '',
  'Route prompts here when they involve:',
  '- Changing the Rancher UI itself (e.g. "add a button to the cluster page", "change the login screen")',
  '- Reading or editing DevExtension\'s source code',
  '- Running any shell command, build, test or git operation in the dev server pod',
  '- Diagnosing why a UI change did not appear (compile errors, failed builds)',
  '',
  'Do NOT route here for ordinary cluster operations - listing clusters, inspecting workloads or',
  'creating Kubernetes resources belong to the Rancher agent.'
].join('\n');

const AGENT_SYSTEM_PROMPT = [
  'You have a root shell inside the `devserver` pod in the `dev-extension-system` namespace, via the',
  '`exec` tool. This pod serves the very Rancher dashboard the user is looking at, so your edits',
  'change the running UI.',
  '',
  '## The shell',
  'It is a real shell, not a sandbox: `/bin/sh -c` with node, yarn, npm, git, sed, grep, find, curl',
  'and the usual coreutils. Pipes, redirection, heredocs, multi-line scripts and chained commands all',
  'work. Use it the way you would use a terminal - `grep -rn` to find things, `sed -i` for small',
  'edits, `cat > file <<\'EOF\'` (quoted, so nothing is interpolated) to write a whole file.',
  '',
  '## The tree',
  '- `/app/pkg/dev-extension` is the extension\'s source.',
  '- `/app/node_modules/@rancher/shell` is the Rancher dashboard itself, and it is watched too, so',
  '  you can edit core pages like `pages/auth/login.vue` as readily as the extension.',
  '- Changing a file triggers a webpack rebuild and the change hot-reloads. There is no deploy step.',
  '',
  '## How to work',
  '1. Look before you edit. Read a file, or grep for the thing you are changing, before changing it.',
  '2. After an edit, call `devServerStatus`. A failed compile means your change did NOT reach the',
  '   browser - the last good bundle keeps running and nothing looks wrong. Read the error and fix it',
  '   before reporting success.',
  '3. Make the smallest change that does the job, and match the style of the file you are editing.',
  '',
  '## Be careful',
  'This is a live instance. A broken compile is recoverable, but a bad edit to the shell can take the',
  'whole UI down for everyone using it, including the page you are being asked from. Do not delete',
  'files you did not create, do not run destructive commands, and say plainly what you changed so it',
  'can be undone.'
].join('\n');

export async function enableAgentAccess(store: Store) {
  const cert = await mcpCertificate();

  await apply(store, `${ AI_CORE }/secrets`, {
    apiVersion: 'v1',
    kind:       'Secret',
    metadata:   { name: MCP_CA_SECRET, namespace: AI_NAMESPACE },
    type:       'Opaque',
    stringData: { 'tls.crt': cert }
  });

  return apply(store, AI_AGENTS, {
    apiVersion: 'ai.cattle.io/v1alpha1',
    kind:       'AIAgentConfig',
    metadata:   { name: AI_AGENT_NAME, namespace: AI_NAMESPACE },
    spec:       {
      displayName:        'DevExtension Pod Shell',
      description:        AGENT_DESCRIPTION,
      systemPrompt:       AGENT_SYSTEM_PROMPT,
      enabled:            true,
      // The MCP server is reached over the cluster network on a Service of its own; there is
      // no Rancher session involved, so RANCHER auth would have nothing to pass through.
      authenticationType: 'NONE',
      mcpURL:             mcpUrl(),
      caBundleRef:        { name: MCP_CA_SECRET, key: 'tls.crt' }
    }
  });
}

export async function disableAgentAccess(store: Store) {
  for (const url of [`${ AI_AGENTS }/${ AI_AGENT_NAME }`, `${ AI_CORE }/secrets/${ MCP_CA_SECRET }`]) {
    try {
      await request(store, { url, method: 'DELETE' });
    } catch (e) {
      // Already gone. Disabling twice is not an error.
    }
  }
}

/** Put ui-dashboard-index and ui-offline-preferred back to whatever they were. */
async function restoreSettings(store: Store) {
  const data = await getStateData(store);
  const previous: Record<string, string> = JSON.parse(data.previous || '{}');

  await setSetting(store, SETTING_OFFLINE, previous[SETTING_OFFLINE] || 'dynamic');
  await setSetting(store, SETTING_INDEX, previous[SETTING_INDEX] || DEFAULT_INDEX);
}

/**
 * Switch between the two serving modes.
 *
 * The intent is written first, for the same reason `enable()` does it: these calls flip the
 * settings the running page is served from, so the page may well be torn down mid-flight.
 * A recorded intent is something `reconcile()` can pick up and finish.
 *
 * The caller is expected to reload afterwards. Both directions replace the dashboard bundle
 * the browser is currently running, and no amount of reactivity survives that.
 */
export async function setHmr(store: Store, on: boolean) {
  const data = await getStateData(store);

  await putStateData(store, { ...data, hmr: on ? HMR_ON : HMR_OFF });

  if (on) {
    await removeDevPlugin(store);
    await activate(store);
  } else {
    await restoreSettings(store);
    await installDevPlugin(store);
  }
}

/**
 * Install if needed, wait for the pod, then switch Rancher over.
 *
 * `desired` is recorded right after `install()`, before `waitReady()` - not after it. The
 * pod takes ~90s to install and compile on first boot, and if the tab is closed or
 * navigated away during that wait this promise chain never resumes. Recording intent before
 * it starts means `reconcile()` can still finish the switch-over later, from a page load
 * that never called `enable()` at all. It cannot go any earlier than this: the state
 * ConfigMap lives in `DEV_NAMESPACE`, which `install()` is what creates.
 */
export async function enable(store: Store, onProgress?: (msg: string) => void) {
  onProgress?.('installing the dev server');
  await install(store);

  await setDesired(store, DESIRED_ENABLED);

  await waitReady(store, onProgress);

  // Whichever mode was last chosen, not always the live build - re-enabling should come back
  // the way you left it.
  const wantHmr = (await status(store)).hmr === HMR_ON;

  onProgress?.(wantHmr ? 'pointing Rancher at the dev server' : 'registering the DevExtension UIPlugin');
  await setHmr(store, wantHmr);

  onProgress?.('enabled');
}

/** Put everything back, so Rancher serves its own bundled UI with no DevExtension at all. */
export async function disable(store: Store) {
  await restoreSettings(store);
  await removeDevPlugin(store);
  // Revoked too, not left behind: the config would otherwise point the assistant at an MCP
  // server nobody is guaranteeing is up, and it would fail at the first prompt instead of
  // simply not being offered.
  await disableAgentAccess(store);

  const data = await getStateData(store);

  await putStateData(store, { ...data, desired: DESIRED_DISABLED });
}

/**
 * Finish an `enable()` that got interrupted client-side after `desired` was recorded but
 * before `activate()` ran. Meant to be polled - the Dev Loop page calls this from its
 * existing 10s refresh, so simply having the page open finishes the job.
 *
 * Only acts when there is actually something to finish: `desired` is enabled, the pod
 * answers, and the settings do not already point at it. Otherwise it is a no-op, so calling
 * it on every poll (including while the pod is still installing) is safe.
 */
export async function reconcile(store: Store): Promise<DevLoopStatus> {
  const s = await status(store);

  if (s.desired !== DESIRED_ENABLED || !s.serverReady) {
    return s;
  }

  // Each mode has exactly one thing that can be left half-done: HMR on with the settings not
  // yet flipped, or HMR off with no UIPlugin registered. Anything else is already correct,
  // so this is a no-op on the overwhelming majority of polls.
  const wantHmr = s.hmr === HMR_ON;

  if (wantHmr && !s.enabled) {
    await removeDevPlugin(store);
    await activate(store);

    return status(store);
  }

  if (!wantHmr && (s.enabled || !s.pluginInstalled)) {
    await restoreSettings(store);
    await installDevPlugin(store);

    return status(store);
  }

  return s;
}
