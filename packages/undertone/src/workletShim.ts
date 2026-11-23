// A small UTF-8 TextDecoder and TextEncoder for the AudioWorklet scope, which has neither
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

// The render module's glue (wasm-bindgen `--target web`) makes a `TextDecoder` and a `TextEncoder` when it is evaluated, and the
// worklet global scope has no such classes (D-47). The shim gives it just what the glue uses, for UTF-8: a decoder that reads a
// byte view (and, with `fatal`, throws a `TypeError` on a malformed sequence), and an encoder with `encode` and `encodeInto`. It
// touches nothing else, and never `fetch`, `URL`, or `import.meta.url`.
//
// The shim is plain JavaScript held as text, not a function turned into text with `toString()`, because the package puts it at
// the top of the module it hands `audioWorklet.addModule`, and a consumer's bundler or test tool may rewrite a function's body
// (esbuild's `keepNames` adds calls to a helper the worklet does not have). A string is left alone. The test suite runs it in a
// bare `vm` context, which has no `TextDecoder`, to prove it works there.

/** The statement that installs `TextDecoder` and `TextEncoder` on the global scope that runs it, unless it has them already. */
export const workletShimSource = `(function (scope) {
    const installed = [];

    if (typeof scope.TextDecoder === 'undefined') {
      class ShimTextDecoder {
        encoding = 'utf-8';
        fatal;
        ignoreBOM;
        constructor(label, options) {
          const name = String(label ?? 'utf-8')
            .trim()
            .toLowerCase();
          if (name !== 'utf-8' && name !== 'utf8' && name !== 'unicode-1-1-utf-8') {
            throw new RangeError('the worklet TextDecoder reads utf-8 only, not ' + name);
          }
          this.fatal = options?.fatal === true;
          this.ignoreBOM = options?.ignoreBOM === true;
        }
        decode(input) {
          if (input === undefined) return '';
          const bytes =
            input instanceof ArrayBuffer
              ? new Uint8Array(input)
              : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
          let out = '';
          let chunk = [];
          const flush = () => {
            out += String.fromCharCode(...chunk);
            chunk = [];
          };
          const push = (unit) => {
            chunk.push(unit);
            if (chunk.length >= 4096) flush();
          };
          const bad = () => {
            if (this.fatal) throw new TypeError('the bytes are not valid utf-8');
            push(0xfffd);
          };
          let at = 0;
          if (!this.ignoreBOM && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) at = 3;
          while (at < bytes.length) {
            const first = bytes[at];
            if (first < 0x80) {
              push(first);
              at += 1;
              continue;
            }
            let extra = 0;
            let code = 0;
            let least = 0;
            if (first >= 0xc2 && first <= 0xdf) {
              extra = 1;
              code = first & 0x1f;
              least = 0x80;
            } else if (first >= 0xe0 && first <= 0xef) {
              extra = 2;
              code = first & 0x0f;
              least = 0x800;
            } else if (first >= 0xf0 && first <= 0xf4) {
              extra = 3;
              code = first & 0x07;
              least = 0x10000;
            } else {
              bad();
              at += 1;
              continue;
            }
            let used = 1;
            let valid = true;
            while (used <= extra) {
              const next = bytes[at + used];
              if (next === undefined || (next & 0xc0) !== 0x80) {
                valid = false;
                break;
              }
              code = (code << 6) | (next & 0x3f);
              used += 1;
            }
            if (!valid || code < least || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
              bad();
              at += valid ? used : Math.max(1, used);
              continue;
            }
            at += used;
            if (code >= 0x10000) {
              const rest = code - 0x10000;
              push(0xd800 + (rest >> 10));
              push(0xdc00 + (rest & 0x3ff));
            } else {
              push(code);
            }
          }
          flush();
          return out;
        }
      }
      scope.TextDecoder = ShimTextDecoder;
      installed.push('TextDecoder');
    }

    if (typeof scope.TextEncoder === 'undefined') {
      class ShimTextEncoder {
        encoding = 'utf-8';
        encode(text = '') {
          const bytes = [];
          const source = String(text);
          for (let at = 0; at < source.length; at += 1) {
            let code = source.charCodeAt(at);
            if (code >= 0xd800 && code <= 0xdbff && at + 1 < source.length) {
              const low = source.charCodeAt(at + 1);
              if (low >= 0xdc00 && low <= 0xdfff) {
                code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
                at += 1;
              }
            }
            if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
            if (code < 0x80) {
              bytes.push(code);
            } else if (code < 0x800) {
              bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
            } else if (code < 0x10000) {
              bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
            } else {
              bytes.push(
                0xf0 | (code >> 18),
                0x80 | ((code >> 12) & 0x3f),
                0x80 | ((code >> 6) & 0x3f),
                0x80 | (code & 0x3f)
              );
            }
          }
          return Uint8Array.from(bytes);
        }
        encodeInto(text, view) {
          const bytes = this.encode(text);
          // Whole characters only, as the platform's: stop before one that does not fit.
          let written = 0;
          let read = 0;
          while (read < text.length) {
            const code = text.codePointAt(read);
            const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
            if (written + size > view.length) break;
            written += size;
            read += code >= 0x10000 ? 2 : 1;
          }
          view.set(bytes.subarray(0, written));
          return { read, written };
        }
      }
      scope.TextEncoder = ShimTextEncoder;
      installed.push('TextEncoder');
    }

    return installed;

})(globalThis);
`;
