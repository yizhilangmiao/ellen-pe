import zipfile, os, re, sys
sys.stdout.reconfigure(encoding='utf-8')

BASE = r'E:\ailian\艾莲手机端\艾莲-0.1.8-免激活-关更新.apk'
OUT = r'E:\ailian\_临时\legacy\web'

EXT = ('.js', '.mjs', '.html', '.css', '.json', '.ttf', '.woff', '.woff2')

z = zipfile.ZipFile(BASE)
names = [n for n in z.namelist() if n.startswith('assets/public/') and not n.endswith('/')]
sel = [n for n in names if n.lower().endswith(EXT)]
print('assets/public total entries:', len(names))
print('extracting:', len(sel))

for n in sel:
    rel = n[len('assets/public/'):]
    dst = os.path.join(OUT, rel.replace('/', os.sep))
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(dst, 'wb') as f:
        f.write(z.read(n))

print('---- js files ----')
js_files = sorted([n for n in sel if n.lower().endswith(('.js', '.mjs'))], key=lambda s: -z.getinfo(s).file_size)
FEAT = {
    'dynamic_import': re.compile(rb'\bimport\s*\('),
    'static_import': re.compile(rb'^\s*import[\s{*]', re.M),
    'export': re.compile(rb'^\s*export[\s{*]', re.M),
    'import_meta': re.compile(rb'\bimport\.meta\b'),
    'top_level_await': re.compile(rb'^\s*await\b', re.M),
}
for n in js_files:
    data = z.read(n)
    info = z.getinfo(n)
    flags = []
    for k, rx in FEAT.items():
        c = len(rx.findall(data))
        if c:
            flags.append('%s=%d' % (k, c))
    print('%-56s %9d  %s' % (n[len('assets/public/'):], info.file_size, ' '.join(flags) or '-'))
z.close()
