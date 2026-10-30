# -*- coding: utf-8 -*-
"""从主 JS 里挖出启动流程的 stage 变量赋值序列与 catch 处理，判断失败可能卡在哪一步。"""
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")

SRC = r"web\assets\main-C8dMeyqt.js"
s = open(SRC, encoding="utf-8", errors="replace").read()

call = s.find("om.dataset.startup=`failed`")
print("catch 块位置:", call)
print()

# 往前找 try{
t = s.rfind("try{", max(0, call - 12000), call)
print("try{ 位置:", t, " 到 catch 的距离:", call - t)
print()

body = s[t:call]
print("=== try 块开头 1400 字符 ===")
print(body[:1400])
print()
print("=== try 块结尾 900 字符 ===")
print(body[-900:])
print()

# stage 变量赋值（sm）
print("=== sm 赋值 ===")
for m in re.finditer(r"\bsm\s*=\s*", body):
    print("  rel", m.start(), ":", repr(body[m.start() : m.start() + 40]))
print()

print("=== catch 之后 500 字符 ===")
print(s[call : call + 500])
