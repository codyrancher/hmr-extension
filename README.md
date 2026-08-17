# MetaExtension + DevExtension

An agent edits DevExtension's source *inside the pod that serves it*, and the running
Rancher instance updates live, with no page reload and no rebuild-install cycle.

The whole thing is self-referential: **DevExtension's dev server runs as a pod inside the
Rancher instance it modifies.** Nothing about the loop lives outside the cluster.

- **DevExtension** is a Rancher extension. Its dev server serves a *whole dashboard* with
  the extension compiled in, plus webpack HMR.
- **MetaExtension** is a normal installed Rancher extension. It runs that dev server as a
  pod and repoints Rancher's dashboard index at it. One toggle, no configuration.

This is not an extension hot-swap. It is real module-level HMR, because the thing Rancher
is serving *is* the dev build.

## Two serving modes

Leaving hot reload on is expensive: it puts a dev build of the entire dashboard in front of
every page and holds a websocket open from every tab, and it only works while you are logged
in. So the same pod supports both modes, and the Dev Loop page switches between them.

| | **HMR on** | **HMR off** |
| --- | --- | --- |
| What serves the dashboard | the pod | Rancher's own bundle |
| How DevExtension loads | compiled into the dev build | a `UIPlugin` pointing at a UMD bundle the pod built |
| Seeing an edit | live, no reload (logged in only) | needs a build |
| What changes | `ui-dashboard-index` -> pod | settings restored, `dev-extension` UIPlugin created |

The modes are mutually exclusive by necessity, not by preference: the dev build already has
DevExtension compiled in, so leaving the UIPlugin registered would load a second copy and
both would try to register the same product. Switching either way therefore deletes or
creates that CR, and reloads the page - the dashboard bundle the browser is running has been
replaced underneath it.

`hmr: off` is the interesting one. Nothing about it is special-cased for development:
Rancher's plugin controller downloads the UMD, caches it and injects the script tag exactly
as it does for any installed extension. What you are looking at is the real loading path.

## How it fits together

```
                       Rancher instance
  +----------------------------------------------------------+
  |                                                          |
  |  Rancher  --- fetches index.html (ClusterIP) ---+        |   HMR ON
  |     |                                           v        |
  |     |  /dashboard/                  +---------------------+
  |     |     index.html                |  devserver pod      |
  |     |                               |  vue-cli-service    |<-- ./dev-shell
  |     |  /dashboard/devext/           |  serve :8005        |    (kubectl exec)
  |     |     assets, off local disk <--|  writeToDisk        |    edits in place
  |     |     NO AUTH                   |                     |
  |     |                               |                     |
  |     |  k8s proxy /ws  <-------------|  HMR websocket      |
  |     v      (needs a session)        |                     |
  +--- browser                          |                     |
  |                                     |                     |
  |  plugin controller --- files.txt ---+  .plugin-root/      |   HMR OFF
  |     |                 /plugin/...   |  built UMD          |
  |     v                               +---------------------+
  |  /v1/uiplugins/dev-extension/...                          |
  +--- browser -----------------------------------------------+
```

Three consumers reach the dev build, by three different routes:

| Consumer | Fetches | Route | Why |
| --- | --- | --- | --- |
| Rancher (server-side) | `index.html` only | Service ClusterIP, direct | `serveRemote` uses a stock `http.Client`: no credentials, so it cannot use the authenticated proxy. It can route to a ClusterIP because it shares a network namespace with the k3s node. Cluster DNS is not resolvable from there, so the raw IP is read back off the Service. |
| Browser | every asset | `/dashboard/devext/...` on Rancher's own origin | Served straight off Rancher's disk with **no authentication**. See below. |
| Browser | HMR updates | websocket via the apiserver proxy | The proxy passes the upgrade through, so webpack's own client works unmodified - but it needs a Rancher session, so the login page does not hot-reload. See below. |

Nothing here is configured by hand. Every name and port is a constant and both browser paths
are **root-relative**, so they resolve against Rancher's own origin - neither the extension
nor the pod ever learns what hostname Rancher is served on. The only runtime value is the
Service's ClusterIP, and MetaExtension reads that back itself after creating the Service.
The websocket URL is derived the same way; see below.

## Why assets do not go through the k8s proxy

They used to, and it made the instance unusable from a fresh browser. The apiserver proxy
requires a Rancher session, and Rancher's auth middleware answers an anonymous request with
a flat `not authorized` before the apiserver is ever consulted, so k8s RBAC cannot open it
up. The login page *is* the dashboard SPA, so its own JavaScript 401'd for exactly the
people who had no session yet: you could never log in.

