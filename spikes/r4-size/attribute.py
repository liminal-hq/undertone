# Throwaway spike R4: sum per-function bytes (wasm-opt --func-metrics, unstripped build) by crate and module.
import re, sys, collections
tot = collections.Counter(); name = None
for line in open(sys.argv[1]):
    if line.startswith('func:'):
        name = line.split(None, 1)[1].strip()
    elif 'binary-bytes' in line and name:
        n = int(line.split(':')[1]); name = name
        key = 'other'
        m = re.search(r'undertone_(pattern|engine)(\d+)([A-Za-z_]+)', name)
        if m:
            ln = int(m.group(2)); mod = m.group(3)[:ln] if len(m.group(3)) >= ln else m.group(3)
            key = f'undertone-{m.group(1)}::{mod}'
        elif 'undertone_pattern' in name: key = 'undertone-pattern::(generic/impl)'
        elif 'undertone_engine' in name: key = 'undertone-engine::(generic/impl)'
        elif '4core3fmt' in name or 'core3fmt' in name: key = 'core::fmt'
        elif 'compiler_builtins' in name: key = 'compiler_builtins (i128 maths etc.)'
        elif '5alloc' in name: key = 'alloc'
        elif '4core' in name: key = 'core (other)'
        elif '3std' in name: key = 'std'
        elif 'libm' in name: key = 'libm'
        elif 'wasm_bindgen' in name: key = 'wasm-bindgen runtime'
        elif 'r4_' in name: key = 'the spike crate itself'
        elif name.startswith(('build','book','render','alloc','dealloc')): key = 'the spike crate itself'
        elif name.startswith('_R'): key = 'other mangled'
        else: key = 'other (' + name[:20] + ')'
        tot[key] += n; name = None
s = sum(tot.values())
print(f'sum of function bytes: {s}')
for k, v in tot.most_common(25): print(f'{v:8d} {100*v/s:5.1f}%  {k}')
