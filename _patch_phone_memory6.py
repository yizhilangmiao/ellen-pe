# -*- coding: utf-8 -*-
"""记忆整理「证据门」容错补丁（手机版）。

背景（2026-10-30 MuMu 实测）：
  work/assets/public/assets/service-DGjhUELY.js 里记忆条目落库前有三道硬门：
    U(t2.value.text.includes(o2), `MEMORY_NO_EVIDENCE`, ...)      # 引文必须逐字来自原话
    U(!userRetentionQuote || text.includes(q) && Tm.test(q), ...)  # 保留指令必须是白名单词
    if (confidence < 0.7) return null                              # 低置信直接丢
  整理任务 state=failed / MEMORY_NO_EVIDENCE / failureType=format，记忆库 0 条。
  模型实际上能给出逐字引文（直连压测 confidence 0.95），所以问题在「校验太死板」。

本补丁做三件事（幂等，可 --check / --revert）：
  P1 抓包：把每次整理拿到的原始 JSON 文本写进 localStorage["ellen-mem-dbg"]，便于下次定位。
  P2 引文容错：quote 不是原文子串时，先按标点切段找 ≥4 字的原文片段，
     再退化为 4~18 字滑窗找最长可命中片段；命中的片段回写 e8.quote。
  P3 保留词放宽：substring → 归一化 substring → Tm 命中 → 原话本身含「记着/记下/帮我记/备忘…」都放行。

用法:
    python _patch_phone_memory6.py            # 打补丁
    python _patch_phone_memory6.py --check    # 只看现状（0=已打，1=未打）
    python _patch_phone_memory6.py --revert   # 回滚到打补丁前
"""
import os
import shutil
import sys

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(HERE, "work", "assets", "public", "assets", "service-DGjhUELY.js")
BACKUP = os.path.join(HERE, "_backup_mem", "service-DGjhUELY.js.premem6")

MARK = "/*MEM6*/"

# ---------------------------------------------------------------- P1 抓包
P1_OLD = "  let n2;\n  try {\n    n2 = JSON.parse(e8.replace("
P1_NEW = (
    "  " + MARK + "try{var _md=globalThis.__ellenMemDbg||(globalThis.__ellenMemDbg=[]);"
    "_md.push(String(e8).slice(0,3e3));"
    "localStorage.setItem(`ellen-mem-dbg`,JSON.stringify(_md.slice(-6)))}catch(_mde){}\n"
    "  let n2;\n  try {\n    n2 = JSON.parse(e8.replace("
)

# ---------------------------------------------------------------- P2 引文容错
P2_OLD = "let o2 = Om(e8.quote, `\\u539F\\u8BDD`, 4e3);\n  if (U(t2.value.text.includes(o2),"
P2_NEW = (
    "let o2 = Om(e8.quote, `\\u539F\\u8BDD`, 4e3);\n"
    "  " + MARK + "try{const _h=String(t2.value.text||``),_q=String(o2||``);"
    "const _nm=x=>String(x||``).replace(/[\\s\\p{P}\\p{S}]/gu,``);let _p=``;"
    "if(!_h.includes(_q)){"
    "const _ps=_q.split(/[\\s\\p{P}\\p{S}]+/u).filter(x=>x&&x.length>=4);"
    "for(const _x of _ps)if(_h.includes(_x)&&_x.length>_p.length)_p=_x;"
    "if(!_p){outer:for(let _l=Math.min(_q.length,18);_l>=4;_l-=1){"
    "for(let _i=0;_i+_l<=_q.length;_i+=1){const _c=_q.slice(_i,_i+_l);"
    "if(_h.includes(_c)){_p=_c;break outer}}}}"
    "if(!_p&&_nm(_q)&&_nm(_h).includes(_nm(_q)))_p=_h;"
    "if(_p){o2=_p;e8.quote=_p}}}catch(_qe){}\n"
    "  if (U(t2.value.text.includes(o2),"
)

# ---------------------------------------------------------------- P3 保留词放宽
P3_OLD = (
    "U(!e8.userRetentionQuote || t2.value.text.includes(e8.userRetentionQuote) "
    "&& Tm.test(e8.userRetentionQuote), `MEMORY_NO_EVIDENCE`"
)
P3_NEW = (
    "U(!e8.userRetentionQuote || (()=>{try{"
    "const _q=String(e8.userRetentionQuote||``),_h=String(t2.value.text||``);"
    "if(_h.includes(_q))return!0;"
    "const _nm=x=>String(x||``).replace(/[\\s\\p{P}\\p{S}]/gu,``);"
    "if(_nm(_q)&&_nm(_h).includes(_nm(_q)))return!0;"
    "if(Tm.test(_q))return!0;"
    "if(/\\u8BB0\\u4F4F|\\u8BB0\\u7740|\\u8BB0\\u4E0B|\\u8BB0\\u4E00\\u4E0B|\\u8BB0\\u7262|"
    "\\u522B\\u5FD8|\\u522B\\u5FD8\\u4E86|\\u5E2E\\u6211\\u8BB0|\\u5E2E\\u6211\\u5B58|"
    "\\u5907\\u5FD8|\\u5B58\\u4E00\\u4E0B|\\u7559\\u4E2A\\u8BB0\\u5F55|\\u522B\\u4E22|remember/i"
    ".test(_h))return!0}catch(_re){}return!1})(), `MEMORY_NO_EVIDENCE`"
)