Rancher serves `/dashboard/<file>` from a local directory with no authentication
(`IndexFileOnNotFound` in `pkg/ui/routes.go`), and the k3s node is the Rancher container, so
the dev server pod mounts that directory over hostPath and webpack writes its output there
(`devMiddleware.writeToDisk`). Assets are addressed at `/dashboard/devext/`, a subdirectory
of its own so it can never shadow a stock UI file. Directory paths and unknown SPA routes
still fall through to the remote index, because that branch only serves regular files.

Hot reload rides on this too: webpack's `.hot-update.js` chunks are written to the same
directory and fetched over the same anonymous path. Only the socket that *announces* them
goes through the authenticated proxy.

## Hot reload over the apiserver proxy

The HMR websocket reaches the pod at
`/k8s/clusters/local/api/v1/namespaces/dev-extension-system/services/http:devserver:8005/proxy/ws`.
The apiserver's service proxy passes the upgrade through - the handshake comes back `101` -
so webpack's own client works unmodified. Nothing about the URL is configured: protocol, host
and port are webpack-dev-server's `auto` / `0.0.0.0` / `0` sentinels, meaning "take it from
`window.location`", and only the path is ours, derived from constants MetaExtension already
has.

**The socket requires a Rancher session**, because the apiserver proxy does. So hot reload
works on every page you are logged in for, and not on the login page.

That trade was made in both directions before settling here. This started on the socket,
moved to polling a `__build.json` build stamp over the unauthenticated static path - which
did make the login page hot-reload - and came back, because polling is paid for by every open
tab forever: a request every one to six seconds whether or not anyone is editing anything,
against zero while the socket is idle. Measured on the way back: an edit lands in about four
seconds having produced **2 HTTP requests in 45 seconds**, where polling produced tens.

If logged-out hot reload is wanted again, the build stamp is the way to get it, and one
detail is worth keeping: webpack's own `webpack/hot/poll` cannot do it. It polls for an
update manifest that does not exist until a rebuild happens, and Rancher answers a missing
file under `/dashboard/` with **index.html and a 200** rather than a 404, so the HMR client
parses that HTML as JSON and aborts, once a second. Polling a file that is always present is
what avoids ever asking for something missing.

One consequence of serving out of Rancher's static directory survives either way: it sets a
one-year `Cache-Control` on everything there, and these bundles have fixed names rather than
content-hashed ones. `index.html` is sent no-cache, so the current build hash is stamped onto
the tags it injects (`index.js?v=<hash>`) and every reload picks up the current bundle. Without
it the browser reuses a cached bundle, and the HMR client then tries to walk forward from a
hash whose update chunks were overwritten builds ago, gives up, and full-reloads straight back
onto the same cached copy.

## The pod builds its own UMD

`hmr: off` needs a built bundle, and the pod is the only place the source lives, so the pod
builds it: `build-pkg.sh` into `dist-pkg/`, copied out to `.plugin-root/` with the
`files.txt` the plugin controller expects. It is copied rather than served straight out of
`dist-pkg` so a half-finished build can never be downloaded.

Builds are **debounced, not per compile**. A UMD build is far slower than an incremental
rebuild, and firing one per keystroke would keep a CPU busy for nothing, so every compile
pushes a five-minute timer out and the build runs only once the tree goes quiet. That also
means the bundle always reflects a finished edit rather than a half-typed one. The first
compile after boot arms the timer, so a pod left alone produces a bundle without anyone
asking, and turning HMR off normally finds one ready.

Two details are load-bearing:

- `dist-pkg/` and `.plugin-root/` are excluded from `watchOptions.ignored`. They sit inside
  the watched tree, so leaving them watched would mean finishing a build dirties the tree,
  which restarts the idle timer, which schedules another build - forever.
- The production build type-checks where the dev build only warns. `product.ts` used
  `public: true`, which is honoured at runtime but absent from `TypeMapProduct`; the dev
  build had been happily warning about it for as long as the project existed, and the first
  UMD build failed on it. Worth knowing that turning HMR off is also the first thing that
  ever compiles this extension for real.

The page shows the last build (timestamp, `auto` or `manual`, duration, version) and a
countdown to the next automatic one, and has a button to build now rather than wait.

## Giving the AI assistant a shell in the pod

Rancher's AI assistant has 33 tools and not one of them reaches inside a container. It can
tell you everything about this cluster and change nothing about the code running in it. So
the pod runs its own MCP server (`pod/mcp-server.mjs`), and MetaExtension can introduce the
two with an `AIAgentConfig`. The assistant then gets `exec`, `readFile`, `writeFile`,
`listFiles`, `devServerStatus` and `buildExtension` — on the tree that is compiled into the
dashboard it is being asked from. An edit it makes hot-reloads into every open browser.

