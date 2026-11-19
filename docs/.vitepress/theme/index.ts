// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { defineAsyncComponent } from 'vue';
import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import Playground from './components/Playground.vue';
import RustAudio from './components/RustAudio.vue';
import TsAudio from './components/TsAudio.vue';
import './custom.css';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('Playground', Playground);
    app.component('TsAudio', TsAudio);
    // Loaded on the pages that use it: it carries the whole library source.
    app.component(
      'LiveExample',
      defineAsyncComponent(() => import('./components/LiveExample.vue'))
    );
    app.component('RustAudio', RustAudio);
  }
} satisfies Theme;
