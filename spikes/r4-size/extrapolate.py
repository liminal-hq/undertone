# Throwaway spike R4: extrapolate the measured modules to the whole API from TypeScript minified sizes.
# Inputs are measured: the pattern-core module (control-min, 201,300 B raw, 76,287 B Brotli), the worklet
# (195,268 B raw, 75,767 B Brotli), the fixed overhead (function bytes of core::fmt, core, std, alloc, and
# compiler_builtins in the worklet: about 41 KB), the per-module minified TypeScript sizes (bun build
# --minify --no-bundle), and the Brotli-to-raw factor of the modules (0.38).
TS_PORTED = 16953 + 1528 + 3899 + 1580 + 886 + 1274 + 549 + 1057  # pattern fraction mini signal random control pitch scale
FIXED = 41_000
CORE_RAW = 201_300
CENTRAL = (CORE_RAW - FIXED) / TS_PORTED  # raw wasm bytes per minified TypeScript byte
BROTLI = 0.38
# Not yet in Rust, by what the module has to hold (minified TypeScript bytes).
voice = 7960 + 2385 + 1267 + 2234 + 577 + 1098 + 1081 + 2738 + 2300  # engine, instruments, effects, masterBus, noise, waves, pitchCurve, score, half of panPath/autopan/surround
harmony = 1027 + 1022 + 500  # drift, chord, the unported half of scale
render = 4012 + 1867 + 1929  # render, wav, scheduler
controls_raw = 10_000  # the real validation and sanitising of ~50 controls, beyond the 3.4 KB the stubs cost
serde = 90_873 - 83_695  # measured: serde-wasm-bindgen with a VoiceParams-sized struct
dsp = {"low": 25_000, "central": 45_000, "high": 70_000}  # raw bytes of software DSP (judgement; no TypeScript equivalent)
print(f"ported TypeScript {TS_PORTED} B, central ratio {CENTRAL:.2f} raw wasm bytes per TS byte")
for name, ratio in (("low", 3.5), ("central", CENTRAL), ("high", 8.0)):
    ctl_raw = ratio * (voice + harmony) + controls_raw
    ctl = 83_695 + ctl_raw * BROTLI + serde
    wk_raw = ratio * (voice + harmony) + dsp[name] - 3_300
    wk = 75_767 + wk_raw * BROTLI
    # A worklet with no pattern core (RF-29 may leave booking to a worker): measured base 10,432 B (the renderer
    # stand-in and the engine's maths, `--no-default-features`), plus the voice graph and the DSP.
    wk_bare = 10_432 + (ratio * voice + dsp[name] - 3_300) * BROTLI
    ctl_render = ctl + (ratio * render + dsp[name]) * BROTLI
    print(f"{name:8s} ratio {ratio:4.2f}: control {ctl/1000:6.1f} KB, worklet {wk/1000:6.1f} KB, together {(ctl+wk)/1000:6.1f} KB; control if it also holds render and the DSP {ctl_render/1000:6.1f} KB; worklet with no pattern core {wk_bare/1000:6.1f} KB, together {(ctl+wk_bare)/1000:6.1f} KB")
