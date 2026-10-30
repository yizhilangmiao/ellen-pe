# -*- coding: utf-8 -*-
"""手机端 0.1.20 记忆改造 ③周期维护 ④关联召回。

③ 惰性维护：service worker 会被系统冻结，没有常驻定时器，所以把"周期维护"改成
   每次组上下文（je）时按 30 分钟节流补跑一次 T.recoverInterrupted()，把上次被
   冻结/崩溃打断的整理任务重新排上。
④ 关联召回：召回里再加一条"邻近共现"路——先按前 6 名种子记忆，找 anchorAt 前后
   15 分钟内锚定的其他记忆，一起进 rrf 融合（电脑端走 source_events 图，手机端没有
   事件表，用锚定时间邻接等价近似）。

用法：
  python _patch_phone_memory2.py --target <service-DGjhUELY.js> [--check|--revert]
不指定 --target 时默认改开发版 work 里的那份。
"""
import argparse
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT = os.path.join(HERE, "work", "assets", "public", "assets", "service-DGjhUELY.js")

# ---- ③ 惰性维护 -------------------------------------------------------------
P3_OLD = "let{view:y}=_||await H("
P3_NEW = (
    ";(()=>{try{const _k=`ellen-mem-maint-at`,_st=globalThis.localStorage;"
    "const _now=Date.now(),_last=Number(_st&&_st.getItem(_k)||0);"
    "if(_now-_last<18e5)return;_st&&_st.setItem(_k,String(_now));"
    "const _f=T&&T.recoverInterrupted;"
    "if(typeof _f===`function`)Promise.resolve().then(()=>_f.call(T)).catch(()=>{})"
    "}catch{}})();let{view:y}=_||await H("
)

# ---- ④ 邻近共现路 -----------------------------------------------------------
P4_OLD = (
    ";return{items:gl([f.slice(0,24),o.slice(0,24),z.slice(0,24)],{limit:48})"
    ".filter(({doc:e})=>"
)
P4_NEW = (
    ";const nl=(()=>{const _out=[];try{"
    "const _seeds=gl([f.slice(0,24),o.slice(0,24),z.slice(0,24)],{limit:6});"
    "for(const _s of _seeds){const _d=_s.doc||_s;"
    "const _t0=Date.parse(_d.anchorAt||_d.anchor_at||``);"
    "if(!Number.isFinite(_t0))continue;"
    "for(const _m of s){if(_m.id===_d.id)continue;"
    "const _t1=Date.parse(_m.anchorAt||_m.anchor_at||``);"
    "if(!Number.isFinite(_t1))continue;"
    "if(Math.abs(_t1-_t0)<=9e5)_out.push({doc:_m,score:1})}}"
    "_out.sort((a,b)=>a.doc.id<b.doc.id?-1:a.doc.id>b.doc.id?1:0)"
    "}catch{}return _out})();"
    "return{items:gl([f.slice(0,24),o.slice(0,24),z.slice(0,24),nl.slice(0,12)],{limit:48})"
    ".filter(({doc:e})=>"
)

PATCHES = [
    {"name": "③ 惰性周期维护（30 分钟节流 recoverInterrupted）", "old": P3_OLD, "new": P3_NEW},
    {"name": "④ 邻近共现召回路（±15 分钟锚定邻接）", "old": P4_OLD, "new": P4_NEW},
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", default=DEFAULT)
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--revert", action="store_true")
    a = ap.parse_args()

    path = os.path.abspath(a.target)
    s = open(path, encoding="utf-8").read()
    print("目标", path, len(s), "字符")

    rows, bad = [], []
    for p in PATCHES:
        o, n = s.count(p["old"]), s.count(p["new"])
        if n == 1 and o == 0:
            st = "applied"
        elif o == 1 and n == 0:
            st = "pending"
        elif o == 0 and n == 0:
            st = "missing"
        else:
            st = "conflict"
        rows.append((p, st, o, n))
        if st == "conflict":
            bad.append(p["name"])
        print("  %-46s %-9s old=%d new=%d" % (p["name"], st, o, n))

    if bad:
        print("!! 锚点不唯一，未写入:", bad)
        return 1
    if a.check:
        return 0

    for p, st, o, n in rows:
        if a.revert:
            if st == "applied":
                s = s.replace(p["new"], p["old"], 1)
                print("  回滚", p["name"])
        else:
            if st == "pending":
                s = s.replace(p["old"], p["new"], 1)
                print("  应用", p["name"])

    open(path, "w", encoding="utf-8", newline="").write(s)
    print("写回完成", len(s), "字符")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
