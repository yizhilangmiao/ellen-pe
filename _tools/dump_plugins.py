#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""M0 契约占卜：从 dev.ellen.mobile 的 smali 抽出 21 个 Capacitor 插件的契约面。

用法:
    python dump_plugins.py [--root SMALI_ROOT] [--out CONTRACT_DIR]

产出:
    contract/native-plugins.json   机器读（插件 / 方法 / options / events / messages / 静态常量）
    contract/native-plugins.md     人读

原理:
    Capacitor 插件的契约面 = @PluginMethod 方法名 + 它读的 option 键 + 它 notifyListeners 的事件名
    + resolve/reject 的键 + 类里的静态常量。
    参数往往不在 public 方法里直接读（会转手 private helper），所以要跟一层同类的 private 调用。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Dict, List, Optional

DEFAULT_ROOT = Path(r"E:\ailian\艾莲手机版\创作版\dexwork\smali-b17")
DEFAULT_OUT = Path(r"E:\ailian\艾莲手机版\创作版\contract")

CLASS_RE = re.compile(r"L([a-zA-Z][\w$]*(?:/[\w$]+)+);")
METHOD_RE = re.compile(r"^\.method\s+(.+?)\s+([\w$<>]+?)(\(.*)$")
CONST_STR_RE = re.compile(r'^const-string(?:/jumbo)?\s+(v\d+|p\d+),\s*"((?:[^"\\]|\\.)*)"')
PLUGIN_ANN_RE = re.compile(r"annotation runtime Lcom/getcapacitor/annotation/CapacitorPlugin;")
METHOD_ANN_RE = re.compile(r"annotation runtime Lcom/getcapacitor/PluginMethod;")
RETURNTYPE_RE = re.compile(r"returnType\s*=\s*([^\s]+)")
NAME_ATTR_RE = re.compile(r'name\s*=\s*"([^"]+)"')
INVOKE_RE = re.compile(r"^invoke-\S+\s+(\{[^}]*\}),\s*(L[\w/$]+;->[\w$<>]+)\((.*)\)")
NOTIFY_RE = re.compile(r"->notifyListeners$")
PLUGINCALL_RE = re.compile(r"Lcom/getcapacitor/PluginCall;->(\w+)")
JSOBJ_PUT_RE = re.compile(r"Lcom/getcapacitor/JSObject;->put$")
STATIC_STR_RE = re.compile(r'^\.field\s+.*?static.*?([\w$]+):Ljava/lang/String;\s*=\s*"((?:[^"\\]|\\.)*)"')
PAYLOAD_KEY_RE = re.compile(r"^(?:data|value|result|json|ok|error|code|message|success)$")


def regs_of(sig: str) -> List[str]:
    sig = sig.strip()
    if sig.startswith("{"):
        sig = sig[1:-1]
    out: List[str] = []
    for part in sig.split(","):
        part = part.strip()
        if not part:
            continue
        if ".." in part:
            a, b = [x.strip() for x in part.split("..")]
            try:
                if a and b and a[0] == b[0] == "v":
                    out += [f"v{i}" for i in range(int(a[1:]), int(b[1:]) + 1)]
            except ValueError:
                pass
            continue
        out.append(part)
    return out


def walk_methods(lines: List[str]):
    start = None
    for i, line in enumerate(lines):
        s = line.strip()
        if s.startswith(".method "):
            start = i
        elif s.startswith(".end method") and start is not None:
            yield start, i
            start = None


def dedup(seq):
    return list(dict.fromkeys(seq))


def dedup_pairs(seq):
    seen, out = set(), []
    for d in seq:
        k = (d["api"], d["key"])
        if k not in seen:
            seen.add(k)
            out.append(d)
    return out


