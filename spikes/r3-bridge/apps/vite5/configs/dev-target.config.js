// Dev server in Vite 5: give the dependency optimiser a target that has top-level await
export default {
  build: { target: 'esnext' },
  optimizeDeps: { esbuildOptions: { target: 'esnext' } }
};
