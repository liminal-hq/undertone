// Scratch VitePress config. R3_VP_TARGET=esnext adds the one documented line; unset leaves the build options empty.
import { defineConfig } from 'vitepress';
const esnext = process.env.R3_VP_TARGET === 'esnext';
export default defineConfig({
  base: process.env.R3_VP_BASE ?? '/',
  ...(esnext ? { vite: { build: { target: 'esnext' } } } : {})
});
