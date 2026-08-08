<!--
  The interactive playground: presets, a mini-notation pattern lab, a live
  Composer code editor, and a single-voice tweaker — ported from the old
  standalone demo/ Vite app so it shares the docs site's nav and chrome.

  (c) Copyright 2026 Liminal HQ, Scott Morris
  SPDX-License-Identifier: MIT
-->
<script setup lang="ts">
import { onMounted } from 'vue';
import type { ControlPatch, Pattern } from '../../../../src/index';
import {
  bulldoze,
  cashIn,
  error,
  milestone,
  notification,
  placeBuilding,
  powerOn,
  uiBlip,
  undo
} from '../playground/presets';
import { initPatternLab } from '../playground/patternLab';
import { initComposer } from '../playground/composer';
import { initVoiceTweaker } from '../playground/voiceTweaker';

const PRESETS: { selector: string; pattern: Pattern<ControlPatch> }[] = [
  { selector: '#play-place-building', pattern: placeBuilding },
  { selector: '#play-ui-blip', pattern: uiBlip },
  { selector: '#play-error', pattern: error },
  { selector: '#play-bulldoze', pattern: bulldoze },
  { selector: '#play-cash-in', pattern: cashIn },
  { selector: '#play-power-on', pattern: powerOn },
  { selector: '#play-milestone', pattern: milestone },
  { selector: '#play-notification', pattern: notification },
  { selector: '#play-undo', pattern: undo }
];

onMounted(() => {
  for (const { selector, pattern } of PRESETS) {
    document.querySelector<HTMLButtonElement>(selector)?.addEventListener('click', () => {
      pattern.play();
    });
  }
  initPatternLab();
  initComposer();
  initVoiceTweaker();
});
</script>

<template>
  <div class="playground-console">
    <section>
      <h2>Presets</h2>
      <div class="buttons">
        <button id="play-place-building">▶ Place Building</button>
        <button id="play-bulldoze">▶ Bulldoze</button>
        <button id="play-cash-in">▶ Cash In</button>
        <button id="play-power-on">▶ Power On</button>
        <button id="play-milestone">▶ Milestone</button>
        <button id="play-notification">▶ Notification</button>
        <button id="play-undo">▶ Undo</button>
        <button id="play-ui-blip">▶ UI Blip</button>
        <button id="play-error">▶ Error</button>
      </div>
    </section>

    <section>
      <h2>Pattern lab</h2>
      <p>
        Polyphonic cycles from mini-notation: <code>[a b]</code> subdivides,
        <code>&lt;a b&gt;</code> alternates per cycle, <code>,</code> stacks chords and layers,
        <code>(3,8)</code> is a euclidean rhythm, <code>*2</code> doubles up, <code>~</code> rests.
        Pick an example (it starts looping), then edit everything live — including 7.1 surround
        placement if your hardware has it.
      </p>
      <div class="buttons" id="lab-examples"></div>
      <input id="lab-notation" type="text" spellcheck="false" value="c3 e3 g3 <b3 c4>" />
      <div class="playground-top-row">
        <label
          >Sound
          <select id="lab-sound">
            <option value="sine">sine</option>
            <option value="triangle" selected>triangle</option>
            <option value="square">square</option>
            <option value="sawtooth">sawtooth</option>
            <option value="white">white noise</option>
            <option value="pink">pink noise</option>
            <option value="brown">brown noise</option>
          </select>
        </label>
        <button id="lab-play">▶ Once</button>
        <button id="lab-loop">⟳ Loop</button>
      </div>
      <div class="lab-toggles" id="lab-toggles"></div>
      <div id="lab-controls"></div>
      <div class="lab-error" id="lab-error" hidden></div>
      <canvas id="lab-viz"></canvas>
      <pre id="lab-code"></pre>
    </section>

    <section>
      <h2>Composer</h2>
      <p>
        The full API, live: write any JS expression using <code>note</code>, <code>sound</code>,
        <code>stack</code>, <code>seq</code>, <code>cat</code>, euclidean rhythms, chained voice
        controls, even plain JS loops and helper functions — return a <code>Pattern</code> and it
        plays. Runs as you type. Code executes directly in this page, same as pasting into devtools
        — an infinite loop will hang the tab.
      </p>
      <div class="buttons" id="composer-examples"></div>
      <div id="composer-editor"></div>
      <div class="playground-top-row">
        <button id="composer-play">▶ Once</button>
        <button id="composer-loop">⟳ Loop</button>
        <button id="composer-share">⧉ Copy link</button>
      </div>
      <div id="composer-controls"></div>
      <div class="lab-error" id="composer-error" hidden></div>
      <canvas id="composer-viz"></canvas>
    </section>

    <section>
      <h2>Voice tweaker</h2>
      <p>Tweak a voice, hear it instantly, copy the code.</p>
      <div class="playground-top-row">
        <label
          >Sound
          <select id="playground-sound-type">
            <option value="sine">sine</option>
            <option value="triangle">triangle</option>
            <option value="square">square</option>
            <option value="sawtooth">sawtooth</option>
            <option value="white">white noise</option>
            <option value="pink">pink noise</option>
            <option value="brown">brown noise</option>
          </select>
        </label>
        <label>
          Note
          <input type="text" id="playground-pitch" value="c3" size="4" />
        </label>
        <button id="playground-play">▶ Play</button>
      </div>
      <div id="playground-controls"></div>
      <pre id="playground-code"></pre>
    </section>
  </div>
</template>

<style scoped>
.playground-console {
  color-scheme: dark;
  background: #0a0f1c;
  color: #e2e8f0;
  font-family: ui-monospace, 'Fira Code', 'JetBrains Mono', Menlo, monospace;
  display: flex;
  flex-direction: column;
  gap: 32px;
  padding: 32px;
  border-radius: 12px;
  border: 1px solid #2e3540;
}

.playground-console :deep(h2) {
  color: #5aa2ff;
  font-size: 16px;
  margin: 0 0 4px;
  border: none;
  padding: 0;
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

.playground-console section {
  width: 100%;
}

.playground-console .buttons {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
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
}

.playground-console :deep(select),
.playground-console :deep(input[type='text']) {
  background: #101c34;
  border: 1px solid #2e3540;
  color: #e2e8f0;
  padding: 8px 10px;
  border-radius: 6px;
  font-family: inherit;
  font-size: 13px;
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

.playground-console #playground-code,
.playground-console #lab-code {
  background: #050507;
  border: 1px solid #2e3540;
  border-radius: 8px;
  padding: 16px;
  color: #7bffb7;
  font-size: 13px;
  white-space: pre-wrap;
  overflow-x: auto;
}

.playground-console #lab-notation {
  width: 100%;
  box-sizing: border-box;
  background: #050507;
  border: 1px solid #2e3540;
  border-radius: 8px;
  color: #ffd479;
  font-family: inherit;
  font-size: 16px;
  padding: 12px 14px;
  margin: 12px 0;
}

.playground-console #lab-notation:focus {
  outline: none;
  border-color: #5aa2ff;
}

.playground-console .lab-toggles {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin: 10px 0;
}

.playground-console :deep(.lab-toggle) {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: #101c34;
  border: 1px solid #2e3540;
  border-radius: 999px;
  padding: 6px 12px;
  font-size: 13px;
  color: #9aa4b2;
  cursor: pointer;
  user-select: none;
}

.playground-console :deep(.lab-toggle:has(input:checked)) {
  border-color: #a78bfa;
  color: #e2e8f0;
}

.playground-console :deep(.lab-toggle input) {
  accent-color: #a78bfa;
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

.playground-console #lab-viz,
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
  min-height: 220px;
  max-height: 420px;
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
