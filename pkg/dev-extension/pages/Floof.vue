<script>
import Loading from '@shell/components/Loading';
import ResourceTable from '@shell/components/ResourceTable';
import { CONFIG_MAP } from '@shell/config/types';

/**
 * An extension page inside Rancher's own Cluster Explorer.
 *
 * Two things make it a real explorer page rather than a page that merely looks like one:
 * the route is registered under the explorer's `c-cluster-` parent so the cluster nav and
 * switcher stay in place, and the rows come from the Steve `cluster` store, so ResourceTable
 * gets the same schema-driven columns, sorting, grouping and live updates it gives any
 * built-in list.
 */
export default {
  // Two words to satisfy vue/multi-word-component-names, which exists so a component can
  // never collide with a current or future HTML element. The page is still "Floof".
  name: 'FloofPage',

  components: { Loading, ResourceTable },

  async fetch() {
    // The schema comes back with the resource, and ResourceTable needs it to build columns -
    // without it the table renders but has nothing to put in the header row.
    this.rows = await this.$store.dispatch('cluster/findAll', { type: CONFIG_MAP });
  },

  data() {
    return { rows: [] };
  },

  computed: {
    schema() {
      return this.$store.getters['cluster/schemaFor'](CONFIG_MAP);
    }
  }
};
</script>

<template>
  <Loading v-if="$fetchState.pending" />
  <div
    v-else
    class="floof"
  >
    <header>
      <h1>Floof</h1>
      <p class="subheader">
        doof
      </p>
    </header>

    <ResourceTable
      :schema="schema"
      :rows="rows"
      :headers="schema ? null : []"
    />
  </div>
</template>

<style lang="scss" scoped>
  .floof {
    header {
      // The shell styles `header` as a flex row (it is the masthead pattern on every list
      // page), which puts the subheader out to the right of the title instead of under it.
      // Overridden rather than renamed so the element stays semantically the page header.
      display:        block;
      margin-bottom:  20px;

      h1 {
        margin-bottom: 0;
      }

      .subheader {
        margin:  0;
        opacity: 0.7;
      }
    }
  }
</style>