That is the loop this project exists to build, and it is also the whole risk: an
unrestricted shell driven by a language model, on the thing serving the UI. It is therefore a
**separate, explicit toggle**, not part of enabling the dev loop. Creating the
`AIAgentConfig` is the grant and deleting it is the revocation — stopping the pod is not,
it just leaves the assistant pointed at something unreachable. Disabling the dev loop
revokes it too.

Three things were only learnable by trying:

- **`mcpURL` needs a full URL** for a custom agent. The built-in configs carry a bare host
  (`rancher-mcp-server.cattle-ai-agent-system.svc`), but they are `builtIn: true` and the
  controller fills in the rest. Copying their shape fails with `Request URL is missing an
  'http://' or 'https://' protocol`.
- **TLS is real.** The controller validates the endpoint's certificate against
  `caBundleRef`, so the pod generates a self-signed one on first boot and MetaExtension
  copies it into a Secret. A self-signed certificate is its own CA, so there is no signing
  step — and the private key never leaves the pod, since only `/ca.pem` is served.
- **`status.phase` is worth reading.** The controller connects and loads the tool list when
  the CR is created, so a certificate the agent will not trust shows up as `Failed` there
  rather than as a confusing answer at the first prompt.

The MCP server implements streamable HTTP by hand rather than pulling a library in: the pod
installs from the seeded `package.json`, and adding a dependency would trigger a
`node_modules` rebuild on a tree whose whole purpose is to be edited live.

## Why MetaExtension is not part of the dev build

It is excluded in `vue.config.js` and installed as a `UIPlugin` instead, so it loads
identically whether Rancher is serving its own bundled UI or the dev build. That matters
because **MetaExtension can only bootstrap from the stock UI** - once the dev loop is on,
the page is being served through the very pod it would be rebuilding. If it were also
compiled into the dev build, `addProduct` would reject the second registration.

Serving it exposed a Rancher constraint worth knowing: a `UIPlugin` endpoint with
`noCache: true` is reverse-proxied per request, and that path requires https **and** rejects
any host resolving to a private, loopback or link-local address. The caching path
(`noCache: false`) has neither restriction - the controller downloads the files with a plain
`http.Get` and re-serves them from Rancher's origin. That is what `publish-meta.sh` uses. It
also means a re-publish must change the CR *spec*: the controller only re-downloads when
`generation > observedGeneration`, so the script stamps a build time into
`spec.plugin.metadata`.

## Usage

```bash
yarn install
./publish-meta.sh     # build MetaExtension, register it as a UIPlugin
```

Then open Rancher, go to **Dev Loop** in the left nav, and click **Enable dev loop**. First
start pulls `node:24`, installs dependencies and compiles - about two minutes. Rancher is
only switched over once the pod answers, so enabling cannot strand you. That single install
+ click is the whole setup: nothing else needs to run.

Clicking Enable records the intent durably before that two-minute wait, not after. If the
tab is closed or navigated away while the pod is still installing, the switch-over never ran,
but nothing was lost either: reopening the Dev Loop page finishes it automatically once the
pod is ready, and in the meantime the page says so instead of just showing DISABLED.

`./dev-loop on|off|status` does the same switch headlessly.

To edit:

```bash
./dev-shell    # exec a shell into the pod, cwd already at pkg/dev-extension
```

Now edit any file with ordinary tools *inside that shell* and the page updates live. There
is no local working copy to keep in sync - the pod is it.

The Dev Loop page also has **Turn HMR off / on**, which switches serving mode (see above),
and **Build the bundle now**, which skips the five-minute wait for the automatic build.

## The pod is the only copy that matters

Once the dev server has booted, the tree at `/app/pkg/dev-extension` inside the pod is
DevExtension's live source. Editing it directly is what makes a single install
self-sufficient: no push step, no watcher process, nothing running outside the cluster that
the loop depends on.

The `pkg/dev-extension/` directory in *this* workspace is not that tree - it is build-time
input only. `scripts/generate-seed.mjs` bakes it into MetaExtension as a ConfigMap so a
freshly installed pod has something to boot from, but that seed is read exactly once. On
every boot after the first, the pod finds its existing tree on the hostPath volume and keeps
it, seed untouched. Editing the workspace copy after that point has no effect on the running
instance; edit inside the pod instead (`./dev-shell`).

The seed is deliberately not a live channel either way: kubelet takes up to a minute to
propagate a ConfigMap change, which would make hot reload feel broken even if boot re-read
it on every restart.

When you *do* change the workspace copy - because you changed what a fresh install should
get - run `node scripts/sync-seed.mjs`. It rewrites the cluster ConfigMap **and** the running
pod's tree, so "what a fresh install gets" and "what is running" stay in step. Skipping it is
a quiet trap: the pod keeps working from its old tree, and a later tree wipe silently
re-seeds the stale content, reverting changes that looked long since applied.

