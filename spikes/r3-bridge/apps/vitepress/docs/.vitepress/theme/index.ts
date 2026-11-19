// Scratch VitePress theme: registers a component that statically imports the bridge, as the real playground does
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import DefaultTheme from 'vitepress/theme';
import Playground from './Playground.vue';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }: { app: { component(name: string, component: unknown): void } }) {
    app.component('Playground', Playground);
  }
};
