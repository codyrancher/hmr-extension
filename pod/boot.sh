#!/bin/sh
# First-boot script for the dev server pod.
#
# A real file rather than a template literal in manifests.ts. It used to be the latter, and
# two separate places had to reproduce its escaping to get the text back out - MetaExtension
# by evaluating the template, sync-seed by regex. The regex missed `\\` line continuations
# and left `${ ... }` unsubstituted, which crashlooped the pod and took the whole dashboard
# down with it, because the dashboard is what this pod serves. One file, one escaping.
#
# Placeholder tokens are substituted by scripts/generate-seed.mjs from the values in
# pkg/meta-extension/config/constants.ts, so the names here cannot drift from the objects
# MetaExtension creates.
set -e

mkdir -p /app
cd /app

if [ ! -f /app/package.json ]; then
  echo "[boot] seeding source from the ConfigMap"
  for f in /seed/*; do
    name=$(basename "$f")
    [ "$name" = "boot.sh" ] && continue
    dest="/app/$(echo "$name" | sed 's|__PATH_SEPARATOR__|/|g')"
    mkdir -p "$(dirname "$dest")"
    cp "$f" "$dest"
  done
else
  echo "[boot] existing tree found, keeping it"
fi

export YARN_CACHE_FOLDER=/app/.yarn-cache

if [ ! -d /app/node_modules ]; then
  echo "[boot] installing dependencies (first start only, this takes a few minutes)"
  yarn install --network-timeout 600000
fi

# This image is community Rancher, whose /rancherversion reports RancherPrime=false, and
# prime-only extensions refuse to load without it - the AI assistant growls "Rancher Prime
# subscription required" and never registers. Prime images are behind a subscription registry
# and cannot be pulled here, so the flag is overridden in the build instead.
#
# setVersionData is the only correct place. Patching isRancherPrime() looks equivalent and is
# not: shell/core/plugin.ts builds the extension-facing environment from
# getVersionData().RancherPrime directly and never calls isRancherPrime(), so an extension's
# prime check would still see false. Overriding the stored data covers both readers.
#
# This is a client-side development override. It does not grant an entitlement and has no
# business leaving this instance.
VERSION_JS=/app/node_modules/@rancher/shell/config/version.js
if [ -f "$VERSION_JS" ] && ! grep -q DEV-PRIME-OVERRIDE "$VERSION_JS"; then
  echo "[boot] forcing RancherPrime=true in the shell's version data"
  sed -i "s|  _versionData = JSON.parse(JSON.stringify(v));|  _versionData = JSON.parse(JSON.stringify(v));\n  _versionData.RancherPrime = 'true'; // DEV-PRIME-OVERRIDE|" "$VERSION_JS"
fi

# The MCP server that lets Rancher's AI assistant work in this pod. Starting it here is
# harmless on its own: nothing reaches it until MetaExtension creates the AIAgentConfig that
# names it, and deleting that config is what revokes access.
#
# It presents a self-signed certificate, which MetaExtension copies into a Secret for the
# agent's caBundleRef - the certificate is its own CA, so no separate signing step is needed.
# mcpURL carries no scheme, so the agent may connect over either http or https; both are
# served, and generating this is best-effort so a failure here cannot stop the pod.
MCP_TLS=/app/.mcp-tls
if [ ! -f "$MCP_TLS/cert.pem" ]; then
  echo "[boot] generating a self-signed certificate for the MCP server"
  mkdir -p "$MCP_TLS"
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$MCP_TLS/key.pem" -out "$MCP_TLS/cert.pem" \
    -subj "/CN=__MCP_SERVICE__.__DEV_NAMESPACE__.svc" \
    -addext "subjectAltName=DNS:__MCP_SERVICE__,DNS:__MCP_SERVICE__.__DEV_NAMESPACE__,DNS:__MCP_SERVICE__.__DEV_NAMESPACE__.svc,DNS:__MCP_SERVICE__.__DEV_NAMESPACE__.svc.cluster.local" \
    >/dev/null 2>&1 || echo "[boot] certificate generation failed; the MCP server will serve http only"
fi

# Respawned rather than run once: nothing else supervises it, and the pod's readiness probe
# watches the dev server, so an MCP server that died would stay dead and silently.
#
# `set +e` inside the subshell is load-bearing. errexit is inherited, so without it the first
# non-zero exit from node kills the loop itself - which is to say the supervisor dies at
# exactly the moment it exists to do something, and the only hint is a port that stopped
# answering. Restarting the MCP server (`pkill -f mcp-server.mjs`) is the normal way to pick
# up an edit to it without bouncing the pod, and that is precisely a non-zero exit.
if [ -f /app/mcp-server.mjs ]; then
  echo "[boot] starting the pod MCP server"
  ( set +e; while true; do node /app/mcp-server.mjs; echo "[mcp] exited, restarting in 2s"; sleep 2; done ) &
else
  echo "[boot] no /app/mcp-server.mjs in this tree; skipping the MCP server"
fi

echo "[boot] starting the dev server"
exec ./node_modules/.bin/vue-cli-service serve
