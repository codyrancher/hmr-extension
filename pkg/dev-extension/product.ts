import { IPlugin } from '@shell/core/types';
import {
  PRODUCT_NAME, CUSTOM_PAGE_NAME, BLANK_CLUSTER, HOME_ROUTE,
  EXPLORER_PRODUCT, FLOOF_PAGE, FLOOF_ROUTE
} from './config/constants';

// `store` is the raw Vuex store the extension manager hands to every product init, and
// $plugin.DSL takes it as `any`. There is no narrower type to reach for.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function init($plugin: IPlugin, store: any) {
  const { product, basicType, virtualType } = $plugin.DSL(store, PRODUCT_NAME);

  // `public` is what makes the product visible without a session, and the shell honours it at
  // runtime, but TypeMapProduct does not declare it. The dev build only warns; the production
  // build that `hmr: off` mode needs treats it as an error, so the literal is widened here.
  const productOpts: Record<string, unknown> = {
    icon:                'flask',
    public:              true,
    inStore:             'management',
    weight:              100,
    showClusterSwitcher: false,
    to:                  {
      name:   HOME_ROUTE,
      params: { product: PRODUCT_NAME, cluster: BLANK_CLUSTER }
    }
  };

  product(productOpts);

  virtualType({
    name:  CUSTOM_PAGE_NAME,
    label: 'Live Reload Demo',
    route: {
      name:   HOME_ROUTE,
      params: { product: PRODUCT_NAME, cluster: BLANK_CLUSTER }
    },
    weight: 100
  });

  basicType([CUSTOM_PAGE_NAME]);

  // Floof goes into Rancher's Cluster Explorer, not into this product.
  //
  // A second DSL() call scoped to 'explorer' is how an extension adds to a product it does
  // not own - the same virtualType/basicType calls, aimed at someone else's nav. `group:
  // 'Root'` puts it at the top level alongside Cluster and Workloads rather than inside a
  // resource group, matching how the shell registers its own non-resource pages.
  const explorer = $plugin.DSL(store, EXPLORER_PRODUCT);

  explorer.virtualType({
    name:       FLOOF_PAGE,
    label:      'Floof',
    group:      'Root',
    icon:       'folder',
    namespaced: false,
    weight:     99,
    route:      { name: FLOOF_ROUTE },
    exact:      true
  });

  explorer.basicType([FLOOF_PAGE], 'Root');
}
