export const PRODUCT_NAME = 'devextension';
export const CUSTOM_PAGE_NAME = 'home';

// Rancher's stand-in cluster id for a product that has no cluster of its own.
export const BLANK_CLUSTER = '_';

export const HOME_ROUTE = `${ PRODUCT_NAME }-c-cluster-${ CUSTOM_PAGE_NAME }`;

/**
 * The Floof page, which lives in Rancher's Cluster Explorer rather than in this extension's
 * own product.
 *
 * Hence the naming: explorer pages are `c-cluster-<product>-<page>`, matching the shell's own
 * (`c-cluster-explorer-tools`, `c-cluster-explorer-workload-dashboard`). Getting this wrong
 * is the usual reason an extension page renders without the cluster nav around it - the route
 * has to sit under the explorer's parent for the surrounding chrome to come with it.
 */
export const EXPLORER_PRODUCT = 'explorer';
export const FLOOF_PAGE = 'floof';
export const FLOOF_ROUTE = `c-cluster-${ EXPLORER_PRODUCT }-${ FLOOF_PAGE }`;
