<!--
  An editable, playable code example for the guide, made from a ```ts live fence
  (see ../live/liveFence.ts). Until it mounts in a browser it shows the fence's
  ordinary highlighted block (the default slot), so the page reads the same with
  scripts off and builds without an AudioContext or a window.

  (c) Copyright 2026 Liminal HQ, Scott Morris
  SPDX-License-Identifier: MIT
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue';
import { runSnippet } from '../live/runSnippet';
import { wrapFragment } from '../live/fragment';
import type { ExampleKind } from '../live/fragment';
import type { SnippetRun } from '../live/runSnippet';
import { claimActive, releaseActive } from '../live/activeRun';
import type { ActiveRun } from '../live/activeRun';

// `live` runs the code as written; `play` and `mini` wrap a fragment first (see ../live/fragment.ts).
const props = withDefaults(defineProps<{ code: string; kind?: ExampleKind }>(), { kind: 'live' });

const labels: Record<ExampleKind, string> = {
  live: 'Live example: edit the code, then press Play.',
  play: 'Live pattern: edit it, then press Play. It loops until you press Stop.',
  mini: 'Live mini-notation: edit the notes or sounds, then press Play. It loops until you press Stop.'
};

const hintId = `live-keys-${useId()}`;
const mounted = ref(false);
const source = ref(props.code);
const status = ref('Ready.');
const error = ref('');
const output = ref<string[]>([]);
const playing = ref(false);
// Escape leaves the editor's Tab handling, so a keyboard user is never trapped in the text area.
const tabMovesFocus = ref(false);
const area = ref<HTMLTextAreaElement | null>(null);

let run: SnippetRun | undefined;
const self: ActiveRun = { stop };

const rows = computed(() => Math.max(3, source.value.split('\n').length));
const edited = computed(() => source.value !== props.code);

onMounted(() => {
  mounted.value = true;
});

onBeforeUnmount(() => {
  stop();
});

function stop(): void {
  const current = run;
  run = undefined;
  current?.stop();
  releaseActive(self);
  if (playing.value) status.value = 'Stopped.';
  playing.value = false;
}

function play(): void {
  // Starts synchronously inside the click, which is the user gesture the browser needs to allow audio.
  stop();
  error.value = '';
  output.value = [];
  let prepared: string;
  try {
    prepared = wrapFragment(source.value, props.kind);
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
    status.value = 'There is nothing to play.';
    return;
  }
  claimActive(self);
  const current = runSnippet(prepared, {
    log: (line) => output.value.push(line)
  });
  run = current;
  playing.value = true;
  status.value = 'Playing. Press Stop to silence it.';
  current.done.catch((caught: unknown) => {
    if (run !== current) return;
    run = undefined;
    playing.value = false;
    releaseActive(self);
    error.value = caught instanceof Error ? caught.message : String(caught);
    status.value = 'The code threw an error.';
  });
}

function reset(): void {
  stop();
  source.value = props.code;
  error.value = '';
  output.value = [];
  status.value = 'Reset to the original code.';
}

function onKeydown(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    play();
    return;
  }
  if (event.key === 'Escape') {
    tabMovesFocus.value = true;
    return;
  }
  if (event.key === 'Tab' && !event.shiftKey && !tabMovesFocus.value) {
    event.preventDefault();
    const el = event.target as HTMLTextAreaElement;
    const start = el.selectionStart;
    source.value = source.value.slice(0, start) + '  ' + source.value.slice(el.selectionEnd);
    void nextTick(() => {
      area.value?.setSelectionRange(start + 2, start + 2);
    });
    return;
  }
  if (event.key !== 'Tab') tabMovesFocus.value = false;
}
</script>

<template>
  <div v-if="!mounted"><slot /></div>
  <div v-else class="live-example">
    <p class="live-label">{{ labels[kind] }}</p>
    <textarea
      ref="area"
      v-model="source"
      class="live-editor"
      :rows="rows"
      spellcheck="false"
      autocapitalize="off"
      autocomplete="off"
      aria-label="Editable example code"
      :aria-describedby="hintId"
      @keydown="onKeydown"
    ></textarea>
    <div class="live-bar">
      <button type="button" class="live-button live-play" @click="play">Play</button>
      <button type="button" class="live-button" :disabled="!playing" @click="stop">Stop</button>
      <button type="button" class="live-button" :disabled="!edited" @click="reset">Reset</button>
      <span class="live-status" role="status" aria-live="polite">{{ status }}</span>
    </div>
    <p :id="hintId" class="live-hint">
      Ctrl or Cmd with Enter plays. Tab indents; press Escape, then Tab, to move on.
    </p>
    <pre v-if="output.length > 0" class="live-output" aria-label="Output">{{
      output.join('\n')
    }}</pre>
    <p v-if="error" class="live-error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.live-example {
  margin: 16px 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-code-block-bg);
  overflow: hidden;
}

.live-label {
  margin: 0;
  padding: 6px 16px;
  font-size: 12px;
  color: var(--vp-c-text-2);
  border-bottom: 1px solid var(--vp-c-divider);
}

.live-editor {
  display: block;
  box-sizing: border-box;
  width: 100%;
  padding: 12px 16px;
  border: 0;
  resize: vertical;
  background: transparent;
  color: var(--vp-c-text-1);
  font-family: var(--vp-font-family-mono);
  font-size: var(--vp-code-font-size);
  line-height: var(--vp-code-line-height);
  tab-size: 2;
  white-space: pre;
  overflow-x: auto;
}

.live-editor:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: -2px;
}

.live-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-top: 1px solid var(--vp-c-divider);
}

.live-button {
  padding: 4px 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}

.live-button:hover:not(:disabled) {
  border-color: var(--vp-c-brand-1);
}

.live-button:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

.live-button:disabled {
  opacity: 0.5;
  cursor: default;
}

.live-play {
  background: var(--vp-c-brand-3);
  border-color: var(--vp-c-brand-3);
  color: var(--vp-button-brand-text);
}

.live-status {
  font-size: 12px;
  color: var(--vp-c-text-2);
}

.live-hint {
  margin: 0;
  padding: 0 16px 8px;
  font-size: 11px;
  color: var(--vp-c-text-3);
}

.live-output {
  margin: 0;
  padding: 8px 16px;
  border-top: 1px solid var(--vp-c-divider);
  font-family: var(--vp-font-family-mono);
  font-size: 12px;
  color: var(--vp-c-text-2);
  white-space: pre-wrap;
}

.live-error {
  margin: 0;
  padding: 8px 16px;
  border-top: 1px solid var(--vp-c-danger-1);
  background: var(--vp-c-danger-soft);
  color: var(--vp-c-danger-1);
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
}
</style>
