// Push the full generated seed into the cluster ConfigMap AND into the running pod's tree.
//
// The ConfigMap is only rewritten by MetaExtension's install(), so applying the Deployment
// by hand leaves it stale, and a tree wipe then re-seeds from the old content. Syncing both
// keeps "what a fresh install gets" and "what is running" in step.
import fs from 'fs';
import { execFileSync } from 'child_process';

const APP = '/workspace/dev-extension-app';
const NS = 'dev-extension-system';
const KUBECONFIG = `${ APP }/.kubeconfig`;
const env = { ...process.env, KUBECONFIG };
const kubectl = (args, opts = {}) => execFileSync('kubectl', args, { env, encoding: 'utf8', ...opts });

const gen = fs.readFileSync(`${ APP }/pkg/meta-extension/lib/seed.generated.ts`, 'utf8');
const files = JSON.parse(gen.slice(gen.indexOf('{'), gen.lastIndexOf('};') + 1));

// ConfigMap keys cannot contain '/', matching encodeSeedKey in manifests.ts.
const data = {};

for (const [p, contents] of Object.entries(files)) {
  data[p.split('/').join('__')] = contents;
}

// boot.sh needs no special handling: it is an ordinary entry in SEED_FILES, generated from
// pod/boot.sh. It used to be lifted out of manifests.ts with a regex here, which left `\\`
// and `${ ... }` unresolved and crashlooped the pod.
if (!files['boot.sh']) {
  throw new Error('the seed has no boot.sh - run scripts/generate-seed.mjs first');
}

// Replace `data` wholesale rather than merging it. A merge patch only adds and updates keys,
// so a file deleted from the repo lingers in the ConfigMap forever and a fresh install still
// receives it - `hmr-poll.js` outlived its own removal this way. The empty-object patch is
// what actually clears the old keys; merging the new data straight over them would not.
kubectl(['-n', NS, 'patch', 'configmap', 'dev-extension-seed', '--type', 'merge', '-p', JSON.stringify({ data: null })]);
kubectl(['-n', NS, 'patch', 'configmap', 'dev-extension-seed', '--type', 'merge', '-p', JSON.stringify({ data })]);
console.log(`seed ConfigMap synced (${ Object.keys(data).length } files, incl. boot.sh)`);

const pod = kubectl(['-n', NS, 'get', 'pod', '-l', 'app=devserver', '-o', 'jsonpath={.items[0].metadata.name}']).trim();

// The pod keeps its own tree across restarts, so the ConfigMap alone would not reach it.
// boot.sh is the exception: it is mounted from the ConfigMap at /seed and run from there,
// and the seeding loop inside it deliberately skips itself.
for (const [p, contents] of Object.entries(files)) {
  if (p === 'boot.sh') {
    continue;
  }

  const tmp = `/tmp/seed-${ p.split('/').join('_') }`;

  fs.writeFileSync(tmp, contents);
  kubectl(['exec', '-n', NS, pod, '--', 'mkdir', '-p', `/app/${ p.split('/').slice(0, -1).join('/') || '.' }`], { stdio: 'pipe' });
  kubectl(['cp', tmp, `${ NS }/${ pod }:/app/${ p }`], { stdio: 'pipe' });
  fs.unlinkSync(tmp);
}

console.log(`pod tree synced into ${ pod }`);
