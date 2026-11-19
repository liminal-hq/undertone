// Dev server in Vite 5: the dependency optimiser (esbuild, es2020) cannot take top-level await, so leave the bridge out of it
export default {
  build: { target: 'esnext' },
  optimizeDeps: { exclude: ['@liminal-hq/undertone'] }
};