def parse_body(lines: List[str], start: int, end: int) -> dict:
    reg_str: Dict[str, str] = {}
    options: List[dict] = []
    events: List[str] = []
    put_keys: List[str] = []
    messages: List[dict] = []
    calls: List[str] = []
    consts: List[str] = []
    annotated = False
    return_type = None

    for i in range(start, end):
        s = lines[i].strip()
        if METHOD_ANN_RE.search(s):
            annotated = True
            continue
        if annotated and s.startswith("returnType"):
            m = RETURNTYPE_RE.search(s)
            if m:
                return_type = m.group(1)
            continue
        m = CONST_STR_RE.match(s)
        if m:
            reg_str[m.group(1)] = m.group(2)
            consts.append(m.group(2))
            continue
        m = INVOKE_RE.match(s)
        if not m:
            continue
        regs = regs_of(m.group(1))
        target = m.group(2)
        if NOTIFY_RE.search(target):
            for r in regs[1:]:
                if r in reg_str and reg_str[r]:
                    events.append(reg_str[r])
                    break
            continue
        mpc = PLUGINCALL_RE.search(target)
        if mpc:
            api = mpc.group(1)
            key = None
            for r in reversed(regs):
                if r in reg_str and reg_str[r]:
                    key = reg_str[r]
                    break
            if key:
                bucket = messages if api in ("resolve", "reject") else options
                bucket.append({"api": api, "key": key})
            continue
        if JSOBJ_PUT_RE.search(target):
            if regs and reg_str.get(regs[0]) and not PAYLOAD_KEY_RE.match(reg_str[regs[0]]):
                put_keys.append(reg_str[regs[0]])
            continue
        calls.append(target.split("->", 1)[1])

    return {
        "annotated": annotated,
        "returnType": return_type,
        "options": dedup_pairs(options),
        "messages": dedup_pairs(messages),
        "events": dedup(events),
        "putKeys": dedup(put_keys),
        "calls": dedup(calls),
        "constStrings": dedup(consts),
    }


