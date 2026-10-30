# -*- coding: utf-8 -*-
"""验证降级版 APK 的四件事：assets 已降级 / index.html 有 polyfill / required()=false / 更新地址已改。"""
import os, sys, zipfile, re

sys.stdout.reconfigure(encoding='utf-8')

APK = r'E:\ailian\_临时\legacy\艾莲-0.1.8-免激活-关更新-降级-aligned-debugSigned.apk'
z = zipfile.ZipFile(APK)
names = set(z.namelist())
print('apk:', os.path.basename(APK), os.path.getsize(APK), 'bytes')
print('entries:', len(names))
print()

# 1) assets 降级
checks = [
    ('assets/public/assets/main-C8dMeyqt.js', 1814121, True),
    ('assets/public/assets/native-call-cache-CGcgcN6N.js', 1464634, True),
    ('assets/public/assets/persona-7jr8wUts.js', 1710016, True),
    ('assets/public/ellen-startup-opening.js', 11099, True),
    ('assets/public/autonomy.html', None, True),
]
for arc, expect, _ in checks:
    if arc not in names:
        print('  MISSING:', arc); continue
    info = z.getinfo(arc)
    ok = (expect is None or info.file_size == expect)
    print('  %-58s %9d %s' % (arc.split('/')[-1], info.file_size, 'OK' if ok else 'UNEXPECTED(expect %s)' % expect))

print()
# 2) polyfill 与 index.html
idx = z.read('assets/public/index.html').decode('utf-8', 'replace')
print('index.html size:', len(idx))
print('  has polyfill   :', 'ellen-webview-polyfill' in idx)
for k in ['structuredClone', 'Object.hasOwn', 'replaceAll', 'Promise.any', 'queueMicrotask']:
    print('  polyfill %-16s:' % k, k in idx)
m = re.search(r'<script type="module"[^>]*src="([^"]+)"', idx)
print('  module entry   :', m.group(1) if m else 'NOT FOUND')

print()
# 3) dex: required() 的 const/4 是否 0x0
dex = z.read('classes.dex')
print('classes.dex size:', len(dex))
needle = b'\x12\x10\x0f\x00'
needle0 = b'\x12\x00\x0f\x00'
print('  raw 12 10 0f 00 count:', dex.count(needle))
print('  raw 12 00 0f 00 count:', dex.count(needle0))

print()
# 4) resources.arsc 关更新
arsc = z.read('resources.arsc')
print('resources.arsc size:', len(arsc))
print('  contains stable/latest.json :', b'stable/latest.json' in arsc)
print('  contains stable/closed.json :', b'stable/closed.json' in arsc)
dev = b'development/latest.json'
print('  contains development/latest.json :', dev in arsc)
z.close()
