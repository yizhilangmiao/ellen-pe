# -*- coding: utf-8 -*-
"""确认 esbuild 降级把中文字面量转成了 \\uXXXX（语义等价，仅体积变大）。"""
import io
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")

BS = chr(92)  # 反斜杠
PUB = r"E:\ailian\艾莲手机版\创作版\work\assets\public\assets"

TARGETS = [
    "main-CFFhpb4h.js",
    "persona-CBp1pExX.js",
    "service-DGjhUELY.js",
    "storage-worker-C5hDp6Bk.js",
]

for fn in TARGETS:
    p = os.path.join(PUB, fn)
    if not os.path.exists(p):
        print("[MISS]", fn)
        continue
    s = io.open(p, encoding="utf-8", errors="surrogateescape").read()
    plain = s.count("共同经历")
    esc = s.count(BS + "u5171" + BS + "u540c" + BS + "u7ecf" + BS + "u5386")
    print("%-30s 明文=%d  转义=%d  \\u总数=%d" % (fn, plain, esc, s.count(BS + "u")))

# 抽样看一段
p = os.path.join(PUB, "main-CFFhpb4h.js")
s = io.open(p, encoding="utf-8", errors="surrogateescape").read()
key = BS + "u5171" + BS + "u540c"
i = s.find(key)
if i >= 0:
    print()
    print("[样本]", s[max(0, i - 80):i + 60].replace(chr(10), " "))
