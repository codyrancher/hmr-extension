#!/usr/bin/env bash
# Build MetaExtension and install it into Rancher as a UIPlugin.
#
# MetaExtension is a normal, built extension - not part of the dev build - so it loads
# identically whether Rancher is serving its own bundled UI or the DevExtension dev build.
# That matters because MetaExtension is what turns the dev loop on and off.
#
# Rancher's plugin proxy (noCache: true) refuses any endpoint that resolves to a private
# address, which is every address here. The caching path has no such check, so this serves
# the plugin over plain http and lets Rancher's controller download it.
set -euo pipefail

set -a
source /workspace/.env
set +a

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
NAME=meta-extension
VERSION=$(node -p "require('$APP_DIR/pkg/$NAME/package.json').version")
SERVE_ROOT="$APP_DIR/.plugin-server"
PORT=4500
RANCHER="https://${RANCHER_HOST_NAME}"

cd "$APP_DIR"

echo "==> baking the DevExtension source into MetaExtension as a seed"
node scripts/generate-seed.mjs

echo "==> building $NAME@$VERSION"
yarn build-pkg "$NAME" >/dev/null

echo "==> laying out the plugin server root"
# Rancher's downloader wants plugin/package.json, a files.txt of relative paths, and then
# each file it names.
rm -rf "$SERVE_ROOT"
mkdir -p "$SERVE_ROOT/plugin"
cp -r "$APP_DIR/dist-pkg/$NAME-$VERSION/." "$SERVE_ROOT/plugin/"
(cd "$SERVE_ROOT" && find plugin -type f | sort > files.txt)

echo "==> serving on :$PORT"
if ! curl -sf "http://127.0.0.1:$PORT/files.txt" >/dev/null 2>&1; then
  # Every fd is reassigned before backgrounding: an inherited stdout keeps this script's
  # pipe open, so a caller piping into `tail` would hang forever waiting for EOF.
  (cd "$SERVE_ROOT" && setsid node "$APP_DIR/plugin-server.mjs" > "$APP_DIR/.plugin-server.log" 2>&1 < /dev/null & disown) &
  sleep 2
fi
curl -sf "http://127.0.0.1:$PORT/plugin/package.json" >/dev/null || { echo "plugin server did not come up"; exit 1; }

TOKEN=$(curl -sk "$RANCHER/v3-public/localProviders/local?action=login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$RANCHER_ADMIN_USER\",\"password\":\"$RANCHER_ADMIN_PASS\"}" \
  | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).token")

CR="$RANCHER/k8s/clusters/local/apis/catalog.cattle.io/v1/namespaces/cattle-ui-plugin-system/uiplugins/$NAME"

echo "==> registering the UIPlugin"
curl -sk -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  "$RANCHER/k8s/clusters/local/api/v1/namespaces" \
  -d '{"metadata":{"name":"cattle-ui-plugin-system"}}' >/dev/null 2>&1 || true

# A spec change is what makes the controller re-download; a content-only change is invisible
# to it. Stamping the build time forces the refresh on every publish.
STAMP=$(date +%s)
if curl -sk -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$CR" | grep -q 200; then
  curl -sk -X PATCH -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/merge-patch+json' "$CR" \
    -d "{\"spec\":{\"plugin\":{\"version\":\"$VERSION\",\"endpoint\":\"http://hmr-extension:$PORT\",\"noCache\":false,\"metadata\":{\"buildStamp\":\"$STAMP\"}}}}" >/dev/null
else
  curl -sk -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    "$RANCHER/k8s/clusters/local/apis/catalog.cattle.io/v1/namespaces/cattle-ui-plugin-system/uiplugins" -d "{
      \"apiVersion\":\"catalog.cattle.io/v1\",\"kind\":\"UIPlugin\",
      \"metadata\":{\"name\":\"$NAME\",\"namespace\":\"cattle-ui-plugin-system\"},
      \"spec\":{\"plugin\":{
        \"name\":\"$NAME\",\"version\":\"$VERSION\",
        \"endpoint\":\"http://hmr-extension:$PORT\",
        \"noCache\":false,\"noAuth\":false,
        \"metadata\":{\"catalog.cattle.io/ui-extensions-version\":\">= 3.0.0\",\"buildStamp\":\"$STAMP\"}
      }}}" >/dev/null
fi

echo "==> waiting for Rancher to cache it"
for _ in $(seq 1 20); do
  if curl -sk -H "Authorization: Bearer $TOKEN" "$RANCHER/v1/uiplugins" | grep -q '"CacheState":"cached"'; then
    echo "cached and ready: $RANCHER/v1/uiplugins/$NAME/$VERSION/plugin/$NAME-$VERSION.umd.min.js"
    exit 0
  fi
  sleep 3
done

echo "timed out waiting for the cache; current index:"
curl -sk -H "Authorization: Bearer $TOKEN" "$RANCHER/v1/uiplugins"
exit 1
