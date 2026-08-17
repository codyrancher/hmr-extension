import { RouteRecordRaw } from 'vue-router';
import { PRODUCT_NAME, CUSTOM_PAGE_NAME, BLANK_CLUSTER, HOME_ROUTE } from '../config/constants';
import DevLoop from '../pages/DevLoop.vue';

const routes: RouteRecordRaw[] = [
  {
    name:      HOME_ROUTE,
    path:      `/${ PRODUCT_NAME }/c/:cluster/${ CUSTOM_PAGE_NAME }`,
    component: DevLoop,
    meta:      {
      product: PRODUCT_NAME,
      cluster: BLANK_CLUSTER
    }
  }
];

export default routes;
