# -*- coding: utf-8 -*-
"""手机端记忆改造补丁（对 work/assets/public/assets 下的 minified bundle 做精确替换）。

每个补丁 = (文件, 说明, 原文, 新文)。幂等：原文不在但新文在 → 视为已打。
用法:
    python _patch_phone_memory.py --check     # 只报告状态
    python _patch_phone_memory.py            # 应用
    python _patch_phone_memory.py --revert   # 回滚（新文→原文）
"""
import argparse
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, "work", "assets", "public", "assets")

PATCHES = []


def patch(fname, name, old, new):
    PATCHES.append({"file": fname, "name": name, "old": old, "new": new})


# ---------------------------------------------------------------- ① 字面召回 + 单字门槛
patch(
    "service-DGjhUELY.js",
    "字面递归路 + 单字门槛放宽",
    "f=ml(t.slice(0,2400),s),p=new Map(f.map(e=>[e.doc.id,e.score])),m=new Map(o.map(e=>[e.doc.id,e.score]));"
    "return{items:gl([f.slice(0,24),o.slice(0,24)],{limit:48})"
    ".filter(({doc:e})=>r||e.state!==`dormant`||pl(e.text).filter(e=>u.has(e)).length>=2||(m.get(e.id)||0)>=.55)",
    "f=ml(t.slice(0,2400),s),p=new Map(f.map(e=>[e.doc.id,e.score])),m=new Map(o.map(e=>[e.doc.id,e.score])),"
    "q=t.trim().toLowerCase(),"
    "z=!q||q.length>12?[]:s.filter(e=>e.text.toLowerCase().includes(q)).map(e=>({doc:e,score:1}));"
    "return{items:gl([f.slice(0,24),o.slice(0,24),z.slice(0,24)],{limit:48})"
    ".filter(({doc:e})=>r||e.state!==`dormant`||pl(e.text).filter(e=>u.has(e)).length>=Math.min(2,u.size||1)"
    "||(m.get(e.id)||0)>=.55||q.length>0&&q.length<=8&&e.text.toLowerCase().includes(q))",
)


# ---------------------------------------------------------------- ② 会话摘要（拼进 rules，零存储改动）
patch(
    "service-DGjhUELY.js",
    "早期对话摘要注入 rules",
    "P=new Map;for(let e of[",
    r"""P=new Map;E=E+(()=>{try{let _vals=y?.byId instanceof Map?[...y.byId.values()]:Object.values(y?.byId??{}),_s2=_vals.filter(e=>e?.kind===`message`&&!e.deleted&&!e.conflict).map(e=>e.revisions?.[0]?.value).filter(e=>e&&e.threadId===o&&(e.role===`user`||e.role===`assistant`)&&typeof e.text===`string`&&e.text.trim()).sort((e,t)=>String(e.createdAt)===String(t.createdAt)?(String(e.id)<String(t.id)?-1:1):String(e.createdAt)<String(t.createdAt)?-1:1),_cut=Math.max(0,_s2.length-12),_ol=_s2.slice(0,_cut);if(_ol.length<8)return ``;let _e0=_ol[0],_seg=(()=>{let _stp=Math.max(1,Math.ceil(_ol.length/14)),_pk=[];for(let _i=0;_i<_ol.length;_i+=_stp)_pk.push(_ol[_i]);return _pk.slice(0,14).map(e=>(e.role===`user`?`我`:`艾莲`)+`：`+e.text.replace(/\s+/g,` `).slice(0,40)).join(` / `)})();return `\n\n[早期对话摘要] 本会话较早 ${_ol.length} 条（截至 ${String(_e0.createdAt).slice(0,10)}）：最早 ${_e0.role===`user`?`我`:`艾莲`} 说 ${_e0.text.replace(/\s+/g,` `).slice(0,60)}；其后 ${_seg}`}catch{return ``}})();for(let e of[""",
)


def load(fname):
    p = os.path.join(ASSETS, fname)
    if not os.path.isfile(p):
        sys.exit("缺文件: " + p)
    with open(p, encoding="utf-8") as f:
        return p, f.read()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()

    status = []
    for pt in PATCHES:
        p, s = load(pt["file"])
        has_old, has_new = s.count(pt["old"]), s.count(pt["new"])
        state = "applied" if has_new == 1 and has_old == 0 else ("pending" if has_old == 1 and has_new == 0 else "conflict")
        status.append((pt, p, s, state, has_old, has_new))
        print("%-28s %-9s old=%d new=%d" % (pt["name"], state, has_old, has_new))

    if args.check:
        return 0

    if args.revert:
        for pt, p, s, state, _, _ in status:
            if state == "applied":
                with open(p, "w", encoding="utf-8", newline="") as f:
                    f.write(s.replace(pt["new"], pt["old"], 1))
                print("已回滚:", pt["name"])
        return 0

    bad = [pt["name"] for pt, _, _, state, _, _ in status if state == "conflict"]
    if bad:
        sys.exit("有补丁锚点不唯一，先人工确认: " + ", ".join(bad))

    for pt, p, s, state, _, _ in status:
        if state == "pending":
            with open(p, "w", encoding="utf-8", newline="") as f:
                f.write(s.replace(pt["old"], pt["new"], 1))
            print("已应用:", pt["name"], "->", os.path.basename(p))
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