def parse_file(path: Path) -> Optional[dict]:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    lines = text.splitlines()

    cls = None
    plugin_name = None
    has_ann = False
    static_strings: Dict[str, str] = {}
    for i, line in enumerate(lines):
        if cls is None and line.startswith(".class"):
            m = CLASS_RE.search(line)
            if m:
                cls = m.group(1)
        if PLUGIN_ANN_RE.search(line):
            has_ann = True
            for j in range(i + 1, min(i + 8, len(lines))):
                if ".end annotation" in lines[j]:
                    break
                m = NAME_ATTR_RE.search(lines[j])
                if m:
                    plugin_name = m.group(1)
                    break
        m = STATIC_STR_RE.match(line.strip())
        if m:
            static_strings[m.group(1)] = m.group(2)

    # 别按类名是否含 "Plugin" 判断：SystemBars / WebView / CapacitorCookies 都不含，
    # 但它们确实是注册过的插件。认类级 @CapacitorPlugin 注解。
    if not cls or not has_ann:
        return None

    by_name: Dict[str, dict] = {}
    ordered: List[dict] = []
    for start, end in walk_methods(lines):
        m = METHOD_RE.match(lines[start].strip())
        if not m:
            continue
        spec, name, params = m.group(1), m.group(2), m.group(3)
        body = parse_body(lines, start, end)
        rec = {
            "name": name,
            "params": params,
            "isStatic": "static" in spec.split(),
            "annotated": body["annotated"],
            "returnType": body["returnType"],
            "options": body["options"],
            "messages": body["messages"],
            "events": body["events"],
            "putKeys": body["putKeys"],
            "calls": body["calls"],
            "constStrings": body["constStrings"],
            "line": start + 1,
        }
        ordered.append(rec)
        by_name.setdefault(name, rec)

    # 合并同类 private helper 的 option / events（最多两层），否则契约面会漏一半
    for rec in ordered:
        if not rec["annotated"]:
            continue
        seen = {(d["api"], d["key"]) for d in rec["options"] + rec["messages"]}

        def merge(r: dict, depth: int = 0):
            if depth > 2:
                return
            for item in r["options"]:
                k = (item["api"], item["key"])
                if k not in seen:
                    seen.add(k)
                    rec["options"].append(item)
            for item in r["messages"]:
                k = (item["api"], item["key"])
                if k not in seen:
                    seen.add(k)
                    rec["messages"].append(item)
            for item in r["events"]:
                if item not in rec["events"]:
                    rec["events"].append(item)
            for item in r["putKeys"]:
                if item not in rec["putKeys"]:
                    rec["putKeys"].append(item)
            for callee in r["calls"]:
                if callee in by_name and callee != rec["name"]:
                    merge(by_name[callee], depth + 1)

        for callee in list(rec["calls"]):
            if callee in by_name and callee != rec["name"]:
                merge(by_name[callee])

    pm = [r for r in ordered if r["annotated"]]
    return {
        # 注解里没写 name 时，Capacitor 用类简名当插件名（SystemBars / WebView 就是这种）
        "plugin": plugin_name or cls.split("/")[-1],
        "class": cls.replace("/", "."),
        "file": str(path),
        "smaliBytes": path.stat().st_size,
        "methodCount": len(ordered),
        "pluginMethodCount": len(pm),
        # 事件常常由内部回调（非 @PluginMethod）发出，所以事件面按整个类求并集
        "events": dedup([e for r in ordered for e in r["events"]]),
        "staticStrings": static_strings,
        "methods": ordered,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=str(DEFAULT_ROOT))
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    args = ap.parse_args()

    root = Path(args.root)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    if not root.is_dir():
        print(f"[FATAL] smali root 不存在: {root}")
        return 2

    # 插件类不一定叫 *Plugin（SystemBars / WebView / CapacitorCookies 就不是），
    # 所以按注解字面量找，别按文件名猜。
    anno = b"Lcom/getcapacitor/annotation/CapacitorPlugin;"
    NOT_A_PLUGIN = {"Plugin", "PluginHandle", "CapacitorPlugin"}
    files = sorted(
        p for p in root.rglob("*.smali")
        if anno in p.read_bytes() and p.stem.split("$")[0] not in NOT_A_PLUGIN
    )
    plugins = [p for p in (parse_file(f) for f in files) if p]
    plugins.sort(key=lambda p: (-p["pluginMethodCount"], p["plugin"] or ""))

    total_methods = sum(p["methodCount"] for p in plugins)
    total_pm = sum(p["pluginMethodCount"] for p in plugins)
    pm_all = [m for p in plugins for m in p["methods"] if m["annotated"]]
    stat = {
        "pluginMethods": total_pm,
        "withOptions": sum(1 for m in pm_all if m["options"]),
        "withEvents": sum(1 for m in pm_all if m["events"]),
        "withMessages": sum(1 for m in pm_all if m["messages"]),
        "optionKeys": sum(len(m["options"]) for m in pm_all),
        "eventNames": sum(len(m["events"]) for m in pm_all),
    }

    data = {
        "source": str(root),
        "fileCount": len(files),
        "pluginCount": len(plugins),
        "totalMethods": total_methods,
        "totalPluginMethods": total_pm,
        "coverage": stat,
        "plugins": plugins,
    }
    jf = out / "native-plugins.json"
    jf.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")

    md: List[str] = []
    md.append("# 手机版原生插件契约（M0 自动生成）\n")
    md.append(f"> 源：`{root}`　生成器：`_tools/dump_plugins.py`（重跑即刷新，勿手改）\n")
    md.append(f"**插件 {len(plugins)} 个 · 方法 {total_methods} 个 · `@PluginMethod` {total_pm} 个**\n")
    md.append(f"覆盖率：带 options {stat['withOptions']} 个 · 带 events {stat['withEvents']} 个 · "
              f"带 resolve/reject 键 {stat['withMessages']} 个 · option 键合计 {stat['optionKeys']} · "
              f"事件名合计 {stat['eventNames']}\n")
    md.append("| 插件 | @PluginMethod | 全部方法 | smali | 静态常量 |")
    md.append("|---|---|---|---|---|")
    for p in plugins:
        md.append(f"| `{p['plugin'] or '(无名)'}` | {p['pluginMethodCount']} | {p['methodCount']} | "
                  f"{p['smaliBytes']//1024} KB | {len(p['staticStrings'])} |")
    md.append("")
    for p in plugins:
        md.append(f"\n## {p['plugin']} — `{p['class']}`\n")
        if p["staticStrings"]:
            md.append("静态常量：")
            for k, v in p["staticStrings"].items():
                vv = v if len(v) <= 100 else v[:97] + "..."
                md.append(f"- `{k}` = `{vv}`")
            md.append("")
        md.append("| 方法 | 参数 | 返回注解 | options | events | resolve/reject |")
        md.append("|---|---|---|---|---|---|")
        for m in p["methods"]:
            if not m["annotated"]:
                continue
            opts = ", ".join(f"{o['api']}:{o['key']}" for o in m["options"])
            msgs = ", ".join(f"{o['api']}:{o['key']}" for o in m["messages"])
            md.append("| `{}` | `{}` | {} | {} | {} | {} |".format(
                m["name"],
                m["params"].replace("|", "\\|"),
                m["returnType"] or "",
                opts,
                ", ".join(m["events"]),
                msgs,
            ))
        others = [m["name"] for m in p["methods"] if not m["annotated"]]
        if others:
            md.append(f"\n> 非 `@PluginMethod`：{', '.join('`'+o+'`' for o in others)}")
    mf = out / "native-plugins.md"
    mf.write_text("\n".join(md) + "\n", encoding="utf-8")

    print(f"[OK] plugins={len(plugins)} methods={total_methods} pluginMethods={total_pm}")
    print(f"[COV] withOptions={stat['withOptions']} withEvents={stat['withEvents']} "
          f"withMessages={stat['withMessages']} optionKeys={stat['optionKeys']} events={stat['eventNames']}")
    print(f"[OUT] {jf}")
    print(f"[OUT] {mf}")
    for p in plugins:
        print(f"  {p['plugin'] or '(无名)':<26} pm={p['pluginMethodCount']:<3} total={p['methodCount']:<3} {p['class']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
