import { IPlugin } from '@shell/core/types';
import { PRODUCT_NAME, CUSTOM_PAGE_NAME, BLANK_CLUSTER, HOME_ROUTE } from './config/constants';

// `store` is the raw Vuex store the extension manager hands to every product init, and
// $plugin.DSL takes it as `any`. There is no narrower type to reach for.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function init($plugin: IPlugin, store: any) {
  const { product, basicType, virtualType } = $plugin.DSL(store, PRODUCT_NAME);

  product({
    icon:                'gear',
    inStore:             'management',
    weight:              99,
    showClusterSwitcher: false,
    to:                  {
      name:   HOME_ROUTE,
      params: { product: PRODUCT_NAME, cluster: BLANK_CLUSTER }
    }
  });

  virtualType({
    name:  CUSTOM_PAGE_NAME,
    label: 'Dev Loop',
    route: {
      name:   HOME_ROUTE,
      params: { product: PRODUCT_NAME, cluster: BLANK_CLUSTER }
    },
    weight: 100
  });

  basicType([CUSTOM_PAGE_NAME]);
}
