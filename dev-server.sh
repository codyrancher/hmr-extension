#!/usr/bin/env bash
# Run the DevExtension dev server so the live Rancher can serve it.
#
# The browser never talks to this port directly. Rancher fetches index.html from
# http://hmr-extension:8005/index.html (server-side, plain http), and every asset plus
# the HMR websocket comes back through the k8s proxy in DEV_HOST_BASE.
set -euo pipefail

set -a
source /workspace/.env
set +a

RANCHER="${RANCHER_HOST_NAME:-hmr-extension-rancher}"
NS="${DEV_EXT_NAMESPACE:-dev-extension-system}"
PROXY_PATH="/k8s/clusters/local/api/v1/namespaces/${NS}/services/http:devproxy:8080/proxy"

export DEV_HOST_BASE="https://${RANCHER}${PROXY_PATH}"
export RESOURCE_BASE="$DEV_HOST_BASE"
export ROUTER_BASE="/dashboard/"
export API="https://${RANCHER}"
export NODE_ENV=dev

echo "Dev server for DevExtension"
echo "  browser-reachable base : $DEV_HOST_BASE"
echo "  rancher fetches index  : http://hmr-extension:8005/index.html"
echo ""

cd "$(dirname "$0")"
exec ./node_modules/.bin/vue-cli-service serve
