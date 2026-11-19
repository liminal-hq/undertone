// Seeds conformance/test-classes.json: classifies every test of the suite by the rules below (spike R5)
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT

// Run with `bun spikes/r5-suite/classify.mjs` from the repository root. It reads each test's source (the
// call that `vitest list --includeTaskLocation` points at, plus the file-level helpers it uses) and sorts
// it by the rules in RULES. The output is a seed: the person reviewing it overrides single tests in
// OVERRIDES, with a reason, and the committed file (not this script) is the source of truth afterwards.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { format } from '../../conformance/recorder/test-classes.ts';

const root = new URL('../../', import.meta.url).pathname.replace(/\/$/, '');
const require = createRequire(root + '/package.json');
const ts = require('typescript');

const RULES = {
  F1: 'The file tests the documentation playground script loader (docs/.vitepress/theme), which is not part of the library and stays TypeScript: internal, kept as it is.',
  F2: 'The file is the fast-check properties over the reference pattern core, run through conformance/recorder (interpret, loadReference): public API (patterns and haps); RF-27 points loadReference at the package.',
  F3: 'The file runs every documentation snippet against `import * as lib from "./index"`: public API (the fake timers only keep a snippet\'s loop idle); alias.',
  T1: "The test drives the scheduler's timer (a FakeTimer or TimerLike, .loop(), loopPattern, fake timers): Web Audio, to run against the Web Audio backend.",
  Q1: 'The test is about what a context lacks or does at its edge (a missing createX, no OfflineAudioContext, a negative start time, params that cannot cancel automation): Web Audio.',
  I1: 'The test imports and uses a symbol that src/index.ts does not export (a private function or structure): internal, to be replaced by a Rust unit test.',
  P1: 'Every runtime import the test uses is in src/index.ts (or a test utility): public API (patterns, haps, controls, recorded graphs, rendering); alias.',
  P2: 'Public API, but the test also uses playVoice/playVoices (not exported by index; playParams(ctx, [patch], { when }) is the exported way), or a test hook the bridge must offer (resetWarnings, seedContext): translate.',
  P3: 'Reviewed by hand: the subject is public API and the private function only computes an expected value, so the test is public API and RF-27 inlines the expected value (translate).'
};
const SUPPORT = new Set(['resetWarnings', 'seedContext']);
const SHIM = new Set(['playVoice', 'playVoices']);
const TIMER_IDS = [
  'FakeTimer',
  'TimerLike',
  'loopPattern',
  'useFakeTimers',
  'advanceTimersByTime',
  '.loop'
];
const QUIRK =
  /without create\w+|on a context without|cannot cancel|no OfflineAudioContext|negative start times/;

const AREA = {
  'src/fraction.test.ts': 'exact time',
  'src/pattern.test.ts': 'pattern algebra',
  'src/signal.test.ts': 'signals and seeded random',
  'src/mini.test.ts': 'mini-notation',
  'src/pitch.test.ts': 'pitch parsing',
  'src/scale.test.ts': 'scales',
  'src/chord.test.ts': 'chords and voicing',
  'src/random.test.ts': 'random sources',
  'src/control.test.ts': 'note/sound/n/s/chord constructors',
  'src/controlSignals.test.ts': 'patternable controls',
  'src/engine.test.ts': 'voice graph (engine)',
  'src/fm.test.ts': 'voice graph: FM',
  'src/gate.test.ts': 'voice graph: gate, legato, cut',
  'src/autopan.test.ts': 'voice graph: autopan and the pan slide',
  'src/panPath.test.ts': 'voice graph: pan path',
  'src/panLaw.test.ts': 'voice graph: pan law',
  'src/pitchCurve.test.ts': 'voice graph: pitch curve',
  'src/waves.test.ts': 'voice graph: shaped waves',
  'src/noise.test.ts': 'voice graph: noise',
  'src/effects.test.ts': 'effects buses',
  'src/masterBus.test.ts': 'master bus',
  'src/surround.test.ts': 'multichannel placement',
  'src/samples.test.ts': 'sample registry',
  'src/render.test.ts': 'offline rendering',
  'src/wav.test.ts': 'WAV encoding',
  'src/scheduler.test.ts': 'scheduler and tempo',
  'src/handles.test.ts': 'playback handles',
  'src/tools.test.ts': 'tools: drift, layer, score, fmVoice, monoFold',
  'src/docSnippets.test.ts': 'documentation snippets',
  'conformance/recorder/properties.test.ts': 'pattern properties',
  'docs/.vitepress/theme/playground/importScript.test.ts': 'playground script loader'
};

