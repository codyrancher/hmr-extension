<script>
export default {
  name: 'DevHome',

  data() {
    return {
      // Edit this string and it should change in the running Rancher without a reload.
      headline: 'DevExtension is live',
      loadedAt: new Date().toLocaleTimeString()
    };
  }
};
</script>

<template>
  <div class="dev-home">
    <h1>{{ headline }}</h1>
    <p class="subtitle">
      This page is served by the DevExtension dev server, through the k8s proxy,
      into the Rancher instance you are looking at.
    </p>
    <div class="marker">
      component first rendered at {{ loadedAt }}
    </div>
  </div>
</template>

<style lang="scss" scoped>
  .dev-home {
    padding: 20px;

    h1 {
      color: var(--primary);
    }

    .subtitle {
      max-width: 60ch;
      margin-bottom: 20px;
    }

    .marker {
      display: inline-block;
      padding: 8px 12px;
      border: 1px solid var(--border);
      border-radius: 4px;
      font-family: monospace;
    }
  }
</style>
