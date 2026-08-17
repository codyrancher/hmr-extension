import {
  DEV_NAMESPACE, DEV_SERVER, DEV_SERVER_PORT, DEV_SERVER_IMAGE,
  SEED_CONFIGMAP, HOST_CACHE_PATH, HOST_UI_PATH, ASSET_SUBDIR, assetBase, proxyPath,
  MCP_SERVICE, MCP_HTTP_PORT, MCP_HTTPS_PORT
} from '../config/constants';
import { SEED_FILES } from './seed.generated';

/** The little of a Kubernetes object this code needs to know about to create or replace it. */
export interface K8sObject {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; resourceVersion?: string };
  [key: string]: unknown;
}

export interface ManifestEntry {
  /** Collection URL the object is created in. */
  url: string;
  body: K8sObject;
}

/**
 * The version the DevExtension UIPlugin has to be registered under.
 *
 * Read out of the seeded package.json rather than repeated as a constant: the seed is the
 * same file the pod builds from, so this cannot drift from what the build actually produces.
 */
export function devExtensionVersion(): string {
  return JSON.parse(SEED_FILES['pkg/dev-extension/package.json']).version;
}

/** ConfigMap keys cannot contain '/', so paths are flattened and rebuilt on the way out. */
export const PATH_SEPARATOR = '__';

export function encodeSeedKey(filePath: string): string {
  return filePath.split('/').join(PATH_SEPARATOR);
}

/**
 * First-boot script for the dev server pod.
 *
 * The script itself is `pod/boot.sh`, baked into the seed like everything else the pod
 * needs. It was a template literal here until the escaping had to be reproduced by a second
 * consumer (scripts/sync-seed.mjs), got it wrong, and crashlooped the pod - which, since
 * this pod serves the dashboard, took the whole UI down. Now there is one copy and nothing
 * to re-escape.
 */
export function bootScript(): string {
  return SEED_FILES['boot.sh'];
}

/**
 * Every object MetaExtension installs, in dependency order.
 *
 * Nothing here is parameterised. The dev server runs inside the cluster, so there is no
 * external host or address to be told about - every name and port is a constant, and the
 * only runtime value (the Service's ClusterIP) is read back after creation.
 */
export function devLoopManifests(): ManifestEntry[] {
  const core = '/k8s/clusters/local/api/v1';
  const seedData: Record<string, string> = { 'boot.sh': bootScript() };

  for (const [filePath, contents] of Object.entries(SEED_FILES)) {
    seedData[encodeSeedKey(filePath)] = contents;
  }

  return [
    {
      url:  `${ core }/namespaces`,
      body: {
        apiVersion: 'v1',
        kind:       'Namespace',
        metadata:   { name: DEV_NAMESPACE }
      }
    },
    {
      url:  `${ core }/namespaces/${ DEV_NAMESPACE }/configmaps`,
      body: {
        apiVersion: 'v1',
        kind:       'ConfigMap',
        metadata:   { name: SEED_CONFIGMAP, namespace: DEV_NAMESPACE },
        data:       seedData
      }
    },
    {
      url:  `/k8s/clusters/local/apis/apps/v1/namespaces/${ DEV_NAMESPACE }/deployments`,
      body: {
        apiVersion: 'apps/v1',
        kind:       'Deployment',
        metadata:   { name: DEV_SERVER, namespace: DEV_NAMESPACE },
        spec:       {
          replicas: 1,
          selector: { matchLabels: { app: DEV_SERVER } },
          strategy: { type: 'Recreate' },
          template: {
            metadata: { labels: { app: DEV_SERVER } },
            spec:     {
              containers: [{
                name:    'devserver',
                image:   DEV_SERVER_IMAGE,
                command: ['/bin/sh', '/seed/boot.sh'],
                ports:   [
                  { name: 'http', containerPort: DEV_SERVER_PORT },
                  { name: 'mcp', containerPort: MCP_HTTP_PORT },
                  { name: 'mcps', containerPort: MCP_HTTPS_PORT }
                ],
                env: [
                  { name: 'DEV_PROXY_PATH', value: proxyPath() },
                  { name: 'DEV_ASSET_BASE', value: assetBase() },
                  { name: 'DEV_ASSET_DIR', value: `/uidash/dashboard/${ ASSET_SUBDIR }` },
                  { name: 'ROUTER_BASE', value: '/dashboard/' },
                  { name: 'NODE_ENV', value: 'dev' },
                  // The shell's dev config wants an API to proxy to and version-check
                  // against. The browser never uses it - the page is same-origin with
                  // Rancher - but the build refuses to start without one.
                  { name: 'API', value: 'https://rancher.cattle-system.svc.cluster.local' },
                  { name: 'NODE_TLS_REJECT_UNAUTHORIZED', value: '0' },
                  { name: 'NODE_OPTIONS', value: '--max_old_space_size=4096' }
                ],
                volumeMounts: [
                  { name: 'seed', mountPath: '/seed' },
                  { name: 'app', mountPath: '/app' },
                  // Rancher's static UI dir, so the build output lands somewhere Rancher
                  // will serve without authentication.
                  { name: 'uidash', mountPath: '/uidash' }
                ],
                // Installing and the first compile take minutes. A startup probe with a
                // long budget keeps the kubelet from restarting a pod that is working fine.
                startupProbe: {
                  httpGet:          { path: '/index.html', port: DEV_SERVER_PORT },
                  periodSeconds:    10,
                  failureThreshold: 90
                },
                readinessProbe: {
                  httpGet:       { path: '/index.html', port: DEV_SERVER_PORT },
                  periodSeconds: 10
                }
              }],
              volumes: [
                { name: 'seed', configMap: { name: SEED_CONFIGMAP } },
                { name: 'app', hostPath: { path: HOST_CACHE_PATH, type: 'DirectoryOrCreate' } },
                { name: 'uidash', hostPath: { path: HOST_UI_PATH, type: 'Directory' } }
              ]
            }
          }
        }
      }
    },
    {
      url:  `${ core }/namespaces/${ DEV_NAMESPACE }/services`,
      body: {
        apiVersion: 'v1',
        kind:       'Service',
        metadata:   { name: DEV_SERVER, namespace: DEV_NAMESPACE },
        spec:       {
          selector: { app: DEV_SERVER },
          ports:    [{
            name: 'http', port: DEV_SERVER_PORT, targetPort: 'http'
          }]
        }
      }
    },
    {
      // A Service of its own purely so the MCP server has its own DNS name to put in
      // `mcpURL`. Ports 80 and 443 both answer, mirroring Rancher's own MCP Service: the
      // agent is given a bare host and picks the scheme, so both have to work.
      url:  `${ core }/namespaces/${ DEV_NAMESPACE }/services`,
      body: {
        apiVersion: 'v1',
        kind:       'Service',
        metadata:   { name: MCP_SERVICE, namespace: DEV_NAMESPACE },
        spec:       {
          selector: { app: DEV_SERVER },
          ports:    [
            {
              name: 'http', port: 80, targetPort: 'mcp'
            },
            {
              name: 'https', port: 443, targetPort: 'mcps'
            }
          ]
        }
      }
    }
  ];
}
