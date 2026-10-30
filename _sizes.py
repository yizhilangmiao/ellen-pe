# -*- coding: utf-8 -*-
"""统计 APK 内各目录的未压缩/压缩体积，找出可剔除的大块。"""
import collections
import sys
import zipfile

sys.stdout.reconfigure(encoding="utf-8")

APK = r"..\产出版\艾莲-0.1.8-免激活-关更新-降级.apk"
z = zipfile.ZipFile(APK)

buckets = collections.defaultdict(lambda: [0, 0, 0])  # raw, comp, count


def bucket_of(name):
    parts = name.split("/")
    if len(parts) == 1:
        return "(root) " + parts[0]
    if parts[0] == "assets" and len(parts) > 1:
        return "assets/" + parts[1] + ("/" + parts[2] if len(parts) > 2 and parts[1] == "public" else "")
    return parts[0] + ("/" + parts[1] if len(parts) > 1 else "")


for zi in z.infolist():
    if zi.is_dir():
        continue
    b = bucket_of(zi.filename)
    buckets[b][0] += zi.file_size
    buckets[b][1] += zi.compress_size
    buckets[b][2] += 1

rows = sorted(buckets.items(), key=lambda kv: -kv[1][0])
print(f"{'bucket':44} {'raw':>12} {'comp':>12} {'n':>6}")
print("-" * 78)
tot_raw = tot_comp = 0
for k, (raw, comp, n) in rows:
    tot_raw += raw
    tot_comp += comp
    print(f"{k:44} {raw/1048576:11.1f}M {comp/1048576:11.1f}M {n:6d}")
print("-" * 78)
print(f"{'TOTAL':44} {tot_raw/1048576:11.1f}M {tot_comp/1048576:11.1f}M")

print()
print("=== 最大的 30 个文件 ===")
big = sorted((zi for zi in z.infolist() if not zi.is_dir()), key=lambda zi: -zi.file_size)[:30]
for zi in big:
    print(f"{zi.file_size/1048576:9.1f}M  {zi.filename}")
