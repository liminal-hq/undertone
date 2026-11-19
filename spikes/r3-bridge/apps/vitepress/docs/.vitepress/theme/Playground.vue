<script setup lang="ts">
// Scratch component: the playground's pattern, a static namespace import plus new Function over every export
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

import { onMounted } from 'vue';
import * as api from '@liminal-hq/undertone';
import { run, playgroundStyle } from '../../../../shared/run.js';

onMounted(() => {
  void run('vitepress playground', api, playgroundStyle, api.timing.start, api.timing.ready);
});
</script>

<template>
  <div>r3 playground</div>
</template>