// Single-test overrides decided by hand after reading the test: [file, title substring, class, rule, rf27, note]
const P3 = (file, sub, note) => [file, sub, 'public', 'P3', 'translate', note];
const OVERRIDES = [
  P3(
    'src/panLaw.test.ts',
    'places a panned voice with one gain per side',
    'expected gains come from panLawGains; inline the -4.5 dB law values; also uses playVoice'
  ),
  P3(
    'src/panLaw.test.ts',
    'holds both side gains where the path had got to',
    'expected gains come from panLawGains; inline the -6 dB values; also uses playVoice'
  ),
  P3(
    'src/panLaw.test.ts',
    'is set by panlaw() on a pattern',
    'expected gain comes from panLawGains(1, -6); inline it; the subject is the .panlaw() control'
  ),
  P3(
    'src/control.test.ts',
    'expands one chord event into simultaneous notes',
    'expected pitches come from voicingPitches("Dm9"); inline the MIDI list'
  ),
  P3(
    'src/control.test.ts',
    'shares the same onset/whole span across the expanded notes',
    'only the count comes from voicingPitches("Dm9"); inline 5 (or whatever the voicing gives)'
  ),
  P3(
    'src/signal.test.ts',
    'passes through its own random value at every whole cycle',
    'the expected value comes from timeRandom; the subject is perlin (exported)'
  ),
  P3(
    'src/signal.test.ts',
    'freeze the scheme',
    'the subject is rand (exported); timeRandom only computes the expected value, which seededRandom of the same key also gives'
  )
];

const list = JSON.parse(
  execSync('npx vitest list --json --includeTaskLocation', {
    cwd: root,
    maxBuffer: 1 << 28,
    stdio: ['ignore', 'pipe', 'ignore']
  }).toString()
);
const idx = readFileSync(root + '/src/index.ts', 'utf8');
const pub = new Set();
for (const m of idx.matchAll(/^export \{([^}]*)\} from/gms))
  for (const n of m[1].split(',')) if (n.trim()) pub.add(n.trim());

