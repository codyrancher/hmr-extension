const config = require('@rancher/shell/vue.config'); // eslint-disable-line @typescript-eslint/no-var-requires

// meta-extension is deliberately not compiled into this build. It is installed as a
// UIPlugin so it loads the same way in the stock dashboard and in this dev one - and if it
// were both builtin and installed, addProduct would refuse the second registration.
const base = config(__dirname, { excludes: ['meta-extension'] });

// This app is not served to the browser directly. Rancher fetches its index.html
// server-side (ui-dashboard-index) and serves it from its own origin, and the browser
// then pulls every asset and the HMR socket back through a k8s proxy. That inverts
// three of the shell's dev server defaults.
//
// DEV_HOST_BASE is the browser-reachable URL of this dev server, which is the
// apiserver service proxy in front of the nginx pod that fronts this container.
const hostBase = process.env.DEV_HOST_BASE;

if (!hostBase) {
  throw new Error('DEV_HOST_BASE must be set - it is the browser-reachable base URL of this dev server');
}

const wsBase = hostBase.replace(/^http/, 'ws');

base.devServer = {
  ...base.devServer,

  // Rancher fetches index.html with a stock http.Client, which rejects the shell's
  // self-signed dev certificate. Serve plaintext and let Rancher's own TLS terminate.
  server: { type: 'http' },

  // Requests arrive with whatever Host the proxy chain last set, never this server's own.
  allowedHosts: 'all',

  // Assets are addressed at the proxy URL, but the proxy strips its prefix before the
  // request lands here, so the dev middleware still serves from the root.
  devMiddleware: { publicPath: '/' },

  client: {
    ...base.devServer.client,
    webSocketURL: `${ wsBase }/ws`
  }
};

module.exports = base;
