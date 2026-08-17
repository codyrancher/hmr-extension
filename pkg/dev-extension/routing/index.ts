import { RouteRecordRaw } from 'vue-router';
import { PluginRouteRecordRaw } from '@shell/core/types';
import {
  PRODUCT_NAME, CUSTOM_PAGE_NAME, BLANK_CLUSTER, HOME_ROUTE,
  EXPLORER_PRODUCT, FLOOF_PAGE, FLOOF_ROUTE
} from '../config/constants';
import DevHome from '../pages/DevHome.vue';
import Floof from '../pages/Floof.vue';

/**
 * This extension's own product page. Top-level products need the `/{product}/c/:cluster/`
 * shape and the BLANK_CLUSTER param, since they have no cluster of their own.
 */
const ownRoutes: RouteRecordRaw[] = [
  {
    name:      HOME_ROUTE,
    path:      `/${ PRODUCT_NAME }/c/:cluster/${ CUSTOM_PAGE_NAME }`,
    component: DevHome,
    meta:      {
      product: PRODUCT_NAME,
      cluster: BLANK_CLUSTER
    }
  }
];

/**
 * Floof, which belongs to Rancher's Cluster Explorer rather than to this extension.
 *
 * `parent: 'default'` is what makes it an explorer page rather than a bare page at an
 * explorer-shaped URL. The shell's own cluster pages are children of the `default` template
 * route (shell/config/router/routes.js), which is what supplies the side nav, the cluster
 * switcher and the header. Registered at the top level instead, the component renders alone
 * on a blank page - the usual symptom of getting this wrong.
 *
 * `meta.product` is equally load-bearing: it tells the shell which product's nav to show and
 * which entry to highlight. Without it the page renders inside the explorer but the nav does
 * not know Floof is the current page.
 */
const explorerRoutes: PluginRouteRecordRaw[] = [
  {
    parent: 'default',
    route:  {
      name:      FLOOF_ROUTE,
      path:      `/c/:cluster/${ EXPLORER_PRODUCT }/${ FLOOF_PAGE }`,
      component: Floof,
      meta:      { product: EXPLORER_PRODUCT }
    }
  }
];

export default [...ownRoutes, ...explorerRoutes];
