<script>
import {
  reconcile, enable, disable, demoState, runDemoAction, buildNow, setHmr, waitPluginCached,
  enableAgentAccess, disableAgentAccess
} from '../lib/dev-loop';
import { DESIRED_ENABLED, HMR_ON } from '../config/constants';

/** Poll the pod until a build it is running finishes, so the page can report the outcome. */
async function waitForBuild(onProgress) {
  // Generous: a cold UMD build of the whole extension is minutes, not seconds.
  const deadline = Date.now() + 15 * 60 * 1000;

  while (Date.now() < deadline) {
    const demo = await demoState();

    if (!demo.build.building) {
      return demo;
    }

    onProgress?.('building the extension bundle (this takes a few minutes)');
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  throw new Error('the build did not finish in time');
}

export default {
  name: 'DevLoop',

  data() {
    return {
      state:     null,
      demo:      null,
      demoBusy:  '',
      demoError: null,
      busy:      false,
      progress:  '',
      error:     null,
      timer:     null
    };
  },

  async mounted() {
    await this.refresh();
    // The dev server takes minutes to come up on a cold start; keep the page honest
    // without making the user reload it.
    this.timer = setInterval(() => {
      if (!this.busy) {
        this.refresh();
      }
    }, 10000);
  },

  beforeUnmount() {
    if (this.timer) {
      clearInterval(this.timer);
    }
  },

  computed: {
    // Whether the dev loop is meant to be running at all. Deliberately not `state.enabled`,
    // which only says whether the dashboard settings point at the pod: UMD mode restores
    // those settings on purpose, so reading them would report the loop as off while it is
    // very much on and serving DevExtension through a UIPlugin.
    loopOn() {
      return !!this.state && this.state.desired === DESIRED_ENABLED;
    },

    /** Has the mode the user asked for actually been put in place? */
    modeSettled() {
      if (!this.state) {
        return false;
      }

      return this.hmrOn ? this.state.enabled : this.state.pluginInstalled && !this.state.enabled;
    },

    // desired outlives a single page load - it is what makes an interrupted enable()
    // resumable - so this is true whenever there is unfinished work, whether or not this
    // tab is the one that started it.
    pendingActivation() {
      return this.loopOn && !this.modeSettled;
    },

    hmrOn() {
      return !this.state || this.state.hmr === HMR_ON;
    },

    build() {
      return this.demo?.build || null;
    },

    /** Human wording for the build line. The raw fields read as machine state. */
    buildSummary() {
      const b = this.build;

      if (!b) {
        return '';
      }

      if (b.building) {
        return 'building now...';
      }

      if (b.status === 'never') {
        return 'never built';
      }

      if (b.status === 'failed') {
        return `failed: ${ b.error || 'unknown error' }`;
      }

      const seconds = Math.round((b.durationMs || 0) / 1000);

      return `${ new Date(b.finishedAt).toLocaleString() } (${ b.trigger }, ${ seconds }s, v${ b.version })`;
    },

    /** Countdown on the idle timer, so the automatic build is not a black box. */
    autoBuildSummary() {
      const b = this.build;

      if (!b) {
        return '';
      }

      // Kept rather than blanked while a build runs: an empty string removes the row and the
      // rest of the panel jumps up to fill the gap.
      if (b.building) {
        return 'paused while a build is running';
      }

      if (b.autoBuildInMs === null) {
        return 'idle - no build queued';
      }

      return `automatic build in ${ Math.ceil(b.autoBuildInMs / 60000) } min of quiet`;
    }
  },

  methods: {
    async refresh() {
      try {
        // reconcile(), not status(): a page load is how an enable() interrupted by a closed
        // tab or a navigation gets finished, since nothing else re-runs it client-side.
        this.state = await reconcile(this.$store);
      } catch (e) {
        this.error = e?.message || String(e);
      }

      // Only reachable once the dev server is up, so a failure here is expected while the
      // loop is off and should not be shown as an error.
      try {
        this.demo = this.state?.serverReady ? await demoState() : null;
      } catch {
        this.demo = null;
      }
    },

    async runDemo(action) {
      this.demoBusy = action;
      this.demoError = null;

      try {
        this.demo = await runDemoAction(action);
      } catch (e) {
        this.demoError = e?.message || String(e);
      } finally {
        this.demoBusy = '';
      }
    },

    async run(fn) {
      this.busy = true;
      this.error = null;
      this.progress = '';

      try {
        await fn();
      } catch (e) {
        this.error = e?.message || JSON.stringify(e);
      } finally {
        this.busy = false;
        this.progress = '';
        await this.refresh();
      }
    },

    onEnable() {
      return this.run(() => enable(this.$store, (m) => {
        this.progress = m;
      }));
    },

    onDisable() {
      return this.run(() => disable(this.$store));
    },

    /**
     * Switch serving mode, then reload.
     *
     * The reload is not a convenience. Both directions replace the dashboard bundle the
     * browser is currently running - one of them is served by the pod and the other by
     * Rancher - so the page you are on is stale the moment the settings change.
     */
    onToggleHmr() {
      const on = !this.hmrOn;

      return this.run(async() => {
        const progress = (m) => {
          this.progress = m;
        };

        // Turning HMR off hands the extension over to the UMD bundle, so there had better be
        // one. Without this the mode switch appears to work and DevExtension simply vanishes.
        if (!on && this.build && this.build.status !== 'ok') {
          progress('no bundle has been built yet, building one first');
          await buildNow();

          const done = await waitForBuild(progress);

          if (done.build.status !== 'ok') {
            throw new Error(`the build failed, staying on HMR: ${ done.build.error }`);
          }
        }

        progress(on ? 'pointing Rancher at the dev server' : 'registering the DevExtension UIPlugin');
        await setHmr(this.$store, on);

        if (!on) {
          await waitPluginCached(this.$store, progress);
        }

        progress('reloading');
        window.location.reload();
      });
    },

    /**
     * Grant or revoke the AI assistant's shell in the pod.
     *
     * No reload: this changes nothing about what the browser is running, only what Rancher's
     * assistant is allowed to do. The status row picks the result up on the next poll.
     */
    onToggleAgent() {
      const grant = !this.state?.agentAccess;

      return this.run(async() => {
        this.progress = grant ? 'giving the assistant a shell in the pod' : 'revoking it';
        await (grant ? enableAgentAccess(this.$store) : disableAgentAccess(this.$store));
      });
    },

    /** Build now rather than waiting out the idle timer. Does not block the page. */
    onBuild() {
      this.demoBusy = 'build';
      this.demoError = null;

      return buildNow()
        .then((demo) => {
          this.demo = demo;
        })
        .catch((e) => {
          this.demoError = e?.message || String(e);
        })
        .finally(() => {
          this.demoBusy = '';
        });
    }
  }
};
</script>

<template>
  <div class="dev-loop">
    <h1>Dev Loop</h1>
    <p class="intro">
      Runs DevExtension's dev server as a pod in this cluster. With <strong>HMR on</strong>,
      Rancher's dashboard index points at that pod, so the Rancher you are looking at is served
      by it and edits hot-reload into this page. With <strong>HMR off</strong>, Rancher serves
      its own dashboard again and DevExtension is loaded the ordinary way, from a UMD bundle
      the pod builds - no dev build in front of the UI and no polling, at the cost of needing
      a build to see a change.
    </p>

    <div
      v-if="error"
      class="banner error"
    >
      {{ error }}
    </div>

    <div
      v-if="state"
      class="status"
    >
      <div class="row">
        <span class="key">Dev loop</span>
        <span
          v-if="pendingActivation"
          class="badge pending"
        >
          {{ state.serverReady ? 'ACTIVATION PENDING' : 'WAITING ON POD' }}
        </span>
        <span
          v-else
          :class="['badge', loopOn ? 'on' : 'off']"
        >{{ loopOn ? 'ENABLED' : 'DISABLED' }}</span>
      </div>
      <p
        v-if="pendingActivation"
        class="hint"
      >
        Enable was requested but never finished switching Rancher over - probably a closed tab
        or a navigation during install. This page checks and finishes it automatically every
        10 seconds; no need to click Enable again.
      </p>
      <div class="row">
        <span class="key">Mode</span>
        <span :class="['badge', hmrOn ? 'on' : 'off']">{{ hmrOn ? 'HMR (live dev build)' : 'UMD (built bundle)' }}</span>
        <span
          v-if="!hmrOn"
          :class="['badge', state.pluginCached ? 'on' : 'pending']"
        >
          {{ state.pluginInstalled ? (state.pluginCached ? `UIPlugin CACHED v${ state.pluginVersion }` : 'UIPlugin DOWNLOADING') : 'UIPlugin MISSING' }}
        </span>
      </div>
      <div class="row">
        <span class="key">Dev server pod</span>
        <span :class="['badge', state.serverReady ? 'on' : 'off']">
          {{ state.serverReady ? 'READY' : state.installed ? 'STARTING' : 'NOT INSTALLED' }}
        </span>
      </div>
      <div class="row">
        <span class="key">AI assistant shell</span>
        <span :class="['badge', state.agentAccess ? (state.agentPhase === 'Ready' ? 'on' : 'pending') : 'off']">
          {{ state.agentAccess ? (state.agentPhase === 'Ready' ? 'GRANTED' : `GRANTED (${ state.agentPhase || 'pending' })`) : 'NOT GRANTED' }}
        </span>
      </div>
      <div class="row">
        <span class="key">Served from</span>
        <code>{{ state.clusterIp ? `${ state.clusterIp }:8005 (in-cluster)` : 'not installed' }}</code>
      </div>
      <div class="row">
        <span class="key">Asset path</span>
        <code>{{ state.proxyPath }}</code>
      </div>
    </div>

    <div class="actions">
      <button
        class="btn role-primary"
        :disabled="busy || loopOn"
        @click="onEnable"
      >
        Enable dev loop
      </button>
      <button
        class="btn role-secondary"
        :disabled="busy || !loopOn"
        @click="onDisable"
      >
        Disable dev loop
      </button>
      <button
        class="btn role-secondary"
        :disabled="busy || !loopOn || !state.serverReady"
        @click="onToggleHmr"
      >
        {{ hmrOn ? 'Turn HMR off (use built bundle)' : 'Turn HMR on (live reload)' }}
      </button>
      <span
        v-if="busy"
        class="progress"
      >{{ progress || 'working...' }}</span>
    </div>

    <div
      v-if="state"
      class="demo"
    >
      <h2>AI assistant shell</h2>
      <p class="intro">
        Rancher's assistant can inspect this cluster but cannot change the code running in it -
        none of its tools reach inside a container. This registers the dev server pod's own MCP
        server as an extra agent, giving the assistant <strong>read, write and shell access to the
          pod</strong>. Since the pod is what serves this dashboard, it can then change the running
        Rancher by editing it, and the edit hot-reloads.
      </p>
      <p class="hint">
        That is an unrestricted shell driven by a language model, on a tree whose edits reach every
        browser currently on this instance. Grant it deliberately. Revoking removes the agent
        config, which is what actually takes the access away; disabling the dev loop revokes it too.
      </p>

      <div class="demo-row">
        <button
          class="btn role-secondary"
          :disabled="busy || !loopOn || !state.serverReady"
          @click="onToggleAgent"
        >
          {{ state.agentAccess ? 'Revoke the assistant\'s shell' : 'Give the assistant a shell in the pod' }}
        </button>
        <span :class="['badge', state.agentAccess ? (state.agentPhase === 'Ready' ? 'on' : 'pending') : 'off']">
          {{ state.agentAccess ? (state.agentPhase || 'pending').toUpperCase() : 'NOT GRANTED' }}
        </span>
      </div>
    </div>

    <div
      v-if="build"
      class="demo"
    >
      <h2>Extension bundle</h2>
      <p class="intro">
        The pod builds DevExtension's UMD bundle by itself once the tree has been quiet for
        five minutes, so there is normally one ready when you turn HMR off. Build now if you
        do not want to wait.
      </p>

      <div class="demo-row">
        <button
          class="btn role-secondary"
          :disabled="!!demoBusy || build.building"
          @click="onBuild"
        >
          {{ build.building ? 'Building...' : 'Build the bundle now' }}
        </button>
        <span :class="['badge', build.building ? 'pending' : build.status === 'ok' ? 'on' : 'off']">{{ build.building ? 'BUILDING' : build.status.toUpperCase() }}</span>
      </div>

      <div class="row">
        <span class="key">Last built</span>
        <code>{{ buildSummary }}</code>
      </div>
      <div
        v-if="autoBuildSummary"
        class="row"
      >
        <span class="key">Automatic build</span>
        <code>{{ autoBuildSummary }}</code>
      </div>
    </div>

    <div
      v-if="demo"
      class="demo"
    >
      <h2>Live edits</h2>
      <p class="intro">
        Each button edits a file inside the dev server pod, exactly as typing in
        <code>./dev-shell</code> would. The page edit hot-reloads with no refresh; the other
        two register at load time, so reload to see them.
      </p>

      <div
        v-if="demoError"
        class="banner error"
      >
        {{ demoError }}
      </div>

      <div class="demo-row">
        <button
          class="btn role-secondary"
          :disabled="!!demoBusy"
          @click="runDemo('page-time')"
        >
          Update the DevExtension page time
        </button>
        <code>{{ demo.headline }}</code>
      </div>

      <div class="demo-row">
        <button
          class="btn role-secondary"
          :disabled="!!demoBusy"
          @click="runDemo('nav-toggle')"
        >
          Toggle the DevExtension nav button
        </button>
        <span :class="['badge', demo.navVisible ? 'on' : 'off']">{{ demo.navVisible ? 'VISIBLE' : 'HIDDEN' }}</span>
      </div>

      <div class="demo-row">
        <button
          class="btn role-secondary"
          :disabled="!!demoBusy"
          @click="runDemo('hello-toggle')"
        >
          Toggle HELLO on the login page
        </button>
        <span :class="['badge', demo.helloOn ? 'on' : 'off']">{{ demo.helloOn ? 'ON' : 'OFF' }}</span>
      </div>
    </div>

    <p class="warning">
      Rancher is only switched over once the pod is answering, so enabling cannot strand you.
      If the pod dies later, Rancher has no UI to serve and this page goes with it: recover
      with <code>./dev-loop off</code>, which restores the settings over the API.
    </p>
  </div>
</template>

<style lang="scss" scoped>
  .dev-loop {
    padding: 20px;
    max-width: 900px;

    .intro {
      max-width: 70ch;
      margin-bottom: 20px;
    }

    .banner.error {
      padding: 10px;
      margin-bottom: 15px;
      border: 1px solid var(--error);
      border-radius: 4px;
    }

    .status {
      margin-bottom: 20px;
    }

    // Shared by the status block and the bundle block, so it lives at the top level rather
    // than nested under .status - a nested copy is how the two drift apart.
    .row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 0;
      border-bottom: 1px solid var(--border);

      .key {
        width: 200px;
        opacity: 0.7;
      }

      code {
        word-break: break-all;
      }
    }

    .badge {
      padding: 2px 8px;
      border-radius: 3px;
      font-size: 12px;
      font-weight: bold;

      &.on {
        background: var(--success);
        color: white;
      }

      &.off {
        background: var(--border);
      }

      &.pending {
        background: var(--warning);
        color: white;
      }
    }

    .hint {
      margin: 0 0 10px;
      max-width: 70ch;
      font-size: 13px;
      color: var(--warning);
    }

    .actions {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 20px;

      .progress {
        opacity: 0.8;
        font-size: 13px;
      }
    }

    .demo {
      margin-bottom: 20px;
      padding-top: 10px;
      border-top: 1px solid var(--border);

      h2 {
        margin-bottom: 6px;
      }

      .demo-row {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 8px;

        .btn {
          min-width: 320px;
          justify-content: flex-start;
        }
      }
    }

    .warning {
      max-width: 70ch;
      opacity: 0.8;
      font-size: 13px;
    }
  }
</style>
