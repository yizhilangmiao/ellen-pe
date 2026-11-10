# -*- coding: utf-8 -*-
"""给 contact 配置兜底：emotion 状态里没有 contact 时视为启用。

根因：新装 app 的 emotion 状态没有 contact 字段，
m2() 里 `p3.contact.enabled` 为假 -> dueAt 恒 1/0 -> 永远 not-due。
"""
import sys

sys.stdout.reconfigure(encoding="utf-8")

F = "work/assets/public/assets/service-DGjhUELY.js"

EDITS = [
    (
        "c3 = t4 && p3.contact.enabled && s3.latestReply",
        "c3 = t4 && (p3.contact ? p3.contact.enabled : true) && s3.latestReply",
    ),
    (
        "if ($c(e8), (function(){try{globalThis.__ellenIlDbg=",
        "if ($c(e8), (function(){try{if(!e8.contact)e8.contact={enabled:true,"
        "initialMinMinutes:45,initialMaxMinutes:90,followupMinMinutes:45,"
        "followupMaxMinutes:90,schedule:`interval`};}catch(e){}})(), "
        "(function(){try{globalThis.__ellenIlDbg=",
    ),
]

d = open(F, encoding="utf-8").read()
for old, new in EDITS:
    n = d.count(old)
    print("hit=%d  %s" % (n, old[:60]))
    if n != 1:
        print("  !! 跳过（命中数不为 1）")
        continue
    d = d.replace(old, new)
open(F, "w", encoding="utf-8").write(d)
print("done")