## The failure mode to know about

While the dev loop is on, `ui-offline-preferred=Remote` means Rancher serves whatever the
dev server pod hands it. **If that pod becomes unhealthy, Rancher has no UI at all** -
including MetaExtension's own page, so you cannot click your way out.

`./dev-loop off` talks straight to the Rancher API and restores the previous settings, which
were stashed in the `dev-loop-state` ConfigMap before anything changed. That is the recovery
path, and it is why the CLI exists alongside the UI.

That same ConfigMap also carries `desired` (`enabled`/`disabled`): what was last asked for,
independent of whether the switch-over actually ran. `./dev-loop on` records it too, and
`./dev-loop status` shows it alongside the CLI-inferred on/off state. It carries `hmr`
(`on`/`off`) for the same reason - re-enabling comes back in the mode you left.

`desired` is also what the status badge reads, deliberately not the settings. UMD mode
restores those settings on purpose, so a badge derived from them reports the loop as off
while it is very much on and serving DevExtension through a UIPlugin.

Enabling is safe by construction: `waitReady` blocks until the pod answers and the settings
are only flipped afterwards. Turning HMR *off* has the equivalent guard - if no bundle has
ever been built it builds one first and waits for Rancher to cache it before reloading,
because otherwise the switch appears to work and DevExtension simply vanishes.

## The Prime override

Prime-only extensions (Rancher's AI assistant among them) check
`plugin.environment.isPrime` and refuse to load without it. This is the community image, so
`/rancherversion` reports `RancherPrime: "false"`, and that string is compiled into the
Rancher binary - no setting or env var changes it, and Prime images are behind a
subscription registry that will not serve an anonymous pull.

So the boot script overrides it in the build instead, in `setVersionData()`. That is the
only correct place: `shell/core/plugin.ts` builds the extension-facing environment from
`getVersionData().RancherPrime` directly and never calls `isRancherPrime()`, so patching the
obvious-looking function leaves every extension still seeing false.

Two consequences. It is a client-side development override - it grants no entitlement and
has no business leaving this instance. And it lives in the dev build, so **it only applies
while HMR is on**; in UMD mode Rancher serves its own bundle and prime-only extensions go
back to refusing.

## Layout

```
pkg/dev-extension/       the extension being developed; build-time seed input only, see above
pkg/meta-extension/      runs the dev server pod, flips the settings
  lib/manifests.ts       every k8s object
  lib/dev-loop.ts        install / waitReady / activate / setHmr / agent access / disable
  lib/seed.generated.ts  generated - do not edit
pod/                     things that run IN the pod, baked into the seed
  boot.sh                first-boot script: seed, install, certificates, start both servers
  mcp-server.mjs         the AI assistant's shell into the pod
scripts/generate-seed.mjs bakes pkg/dev-extension and pod/ into MetaExtension
scripts/sync-seed.mjs    pushes a regenerated seed into the cluster AND the running pod
publish-meta.sh          builds MetaExtension and registers it as a UIPlugin
plugin-server.mjs        static server Rancher's plugin controller downloads from
dev-shell                exec a shell into the dev server pod, cwd at pkg/dev-extension
dev-loop                 headless on/off/status, and the emergency off-switch
```

## Known gaps

- The dev server's working tree lives on a node `hostPath` (there is no StorageClass on this
  cluster). It survives pod restarts but not a node rebuild, which just means a slower first
  start.
- Assets written into Rancher's static directory under `/dashboard/devext/` are not removed
  when the dev loop is disabled. Nothing references them once Rancher serves its own index,
  so they are inert, but they do occupy disk (roughly 90 MB) until the pod is recreated.
- The pod's MCP server takes no authentication (`authenticationType: NONE`), so while the pod
  is running, anything that can reach its ClusterIP has the same shell the assistant does.
  In this sandbox that is Rancher and the pods this project creates, but it is not a control
  worth relying on: revoking the `AIAgentConfig` stops the assistant being offered the tools,
  it does not close the port. `AIAgentConfig` supports `BASIC` and `HEADER` auth with an
  `authenticationSecret` if that matters later.
- Nothing stops the dev server pod. `hmr: off` cannot - the pod is the endpoint Rancher's
  plugin controller downloads from and the thing that builds the next bundle - but neither
  does `Disable dev loop`, which only restores the settings and removes the UIPlugin. So the
  watcher and its incremental compiles keep costing CPU after you have switched everything
  off. `kubectl -n dev-extension-system scale deploy/devserver --replicas=0` reclaims it;
  re-enabling puts it back, since `install()` reapplies the Deployment.
