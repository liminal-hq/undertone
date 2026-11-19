<!--
  An audio player for a Rust guide page: the real WAV output of the example the page imports, rendered by the Rust crate in CI
  (scripts/render-rust-audio.sh) and served from /rust-audio/. An example writes several short files, so the player has a picker.
  When the audio was not built (a local checkout, or a pull request without the artifact) the component says so and shows how to make it.

  (c) Copyright 2026 Liminal HQ, Scott Morris
  SPDX-License-Identifier: MIT
-->
<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { withBase } from 'vitepress';

const props = defineProps<{ example: string }>();

interface AudioFile {
  file: string;
  sampleRate: number;
  channels: number;
}

const files = ref<AudioFile[]>([]);
const chosen = ref(0);
const state = ref<'loading' | 'ready' | 'missing'>('loading');

const current = computed(() => files.value[chosen.value]);
const src = computed(() =>
  current.value ? withBase(`/rust-audio/${props.example}/${current.value.file}`) : ''
);
const label = (file: string) => file.replace(/\.wav$/, '');
const kilohertz = (rate: number) => `${Number((rate / 1000).toFixed(3))} kHz`;
const layout = (channels: number) =>
  channels === 1 ? 'mono' : channels === 2 ? 'stereo' : `${channels} channels`;

// The manifest is read in the browser only, so the server-rendered page never depends on whether the audio was built.
onMounted(async () => {
  try {
    const response = await fetch(withBase('/rust-audio/manifest.json'));
    if (!response.ok) throw new Error(String(response.status));
    const manifest = (await response.json()) as Record<string, AudioFile[]>;
    const list = manifest[props.example];
    if (!Array.isArray(list) || list.length === 0) throw new Error('no files');
    files.value = list;
    state.value = 'ready';
  } catch {
    state.value = 'missing';
  }
});
</script>

<template>
  <figure class="rust-audio" :aria-label="`Audio rendered by the ${example} example`">
    <template v-if="state === 'ready' && current">
      <label v-if="files.length > 1" class="rust-audio-pick">
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
        Rendered by the Rust crate (the example above, {{ kilohertz(current.sampleRate) }},
        {{ layout(current.channels) }}).
        <template v-if="current.channels > 2">
          Your browser may fold this file down to stereo.
        </template>
      </figcaption>
    </template>
    <p v-else-if="state === 'missing'" class="rust-audio-missing" role="note">
      Audio is built by CI; run <code>cargo run --example {{ example }}</code> to make it locally.
    </p>
    <p v-else class="rust-audio-loading" aria-live="polite">Looking for the rendered audio.</p>
  </figure>
</template>

<style scoped>
.rust-audio {
  margin: 16px 0;
  padding: 12px 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
}

.rust-audio audio {
  display: block;
  width: 100%;
  max-width: 480px;
}

.rust-audio-pick {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 14px;
  color: var(--vp-c-text-2);
}

.rust-audio-pick select {
  max-width: 100%;
  padding: 2px 6px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 4px;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
}

.rust-audio-pick select:focus-visible,
.rust-audio audio:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

.rust-audio figcaption,
.rust-audio p {
  margin: 8px 0 0;
  font-size: 14px;
  line-height: 1.5;
  color: var(--vp-c-text-2);
}

.rust-audio p {
  margin: 0;
}
</style>
