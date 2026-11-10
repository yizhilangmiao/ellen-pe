#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""M0 第二步：交叉核对 —— web 打包产物里到底调了哪些插件方法。

输入:
    contract/native-plugins.json（dump_plugins.py 产出）
    work/assets/public/assets/*.js（旧 web 产物，混淆无 sourcemap）

做法:
    插件名在产物里以字面量出现，形态为 `st(\`EllenArchive\`)`（st = registerPlugin）。
    以插件名每个出现点为中心取窗口，抓窗口内 `xxx.method(` 的方法名，
    再与本契约比对：命中的=真在用；契约里有但没命中的=疑似未用（或走了动态名）。

产出:
    contract/web-usage.json
    contract/web-usage.md
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

BASE = Path(r"E:\ailian\艾莲手机版\创作版")
CONTRACT = BASE / "contract" / "native-plugins.json"
WEB_DIR = BASE / "work" / "assets" / "public" / "assets"

WINDOW = 1400
CALL_RE = re.compile(r"\b([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(")
LISTEN_RE = re.compile(r"addListener\s*\(")


def main() -> int:
    data = json.loads(CONTRACT.read_text(encoding="utf-8"))
    plugins = {p["plugin"]: p for p in data["plugins"] if p["plugin"]}
    method_index = {}
    for name, p in plugins.items():
        for m in p["methods"]:
            if m["annotated"]:
                method_index.setdefault(m["name"], set()).add(name)

    chunks = sorted(WEB_DIR.glob("*.js"))
    texts = {}
    for c in chunks:
        try:
            texts[c.name] = c.read_text(encoding="utf-8", errors="replace")
        except OSError:
            pass

    result = {}
    for name in sorted(plugins):
        occ, files, used, unknowns, listeners = 0, set(), set(), set(), 0
        own_methods = {m["name"] for m in plugins[name]["methods"] if m["annotated"]}
        for fname, text in texts.items():
            start = 0
            while True:
                i = text.find(name, start)
                if i < 0:
                    break
                occ += 1
                files.add(fname)
                lo, hi = max(0, i - WINDOW), min(len(text), i + WINDOW)
                win = text[lo:hi]
                listeners += len(LISTEN_RE.findall(win))
                for m in CALL_RE.finditer(win):
                    meth = m.group(2)
                    if meth in own_methods:
                        used.add(meth)
                    elif meth in method_index:
                        unknowns.add(meth)
                start = i + len(name)
        result[name] = {
            "occurrences": occ,
            "files": sorted(files),
            "usedMethods": sorted(used),
            "otherPluginMethodsInWindow": sorted(unknowns),
            "addListenerMentions": listeners,
        }

    used_all = set()
    for v in result.values():
        used_all |= set(v["usedMethods"])

    # 二道：全量统计。插件对象常被当参数传进别的函数，窗口抓不到；
    # 方法名属性访问不会被压缩，所以直接全量数 `.<name>(` 更全，只是丢了归属。
    GENERIC = {
        "get", "set", "start", "stop", "state", "open", "close", "cancel", "clear",
        "read", "write", "list", "load", "save", "run", "init", "reset", "query",
        "delete", "remove", "add", "update", "request", "send", "connect", "disconnect",
        "play", "pause", "resume", "next", "prev", "on", "off", "emit", "then", "catch",
    }
    all_text = "\n".join(texts.values())
    global_hits = {}
    for name, p in plugins.items():
        for m in p["methods"]:
            if not m["annotated"]:
                continue
            meth = m["name"]
            if meth in global_hits:
                continue
            # 直接属性调用：.startRecording(
            cnt_call = all_text.count(f".{meth}(")
            # 名字字面量：字符串/模板串形态（旧产物用通用派发器按名字调用，很常见）
            cnt_lit = all_text.count(f"`{meth}`") + all_text.count(f'"{meth}"') + all_text.count(f"'{meth}'")
            if cnt_call or cnt_lit:
                global_hits[meth] = {
                    "directCalls": cnt_call,
                    "nameLiterals": cnt_lit,
                    "plugin": name,
                    "via": "direct" if cnt_call else "name-string",
                }
    used_all |= set(global_hits)

    unused_in_web = sorted(m for n, p in plugins.items() for m in
                           {mm["name"] for mm in p["methods"] if mm["annotated"]}
                           if m not in used_all)
    absent_plugins = [n for n, v in result.items() if v["occurrences"] == 0]

    out = {
        "chunks": [c.name for c in chunks],
        "pluginCount": len(plugins),
        "usedMethodTotal": len(used_all),
        "absentPlugins": absent_plugins,
        "unusedMethodsCount": len(unused_in_web),
        "unusedMethods": unused_in_web,
        "globalMethodHits": global_hits,
        "plugins": result,
    }
    jf = BASE / "contract" / "web-usage.json"
    jf.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")

    md = ["# web 产物 ↔ 原生契约 交叉核对（M0 自动生成）\n",
          f"> 产物：{', '.join(c.name for c in chunks)}\n",
          f"**插件 {len(plugins)} 个 · web 里出现方法 {len(used_all)} 个（含全量计数）· "
          f"契约里没被调用 {len(unused_in_web)} 个 · 完全没出现的插件 {len(absent_plugins)} 个**\n"]
    md.append("| 插件 | 出现次数 | 用到的方法 | addListener |")
    md.append("|---|---|---|---|")
    for name in sorted(result):
        v = result[name]
        md.append(f"| `{name}` | {v['occurrences']} | {len(v['usedMethods'])} | {v['addListenerMentions']} |")
    md.append("\n## 逐插件明细\n")
    for name in sorted(result):
        v = result[name]
        md.append(f"\n### {name}（{v['occurrences']} 处 / {', '.join(v['files']) or '无'}）\n")
        md.append("用到：" + (", ".join(f"`{m}`" for m in v["usedMethods"]) or "（窗口内没抓到，可能动态调用）"))
        if v["otherPluginMethodsInWindow"]:
            md.append("\n同窗口出现的其它插件方法（噪音/串联）：" +
                      ", ".join(f"`{m}`" for m in v["otherPluginMethodsInWindow"][:20]))
    if absent_plugins:
        md.append("\n## ⚠ web 里完全没出现的插件\n")
        md.append(", ".join(f"`{n}`" for n in absent_plugins))
    mf = BASE / "contract" / "web-usage.md"
    mf.write_text("\n".join(md) + "\n", encoding="utf-8")

    print(f"[OK] usedMethods={len(used_all)} unused={len(unused_in_web)} absent={absent_plugins}")
    print(f"[OUT] {jf}")
    print(f"[OUT] {mf}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
