// Serves the package's directory for the worklet harness, optionally cross-origin isolated
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

// Usage: bun packages/undertone/harness/serve.ts [--port 8080] [--not-isolated] [--host 0.0.0.0]
// Serves `packages/undertone/` (so /harness/, /dist/ and /wasm/ are all there; build it first with `bun run package:build`), with
// `application/wasm` for the modules and no caching. The pages are cross-origin isolated by default (the two headers `Cross-Origin-
// Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`), which the harness needs: Chromium's worklet scope has
// no `performance.now()`, so `process` is timed with a counter a worker spins in a SharedArrayBuffer, and SharedArrayBuffer exists
// only on an isolated page. `--not-isolated` serves without the headers, to see the backend run without a clock. An AudioWorklet
// needs a secure context: localhost is one; for a phone use `adb reverse tcp:8080 tcp:8080` and open localhost on the phone, or
// put the page behind https.

import { existsSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

declare const Bun: {
  file(path: string): Blob;
  serve(options: {
    port: number;
    hostname: string;
    fetch(request: Request): Response | Promise<Response>;
  }): { port: number; hostname: string };
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.map': 'application/json'
};

export function serve(port = 8080, isolated = true, hostname = '127.0.0.1') {
  return Bun.serve({
    port,
    hostname,
    fetch(request) {
      const url = new URL(request.url);
      let path = normalize(decodeURIComponent(url.pathname));
      if (path.endsWith('/')) path += 'index.html';
      const file = join(root, path);
      if (!file.startsWith(root) || !existsSync(file))
        return new Response('not found', { status: 404 });
      const headers = new Headers({
        'Content-Type': types[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      if (isolated) {
        headers.set('Cross-Origin-Opener-Policy', 'same-origin');
        headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
      }
      return new Response(Bun.file(file), { headers });
    }
  });
}

if (import.meta.main) {
  if (
    !existsSync(join(root, 'dist', 'worklet.js')) ||
    !existsSync(join(root, 'wasm', 'render', 'undertone_wasm_render_bg.wasm'))
  ) {
    console.error('the package is not built: run `bun run package:build` first');
    process.exit(1);
  }
  const isolated = !args.includes('--not-isolated');
  const server = serve(Number(flag('--port') ?? 8080), isolated, flag('--host') ?? '127.0.0.1');
  console.log(
    `harness: http://${server.hostname}:${server.port}/harness/${isolated ? '  (cross-origin isolated)' : '  (not isolated: no clock)'}`
  );
}
