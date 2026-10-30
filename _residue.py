import os, re, sys
sys.stdout.reconfigure(encoding='utf-8')

OUT = r'E:\ailian\_临时\legacy\web_out'
TARGETS = [
    ('assets/native-call-cache-CGcgcN6N.js', r'\?\.'),
    ('assets/storage-worker-CVMjPGme.js', r'\?\.'),
]

for rel, pat in TARGETS:
    p = os.path.join(OUT, rel.replace('/', os.sep))
    if not os.path.exists(p):
        print('missing', rel); continue
    txt = open(p, encoding='utf-8', errors='replace').read()
    print('=' * 70)
    print(rel, 'len', len(txt))
    for m in re.finditer(pat, txt):
        s = max(0, m.start() - 45)
        e = min(len(txt), m.end() + 45)
        frag = txt[s:e].replace('\n', '\\n')
        print('  @%d: ...%s...' % (m.start(), frag))
