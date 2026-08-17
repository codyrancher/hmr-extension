import Secret from '@shell/models/secret';

/**
 * DevExtension's override of the shell's Secret model.
 *
 * `importTypes()` registers everything under `models/` by filename, and an extension's model
 * wins over the shell's of the same name - so this class is what every `secret` resource in
 * the dashboard is instantiated as while the dev loop is on.
 *
 * Right now it is a pure clone: it extends the shell's model and changes nothing, so
 * behaviour is identical and this is only a seam. Add overrides here - a getter, a different
 * `details`, an extra action - and they take effect on the running instance without touching
 * the shell's own copy.
 *
 * Overriding rather than editing `@rancher/shell/models/secret.js` in place matters: the
 * shell copy is a node_modules file, so an edit there is invisible to anyone reading this
 * repo and is lost the moment the pod's tree is rebuilt from the seed.
 */
export default class DevSecret extends Secret {}
