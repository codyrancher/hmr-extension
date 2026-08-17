import ConfigMap from '@shell/models/configmap';

// Extend the shell ConfigMap model rather than replace it: extension models override by key,
// so a bare class here would drop keysDisplay / fullDetailPageOverride. The `doof` getter backs
// the hardcoded 'Floof' column, which references it by value path ('doof').
export default class DevConfigMap extends ConfigMap {
  get doof() {
    return 'doof';
  }
}
