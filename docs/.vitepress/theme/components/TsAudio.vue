<!--
  An audio player for a TypeScript guide example: the WAV the code above it makes, rendered in CI by the TypeScript library on
  node-web-audio-api (scripts/render-ts-audio.ts) and served from /ts-audio/. A block that makes several files (a limited and a safe
  render, a stereo and a 5.1 version) gets a picker. When the audio was not built (a local checkout, or a pull request without the
  artifact) the component says so and shows how to make it. The audio is illustrative; nobody has to hear it for the code to be right.

  (c) Copyright 2026 Liminal HQ, Scott Morris
  SPDX-License-Identifier: MIT
-->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { withBase } from 'vitepress';

const props = defineProps<{ name: string }>();

interface AudioFile {
  file: string;
  sampleRate: number;
  channels: number;
  seconds?: number;
  note?: string;
}

const files = ref<AudioFile[]>([]);
const chosen = ref(0);
const state = ref<'loading' | 'ready' | 'missing'>('loading');

const current = computed(() => files.value[chosen.value]);
const src = computed(() =>
  current.value ? withBase(`/ts-audio/${props.name}/${current.value.file}`) : ''
);
const label = (file: string) => file.replace(/\.wav$/, '');
const kilohertz = (rate: number) => `${Number((rate / 1000).toFixed(3))} kHz`;
const layout = (channels: number) =>
  channels === 1 ? 'mono' : channels === 2 ? 'stereo' : `${channels} channels`;

// The manifest is read in the browser only, so the server-rendered page never depends on whether the audio was built.
onMounted(async () => {
  try {
    const response = await fetch(withBase('/ts-audio/manifest.json'));
    if (!response.ok) throw new Error(String(response.status));
    const manifest = (await response.json()) as Record<string, AudioFile[]>;
    const list = manifest[props.name];
    if (!Array.isArray(list) || list.length === 0) throw new Error('no files');
    files.value = list;
    state.value = 'ready';
  } catch {
    state.value = 'missing';
  }
});
</script>

<template>
  <figure class="ts-audio" :aria-label="`Audio rendered from the ${name} example`">
    <template v-if="state === 'ready' && current">
      <label v-if="files.length > 1" class="ts-audio-pick">
        <span>File</span>
        <select v-model="chosen">
          <option v-for="(item, index) in files" :key="item.file" :value="index">
            {{ label(item.file) }}
          </option>
        </select>
      </label>
      <audio :key="src" controls preload="none" :src="src">
        Your browser does not support audio playback.
      </audio>
      <figcaption>
        Rendered by the TypeScript library (node-web-audio-api),
        {{ kilohertz(current.sampleRate) }}, {{ layout(current.channels) }}.
        <template v-if="current.note">{{ current.note }}</template>
        <template v-if="current.channels > 2">
          Your browser may fold this file down to stereo.</template
        >
      </figcaption>
    </template>
    <p v-else-if="state === 'missing'" class="ts-audio-missing" role="note">
      Audio is built by CI; run <code>bun run docs:audio</code> to make it locally.
    </p>
    <p v-else class="ts-audio-loading" aria-live="polite">Looking for the rendered audio.</p>
  </figure>
</template>

<style scoped>
.ts-audio {
  margin: 16px 0;
  padding: 12px 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
}

.ts-audio audio {
  display: block;
  width: 100%;
  max-width: 480px;
}

.ts-audio-pick {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 14px;
  color: var(--vp-c-text-2);
}

.ts-audio-pick select {
  max-width: 100%;
  padding: 2px 6px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 4px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
}

.ts-audio-pick select:focus-visible,
.ts-audio audio:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

.ts-audio figcaption,
.ts-audio p {
  margin: 8px 0 0;
  font-size: 14px;
  line-height: 1.5;
  color: var(--vp-c-text-2);
}

.ts-audio p {
  margin: 0;
}
</style>