const files = {};
for (const e of list) (files[e.file] ??= []).push(e);
const entries = [];
for (const [file, tests] of Object.entries(files)) {
  const rel = file.replace(root + '/', '');
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const imp = new Map();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    const mod = st.moduleSpecifier.text;
    const ic = st.importClause;
    if (ic.name) imp.set(ic.name.text, { mod, type: ic.isTypeOnly });
    const nb = ic.namedBindings;
    if (nb && ts.isNamedImports(nb))
      for (const el of nb.elements)
        imp.set(el.name.text, {
          mod,
          type: ic.isTypeOnly || el.isTypeOnly,
          orig: (el.propertyName ?? el.name).text
        });
    if (nb && ts.isNamespaceImport(nb)) imp.set(nb.name.text, { mod, type: false, ns: true });
  }
  const helpers = new Map();
  for (const st of sf.statements) {
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name)
      helpers.set(st.name.text, st);
    else if (ts.isVariableStatement(st))
      for (const d of st.declarationList.declarations)
        if (ts.isIdentifier(d.name)) helpers.set(d.name.text, d);
  }
  const idsOf = (node) => {
    const acc = new Set();
    const seen = new Set();
    const visit = (n) => {
      if (ts.isIdentifier(n)) {
        acc.add(n.text);
        const h = helpers.get(n.text);
        if (h && !seen.has(n.text)) {
          seen.add(n.text);
          visit(h);
        }
      } else if (ts.isPropertyAccessExpression(n)) acc.add('.' + n.name.text);
      ts.forEachChild(n, visit);
    };
    visit(node);
    return acc;
  };
  const find = (line, col) => {
    const pos = sf.getPositionOfLineAndCharacter(line - 1, col - 1);
    let best;
    const v = (n) => {
      if (
        !best &&
        ts.isCallExpression(n) &&
        (n.getStart() === pos || n.expression.getEnd() === pos)
      )
        best = n;
      ts.forEachChild(n, v);
    };
    v(sf);
    return best;
  };
  // A hook (beforeEach, afterEach, beforeAll) that calls a test-support symbol applies to the tests of its file
  const hookIds = new Set();
  const hooks = (n) => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      /^(before|after)(Each|All)$/.test(n.expression.text)
    )
      idsOf(n).forEach((x) => hookIds.add(x));
    ts.forEachChild(n, hooks);
  };
  hooks(sf);
  const seen = new Map();
  for (const t of tests) {
    const node = find(t.location.line, t.location.column);
    if (!node) throw new Error(`no call at ${rel}:${t.location.line}`);
    const ids = idsOf(node);
    const hookSupport = [...hookIds].filter(
      (id) => imp.get(id) && !imp.get(id).type && SUPPORT.has(imp.get(id).orig ?? id)
    );
    const priv = [];
    const shims = [];
    const support = [];
    for (const id of ids) {
      const i = imp.get(id);
      if (!i || i.type || i.ns) continue;
      const name = i.orig ?? id;
      if (SUPPORT.has(name)) support.push(name);
      else if (SHIM.has(name)) shims.push(name);
      else if (
        /test-utils|vitest|^node:|typescript|fast-check|conformance|\.\.\/\.\.\/src\/index|\/importScript$/.test(
          i.mod
        ) ||
        i.mod.includes('/recorder/') ||
        ['./interpret', './reference'].includes(i.mod)
      )
        continue;
      else if (!pub.has(name)) priv.push(name);
    }
    for (const h of hookSupport)
      if (!support.includes(imp.get(h).orig ?? h)) support.push(imp.get(h).orig ?? h);
    const timer = TIMER_IDS.filter((x) => ids.has(x));
    const key = rel + '\u0000' + t.name;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    const title = n === 1 ? t.name : `${t.name} #${n}`;
    let cls, rule, rf27, note;
    if (rel.startsWith('docs/')) {
      cls = 'internal';
      rule = 'F1';
      rf27 = 'keep';
      note = 'playground tooling; no Rust counterpart, unchanged';
    } else if (rel.endsWith('properties.test.ts')) {
      cls = 'public';
      rule = 'F2';
      rf27 = 'translate';
      note = 'point loadReference/interpret at the package entry; the same programs run on both';
    } else if (rel.endsWith('docSnippets.test.ts')) {
      cls = 'public';
      rule = 'F3';
      rf27 = support.length ? 'translate' : 'alias';
      note = 'namespace import of ./index; fake timers keep loops idle';
    } else if (timer.length) {
      cls = 'web-audio';
      rule = 'T1';
      rf27 = 'run-on-backend';
      note =
        `uses ${timer.join(', ')}` +
        (priv.length
          ? `; also imports ${priv.join(', ')} (not in index: loopPattern becomes .loop())`
          : '') +
        (shims.length ? `; uses ${shims.join(', ')}` : '');
    } else if (priv.length) {
      cls = 'internal';
      rule = 'I1';
      rf27 = 'replace';
      note = `uses ${[...new Set(priv)].join(', ')}, not exported by index`;
    } else if (QUIRK.test(t.name)) {
      cls = 'web-audio';
      rule = 'Q1';
      rf27 = 'run-on-backend';
      note =
        'context capability or edge behaviour' + (shims.length ? `; uses ${shims.join(', ')}` : '');
    } else if (shims.length || support.length) {
      cls = 'public';
      rule = 'P2';
      rf27 = 'translate';
      note =
        `uses ${[...shims, ...support].join(', ')}` +
        (shims.length
          ? ' (translate to playParams(ctx, [patch], { when }))'
          : ' (bridge needs a warning reset hook)');
    } else {
      cls = 'public';
      rule = 'P1';
      rf27 = 'alias';
      note = 'only index exports and test utilities';
    }
    for (const [f, sub, c, r, a, nt] of OVERRIDES)
      if (rel === f && title.includes(sub)) {
        cls = c;
        rule = r;
        rf27 = a;
        note = nt;
      }
    // a resetWarnings user stays flagged even when another rule decided the class
    if (support.length && !note.includes('resetWarnings'))
      note += '; also uses resetWarnings (bridge needs a warning reset hook)';
    entries.push({
      file: rel,
      test: title,
      class: cls,
      covers: `${AREA[rel] ?? rel}: ${t.name.split(' > ')[0]}`,
      rule,
      rf27,
      note
    });
  }
}
entries.sort((a, b) =>
  a.file < b.file ? -1 : a.file > b.file ? 1 : a.test < b.test ? -1 : a.test > b.test ? 1 : 0
);
const data = {
  corpus: 1,
  description:
    'Classification of every test in the TypeScript suite for the Rust migration (RF-12). public: patterns, haps, controls, recorded fake-context graphs, rendering results, which the bridge must keep (RF-27 runs them against the package). internal: private functions and structures, replaced by Rust unit tests. web-audio: the scheduler timer and context quirks, run against the Web Audio backend. `rf27` is the action: alias (change only the import path), translate (a named change), replace (a Rust unit test), run-on-backend, keep. Regenerate the structure with `bun run test-classes:update`; `bun run test-classes:check` fails when a test has no class.',
  reference: 'v0.4.0, 5ac4e69',
  counts: {},
  rules: RULES,
  tests: entries
};
writeFileSync(root + '/conformance/test-classes.json', format(data));
const by = {};
for (const e of entries) by[e.class] = (by[e.class] ?? 0) + 1;
console.log(entries.length, by);
