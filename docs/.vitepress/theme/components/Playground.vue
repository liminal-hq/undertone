<!--
  The interactive playground: a live JS Composer against the real undertone
  API, with every preset/pattern/track example one click away in the side
  panel — ported from the old standalone demo/ Vite app so it shares the
  docs site's nav and chrome.

  (c) Copyright 2026 Liminal HQ, Scott Morris
  SPDX-License-Identifier: MIT
-->
<script setup lang="ts">
import { onMounted } from 'vue';
import { initComposer } from '../playground/composer';

onMounted(() => {
  initComposer();
});
</script>

<template>
  <div class="playground-console">
    <div class="playground-main">
      <p>
        Write any JS expression using <code>note</code>, <code>sound</code>, <code>stack</code>,
        <code>seq</code>, <code>cat</code>, euclidean rhythms, chained voice controls, even plain JS
        loops and helper functions — return a <code>Pattern</code> and the buttons below play it.
        Your code re-runs as you type, so a running loop picks up your edits live — and it executes
        directly in this page, same as pasting into devtools: write an infinite loop and you'll hang
        the tab. Not sure where to start? Pick an example.
      </p>
      <div id="composer-editor"></div>
      <div class="playground-top-row">
        <button id="composer-play">▶ Once</button>
        <button id="composer-loop">⟳ Loop</button>
        <button id="composer-share">⧉ Copy link</button>
      </div>
      <div id="composer-controls"></div>
      <div class="lab-error" id="composer-error" hidden></div>
      <canvas id="composer-viz"></canvas>
    </div>
    <aside class="playground-examples" id="composer-examples">
      <h2>Examples</h2>
    </aside>
  </div>
</template>

<style scoped>
.playground-console {
  color-scheme: dark;
  background: #0a0f1c;
  color: #e2e8f0;
  font-family: ui-monospace, 'Fira Code', 'JetBrains Mono', Menlo, monospace;
  display: grid;
  grid-template-columns: 1fr 260px;
  align-items: start;
  gap: 32px;
  padding: 32px;
  border-radius: 12px;
  border: 1px solid #2e3540;
}

.playground-main {
  min-width: 0;
}

.playground-console :deep(p) {
  color: #94a3b8;
  margin-top: 0;
  line-height: 1.5;
}

.playground-console :deep(code) {
  background: none;
  padding: 0;
  color: inherit;
}

.playground-console :deep(button) {
  background: #132644;
  border: 2px solid #2e3540;
  color: #e2e8f0;
  padding: 12px 20px;
  border-radius: 8px;
  font-family: inherit;
  font-size: 14px;
  cursor: pointer;
}

.playground-console :deep(button:hover) {
  border-color: #5aa2ff;
}

.playground-console :deep(button:active) {
  transform: translateY(1px);
}

.playground-console .playground-top-row {
  display: flex;
  gap: 16px;
  align-items: center;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.playground-console :deep(.playground-row) {
  display: grid;
  grid-template-columns: 180px 1fr 70px;
  align-items: center;
  gap: 10px;
  padding: 4px 0;
}

.playground-console :deep(.playground-label) {
  color: #9aa4b2;
  font-size: 13px;
}

.playground-console :deep(.playground-value) {
  color: #7bffb7;
  font-size: 13px;
  text-align: right;
}

.playground-console :deep(input[type='range']) {
  accent-color: #5aa2ff;
}

.playground-console .lab-error {
  color: #ff8097;
  background: #2a0f16;
  border: 1px solid #7f1d2e;
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 13px;
  margin: 10px 0;
}

.playground-console #composer-viz {
  width: 100%;
  height: 140px;
  display: block;
  background: #050507;
  border: 1px solid #2e3540;
  border-radius: 8px;
  margin: 12px 0;
}

.playground-console #composer-editor :deep(.cm-editor) {
  border: 1px solid #2e3540;
  border-radius: 8px;
  font-size: 13px;
  min-height: 320px;
  max-height: 520px;
  margin: 12px 0;
}

.playground-console #composer-editor :deep(.cm-editor.cm-focused) {
  outline: none;
  border-color: #5aa2ff;
}

.playground-console #composer-editor :deep(.cm-scroller) {
  font-family: inherit;
  line-height: 1.5;
}

/* The examples panel: a sticky, scrollable list grouped by category —
   dynamically populated by composer.ts, so these rules target the
   plain HTML it builds, not anything Vue-rendered. */
.playground-examples {
  position: sticky;
  top: 24px;
  max-height: calc(100vh - 48px);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-right: 4px;
}

.playground-examples h2 {
  font-size: 16px;
  color: #5aa2ff;
  margin: 0 0 4px;
  border: none;
  padding: 0;
}

.playground-examples :deep(h3) {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #64748b;
  margin: 12px 0 2px;
}

.playground-examples :deep(.example-group) {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.playground-examples :deep(.example-group button) {
  text-align: left;
  background: transparent;
  border: 1px solid transparent;
  padding: 6px 8px;
  border-radius: 6px;
  color: #cbd5e1;
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
}

.playground-examples :deep(.example-group button:hover) {
  background: #101c34;
  border-color: #2e3540;
}

.playground-examples :deep(.example-group button.is-active) {
  background: #132644;
  border-color: #5aa2ff;
  color: #e2e8f0;
}

/* Below ~900px there's no room for a 260px side rail next to a usable
   editor — stack the examples panel under the main column instead. */
@media (max-width: 900px) {
  .playground-console {
    grid-template-columns: 1fr;
  }

  .playground-examples {
    position: static;
    max-height: none;
    overflow-y: visible;
  }
}

/* The fixed 180px/70px side columns don't fit a phone-width viewport —
   restack each row's label/value onto their own line above the slider. */
@media (max-width: 640px) {
  .playground-console {
    padding: 16px;
    gap: 24px;
  }

  .playground-console :deep(.playground-row) {
    grid-template-columns: 1fr auto;
    grid-template-areas: 'label value' 'range range';
    row-gap: 4px;
  }

  .playground-console :deep(.playground-row) > input[type='range'] {
    grid-area: range;
    width: 100%;
  }

  .playground-console :deep(.playground-label) {
    grid-area: label;
  }

  .playground-console :deep(.playground-value) {
    grid-area: value;
  }
}
</style>

<!--
  Unscoped: CodeMirror's hover tooltip mounts to document.body, outside this
  component's own DOM tree, so Vue's scoped-style attribute never reaches it.
-->
<style>
.cm-api-hover {
  max-width: 360px;
  padding: 8px 10px;
  font-family: ui-monospace, 'Fira Code', 'JetBrains Mono', Menlo, monospace;
  font-size: 13px;
}

.cm-api-hover-signature {
  color: #7bffb7;
  font-weight: 600;
  margin-bottom: 4px;
  white-space: pre-wrap;
}

.cm-api-hover-doc {
  color: #cbd5e1;
  line-height: 1.4;
}
</style>
