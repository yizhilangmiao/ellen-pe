# -*- coding: utf-8 -*-
"""把 web_out/ 里改动过的 assets/public 文件替换进基准 APK，输出新 APK（未签名）。"""
import os
import sys
import zipfile

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))

BASE = r"E:\ailian\艾莲手机版\历史版本\艾莲-0.1.8-免激活-关更新.apk"
OUT = os.path.join(HERE, "web_out")
DST = os.path.join(HERE, "_build", "艾莲-0.1.8-免激活-关更新-降级.apk")
PREFIX = "assets/public/"

os.makedirs(os.path.dirname(DST), exist_ok=True)

patch = {}
for root, _dirs, files in os.walk(OUT):
    for fn in files:
        full = os.path.join(root, fn)
        rel = os.path.relpath(full, OUT).replace(os.sep, "/")
        patch[PREFIX + rel] = full

print("基准包:", BASE, os.path.getsize(BASE), "bytes")
print("候选文件:", len(patch))

zin = zipfile.ZipFile(BASE)
existing = set(zin.namelist())

changed, same, absent = 0, 0, 0
plan = []
for arc, full in sorted(patch.items()):
    if arc not in existing:
        absent += 1
        print("  [ABSENT] " + arc)
        continue
    old = zin.read(arc)
    with open(full, "rb") as f:
        new = f.read()
    if old == new:
        same += 1
    else:
        changed += 1
        plan.append((arc, new, len(old), len(new)))

print("changed=%d same=%d absent=%d" % (changed, same, absent))
for arc, _new, o, n in plan:
    print("  PATCH %-58s %9d -> %9d" % (arc[len(PREFIX):], o, n))

if os.path.exists(DST):
    os.remove(DST)

plan_map = {a: n for a, n, _, _ in plan}
with zipfile.ZipFile(DST, "w") as zout:
    for zi in zin.infolist():
        data = plan_map.get(zi.filename)
        if data is None:
            data = zin.read(zi.filename)
        ni = zipfile.ZipInfo(zi.filename, zi.date_time)
        ni.compress_type = zi.compress_type
        ni.external_attr = zi.external_attr
        ni.create_system = zi.create_system
        ni.internal_attr = zi.internal_attr
        zout.writestr(ni, data)
zin.close()

print("written:", DST, os.path.getsize(DST), "bytes")