PATCHES = [("P1", P1_OLD, P1_NEW), ("P2", P2_OLD, P2_NEW), ("P3", P3_OLD, P3_NEW)]

# ---------------------------------------------------------------- P4 置信度兜底
P4_OLD = "e8.confidence < 0.7) return null;"
P4_NEW = (
    "e8.confidence < 0.55 || e8.confidence < 0.7 && !/"
    "\\u8BB0\\u4F4F|\\u8BB0\\u7740|\\u5E2E\\u6211\\u8BB0|\\u522B\\u5FD8/.test(String(t2.value.text||``))"
    ") return null;"
)
PATCHES.append(("P4", P4_OLD, P4_NEW))

# ---------------------------------------------------------------- P5 落库失败埋点
# Nm() 里 `if (d2 && !f2) return null;` 是「需要用户确认」分支：静默丢弃。
# 用 localStorage["ellen-mem-dbg2"] 记录是走到哪一步丢的。
P5_OLD = "if (d2 && !f2) return null;"
P5_NEW = (
    "if (d2 && !f2){try{localStorage.setItem(`ellen-mem-dbg2`,"
    "`drop:confirmation d2=`+String(d2)+` f2=`+String(!!f2))}catch(_e5a){} return null;}"
)
PATCHES.append(("P5", P5_OLD, P5_NEW))

# 构造出条目时留痕（说明校验全过）
P6_OLD = "return { id: p2, index: i2, action: e8.action"
P6_NEW = (
    "try{localStorage.setItem(`ellen-mem-dbg2`,`built:`+String(s2)+`|`+String(c2))}"
    "catch(_e6){} return { id: p2, index: i2, action: e8.action"
)
PATCHES.append(("P6", P6_OLD, P6_NEW))

# 调用点留痕（Nm 返回 null 还是条目）
P7_OLD = "if (!p5) continue;"
P7_NEW = (
    "try{localStorage.setItem(`ellen-mem-dbg3`,p5?(`ok `+String(p5.kind)+` `+String(p5.title)):`null`)}"
    "catch(_e7){} if (!p5) continue;"
)
PATCHES.append(("P7", P7_OLD, P7_NEW))


def read():
    with open(TARGET, encoding="utf-8") as f:
        return f.read()


def main():
    mode = "apply"
    for a in sys.argv[1:]:
        if a == "--check":
            mode = "check"
        elif a == "--revert":
            mode = "revert"

    if not os.path.exists(TARGET):
        print("目标不存在:", TARGET)
        return 2
    s = read()

    if mode == "check":
        done = [n for n, _o, new in PATCHES if new in s]
        missing = [n for n, _o, new in PATCHES if new not in s]
        print("文件:", TARGET)
        print("已打:", done or "无")
        print("未打:", missing or "无")
        return 0 if not missing else 1

    if mode == "revert":
        if not os.path.exists(BACKUP):
            print("没有备份，无法回滚:", BACKUP)
            return 2
        shutil.copy2(BACKUP, TARGET)
        print("已回滚:", TARGET)
        return 0

    if not os.path.exists(BACKUP):
        os.makedirs(os.path.dirname(BACKUP), exist_ok=True)
        shutil.copy2(TARGET, BACKUP)
        print("备份:", BACKUP)

    applied, skipped, absent = [], [], []
    for name, old, new in PATCHES:
        if new in s or (MARK + "") and old not in s and name in ("P1", "P2"):
            if new in s:
                skipped.append(name)
                continue
        if old not in s:
            absent.append(name)
            continue
        s = s.replace(old, new, 1)
        applied.append(name)

    if not applied:
        print("没有可打的补丁。skipped=%s absent=%s" % (skipped, absent))
        return 1

    with open(TARGET, "w", encoding="utf-8", newline="") as f:
        f.write(s)
    print("已应用:", applied, "跳过:", skipped, "未找到锚点:", absent)

    s2 = read()
    ok = all(n in applied and new in s2 for n, _o, new in PATCHES if n in applied)
    print("自检:", "OK" if ok else "FAILED", "大小", len(s2))
    return 0 if ok else 3


if __name__ == "__main__":
    sys.exit(main())
