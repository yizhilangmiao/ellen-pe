# -*- coding: utf-8 -*-
"""
给降级后的 main-C8dMeyqt.js 加三处定位日志，用来抓 STARTUP_FAILED / stage=storage 的真凶。
只加 console.log，不改任何逻辑；跑完必须重新 _pack.py + 签名。
"""
import io
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
F = os.path.join(HERE, "web_out", "assets", "main-C8dMeyqt.js")

s = io.open(F, encoding="utf-8", errors="surrogateescape").read()
print("原文件长度", len(s))

# A) catch 分支：把真正的异常打出来（这是关键，之前完全看不到）
A_OLD = "  } catch (e2) {\n    let t2 = am(e2, { stage: sm });"
A_NEW = (
    "  } catch (e2) {\n"
    "    try{console.error('[STARTUP-CATCH] name='+(e2&&e2.name)+' code='+(e2&&e2.code)+"
    " ' msg='+(e2&&e2.message)+' str='+String(e2)?String(e2):'');"
    "console.error('[STARTUP-CATCH] stack='+(e2&&e2.stack))}catch(_e){}\n"
    "    let t2 = am(e2, { stage: sm });"
)

# B) storage 阶段：每一步前后打点，定位卡在哪一步
B_OLD = (
    "um(`storage`, `\\u6B63\\u5728\\u6253\\u5F00\\u672C\\u5730\\u76F8\\u5904\\u8D44\\u6599\\u2026`), "
    "mm = await f({ platform: Ke.getPlatform() }), "
    "(await mm.profiles()).length || await mm.initializeProfile({ characterId: `ellen-lover` });\n"
    "    let t2 = q({ dataStore: mm }), "
    "n2 = await ((_b = (_a2 = t2.readStartup) == null ? void 0 : _a2.call(t2)) != null ? _b : t2.read());\n"
    "    if (!n2.active && !n2.deletedActive) "
    "throw Error(`\\u5F53\\u524D\\u4EBA\\u7269\\u9009\\u62E9\\u5C1A\\u672A\\u767B\\u8BB0\\u3002`);"
)
B_NEW = (
    "um(`storage`, `\\u6B63\\u5728\\u6253\\u5F00\\u672C\\u5730\\u76F8\\u5904\\u8D44\\u6599\\u2026`), "
    "console.log('[STG] 1 open-start platform=' + Ke.getPlatform()), "
    "mm = await f({ platform: Ke.getPlatform() }), "
    "console.log('[STG] 2 opened'), "
    "(()=>{})();\n"
    "    var _pf = await mm.profiles();\n"
    "    console.log('[STG] 3 profiles len=' + _pf.length + ' ' + JSON.stringify(_pf).slice(0,200));\n"
    "    if (!_pf.length) { await mm.initializeProfile({ characterId: `ellen-lover` }); "
    "console.log('[STG] 3b initialized'); }\n"
    "    let t2 = q({ dataStore: mm }), "
    "n2 = await ((_b = (_a2 = t2.readStartup) == null ? void 0 : _a2.call(t2)) != null ? _b : t2.read());\n"
    "    console.log('[STG] 4 readStartup=' + JSON.stringify(n2).slice(0,400));\n"
    "    if (!n2.active && !n2.deletedActive) "
    "{ console.log('[STG] 5 THROW 人物未登记'); "
    "throw Error(`\\u5F53\\u524D\\u4EBA\\u7269\\u9009\\u62E9\\u5C1A\\u672A\\u767B\\u8BB0\\u3002`); }"
)

cnt = {}
for name, old, new in (("A", A_OLD, A_NEW), ("B", B_OLD, B_NEW)):
    n = s.count(old)
    cnt[name] = n
    if n == 1:
        s = s.replace(old, new)
        print("[%s] 替换成功" % name)
    else:
        print("[%s] 匹配 %d 次，跳过" % (name, n))

if all(v == 1 for v in cnt.values()):
    io.open(F, "w", encoding="utf-8", errors="surrogateescape", newline="").write(s)
    print("已写回，新长度", len(s))
else:
    print("有未命中的补丁，未写盘。请检查 _OLD 字符串是否与磁盘一致。")
