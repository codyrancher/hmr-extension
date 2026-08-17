export const PRODUCT_NAME = 'metaextension';
export const CUSTOM_PAGE_NAME = 'devloop';

// Rancher's stand-in cluster id for a product that has no cluster of its own.
export const BLANK_CLUSTER = '_';

export const HOME_ROUTE = `${ PRODUCT_NAME }-c-cluster-${ CUSTOM_PAGE_NAME }`;

/** Namespace holding every resource MetaExtension installs. */
export const DEV_NAMESPACE = 'dev-extension-system';

/** The in-cluster dev server: a pod running `vue-cli-service serve` for DevExtension. */
export const DEV_SERVER = 'devserver';
export const DEV_SERVER_PORT = 8005;
export const DEV_SERVER_IMAGE = 'node:24';

/**
 * The pod's own MCP server: a shell into the dev server pod, for Rancher's AI assistant.
 *
 * It runs in the same container as the dev server rather than a sidecar, so "the pod's
 * shell" means what it says - same filesystem, same processes, same toolchain. Its own
 * Service exists only to give it a DNS name of its own for `mcpURL`.
 */
export const MCP_SERVICE = 'devserver-mcp';
export const MCP_HTTP_PORT = 8006;
export const MCP_HTTPS_PORT = 8443;

/** Namespace holding Rancher's AI agent, its MCP server and the AIAgentConfig CRs. */
export const AI_NAMESPACE = 'cattle-ai-agent-system';

/** The AIAgentConfig that points Rancher's assistant at the pod, and the Secret it trusts. */
export const AI_AGENT_NAME = 'devserver-shell';
export const MCP_CA_SECRET = 'devserver-mcp-ca';

/**
 * URL the AI agent connects to.
 *
 * A full URL, unlike the built-in agent configs, which carry a bare host - those are
 * `builtIn: true` and the controller fills in the rest for them. A custom config that copies
 * their shape is rejected with "Request URL is missing an 'http://' or 'https://' protocol".
 *
 * https, so the certificate the pod generates is actually used; the controller validates it
 * against the CA in `caBundleRef`. Cluster DNS resolves here because the agent is an
 * ordinary pod, unlike the Rancher process itself.
 */
export function mcpUrl(): string {
  return `https://${ MCP_SERVICE }.${ DEV_NAMESPACE }.svc/mcp`;
}

/** ConfigMap carrying the DevExtension source the pod starts from. */
export const SEED_CONFIGMAP = 'dev-extension-seed';

/** Where the node cluster keeps the working tree and node_modules between pod restarts. */
export const HOST_CACHE_PATH = '/var/lib/rancher/dev-extension';

/**
 * Rancher's own static UI directory on the node.
 *
 * Rancher serves `/dashboard/<file>` from here with NO authentication, which is the only
 * reason a logged-out browser can load anything. Assets fetched through the apiserver proxy
 * get a flat 401 from Rancher's auth middleware, so the login page - which is the dashboard
 * SPA itself - could never boot. The dev server writes its build output here instead.
 *
 * The k3s node is the Rancher container, so a hostPath mount lands in Rancher's real
 * filesystem.
 */
export const HOST_UI_PATH = '/usr/share/rancher/ui-dashboard';

/** Subdirectory under /dashboard/ that the dev build owns, so it cannot shadow stock files. */
export const ASSET_SUBDIR = 'devext';

/** Browser path for dev build assets. Anonymous, same origin, no proxy involved. */
export function assetBase(): string {
  return `/dashboard/${ ASSET_SUBDIR }`;
}

/** ConfigMap remembering the settings we overwrote, so disabling can put them back. */
export const STATE_CONFIGMAP = 'dev-loop-state';

/**
 * Values for the `desired` field on that same ConfigMap: what the user last asked for,
 * recorded durably and independent of whether activation actually ran. `enable()` writes
 * `DESIRED_ENABLED` before the long install/compile wait, not after, so a tab closed or
 * navigated away mid-wait still leaves something for `reconcile()` to find and finish.
 */
export const DESIRED_ENABLED = 'enabled';
export const DESIRED_DISABLED = 'disabled';

/**
 * Values for the `hmr` field on that ConfigMap: which of the two serving modes the dev loop
 * is in while it is enabled.
 *
 * `on`  - Rancher's whole dashboard is served from the dev server, so every file in the tree
 *         (extension and shell alike) hot-reloads. Costs a permanently running dev server.
 * `off` - Rancher serves its own bundled dashboard again and DevExtension is loaded the
 *         ordinary way, as a UIPlugin pointing at the UMD bundle the pod builds. No polling,
 *         no dev build in front of the UI, and edits show up at the next build.
 */
export const HMR_ON = 'on';
export const HMR_OFF = 'off';

/**
 * The UIPlugin that loads the built DevExtension in `hmr: off` mode.
 *
 * Namespace and shape are Rancher's, not ours - this is the same object a real extension
 * install creates, which is the point: off mode exercises the normal loading path.
 */
export const UIPLUGIN_NAMESPACE = 'cattle-ui-plugin-system';
export const DEV_PLUGIN_NAME = 'dev-extension';

/**
 * Where the pod serves the built UMD from, for Rancher's plugin controller to download.
 *
 * The controller runs inside Rancher and downloads server-side, so this is the ClusterIP for
 * the same reason `indexUrl` is. `noCache: false` matters as well: the live-proxy path
 * (`noCache: true`) runs the endpoint through Rancher's SSRF denylist, which rejects every
 * address in this cluster. The caching path has no such check.
 */
export function pluginEndpoint(clusterIp: string): string {
  return `http://${ clusterIp }:${ DEV_SERVER_PORT }`;
}

export const SETTING_INDEX = 'ui-dashboard-index';
export const SETTING_OFFLINE = 'ui-offline-preferred';

/** Value of ui-offline-preferred that makes Rancher serve the remote index. */
export const OFFLINE_REMOTE = 'Remote';

/** Default Rancher restores to when there is no saved previous value. */
export const DEFAULT_INDEX = 'https://releases.rancher.com/dashboard/latest/index.html';

/**
 * Browser-reachable path for the dev server: the apiserver's proxy subresource in front of
 * the dev server pod. Root-relative on purpose - the browser resolves it against Rancher's
 * own origin, so neither this extension nor the pod ever needs to know the hostname.
 */
export function proxyPath(): string {
  return `/k8s/clusters/local/api/v1/namespaces/${ DEV_NAMESPACE }/services/http:${ DEV_SERVER }:${ DEV_SERVER_PORT }/proxy`;
}

/**
 * URL Rancher itself fetches index.html from.
 *
 * This one cannot be the proxy: Rancher fetches it server-side with a client that sends no
 * credentials, and the proxy subresource requires auth. It goes straight to the Service's
 * ClusterIP, which the Rancher process can route to because it shares a network namespace
 * with the k3s node. Cluster DNS is not resolvable from there, hence the raw IP.
 */
export function indexUrl(clusterIp: string): string {
  return `http://${ clusterIp }:${ DEV_SERVER_PORT }/index.html`;
}
