"""M0 合并：把「运行时真值」(Capacitor.PluginHeaders) 和「smali 推断」(options/messages/events) 合成一份可用契约。

用法：
    python merge_contract.py [--runtime contract/runtime-capacitor-b17.json] [--native contract/native-plugins.json] [--out contract]

为什么这么做：
    - 方法名清单以运行时为准（R8 改名、注解缺失、多发/少发都骗不过 PluginHeaders）；
    - options / resolve / reject 键只能从 smali 读（运行时 headers 不带参数名）；
    - 两边不一致的地方全部列出来，别静默取一边。
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Dict, List

# Capacitor 会给每个插件自动加的方法（不是 @PluginMethod 写出来的）
AUTO = {"addListener", "removeListener", "removeAllListeners", "checkPermissions", "requestPermissions"}

DEFAULT_OUT = Path(r"E:\ailian\艾莲手机版\创作版\contract")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runtime", default=str(DEFAULT_OUT / "runtime-capacitor-b17.json"))
    ap.add_argument("--native", default=str(DEFAULT_OUT / "native-plugins.json"))
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    args = ap.parse_args()

    out = Path(args.out)
    runtime = json.loads(Path(args.runtime).read_text(encoding="utf-8"))
    native = json.loads(Path(args.native).read_text(encoding="utf-8"))

    native_by_name = {p["plugin"]: p for p in native["plugins"]}
    rt_by_name = {h["name"]: h for h in runtime["headers"]}

    merged: List[dict] = []
    only_runtime: List[str] = []
    only_native: List[str] = []

    for name, header in rt_by_name.items():
        rt_methods = header.get("methods", [])
        nat = native_by_name.get(name)
        if not nat:
            only_runtime.append(name)
        nat_methods = {}
        if nat:
            for m in nat["methods"]:
                if m["annotated"]:
                    nat_methods.setdefault(m["name"], m)
        methods = []
        for m in rt_methods:
            mm = nat_methods.get(m["name"])
            methods.append({
                "name": m["name"],
                "rtype": m.get("rtype"),
                "auto": m["name"] in AUTO,
                "inSmali": bool(mm),
                "options": sorted({o["key"] for o in (mm or {}).get("options", [])
                                   if o["api"] not in ("resolve", "reject")}),
                "messages": [{"api": o["api"], "key": o["key"]} for o in (mm or {}).get("messages", [])],
                "events": (mm or {}).get("events", []),
            })
        rt_names = {m["name"] for m in rt_methods}
        smali_extra = sorted(n for n in nat_methods if n not in rt_names and n not in AUTO)
        merged.append({
            "plugin": name,
            "class": (nat or {}).get("class"),
            "events": (nat or {}).get("events", []),
            "staticStrings": (nat or {}).get("staticStrings", {}),
            "methodCount": len(methods),
            "pluginMethodCount": len([m for m in methods if not m["auto"]]),
            "methods": methods,
            "smaliOnlyMethods": smali_extra,
        })

    for name in native_by_name:
        if name not in rt_by_name:
            only_native.append(name)

    merged.sort(key=lambda p: (-p["pluginMethodCount"], p["plugin"]))
    total_pm = sum(p["pluginMethodCount"] for p in merged)
    with_opts = sum(1 for p in merged for m in p["methods"] if m["options"])
    data = {
        "runtime": str(args.runtime),
        "native": str(args.native),
        "pluginCount": len(merged),
        "pluginMethodCount": total_pm,
        "methodsWithOptions": with_opts,
        "onlyInRuntime": only_runtime,
        "onlyInSmali": only_native,
        "plugins": merged,
    }
    jf = out / "M0-最终契约.json"
    jf.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")

    md: List[str] = []
    md.append("# 手机版插件契约（M0 合并版 · 运行时 × smali）\n")
    md.append(f"> 运行时真值：`{Path(args.runtime).name}`（b17 装机实测 PluginHeaders）")
    md.append(f"> 参数面：`{Path(args.native).name}`（b17 classes.dex 反编译推断）")
    md.append(f"> 生成器：`_tools/merge_contract.py`\n")
    md.append(f"**插件 {len(merged)} 个 · 真实 @PluginMethod {total_pm} 个 · 带 options 的方法 {with_opts} 个**\n")
    md.append(f"- 只在运行时出现（smali 没抓到）：{', '.join(only_runtime) or '无'}")
    md.append(f"- 只在 smali 出现（未注册/已删）：{', '.join(only_native) or '无'}\n")
    md.append("| 插件 | 方法 | 事件 | smali 里有运行时时没有 |")
    md.append("|---|---|---|---|")
    for p in merged:
        md.append(f"| {p['plugin']} | {p['pluginMethodCount']} | {', '.join(p['events']) or '-'} | "
                  f"{', '.join(p['smaliOnlyMethods']) or '-'} |")
    md.append("\n## 方法与参数\n")
    for p in merged:
        md.append(f"### {p['plugin']}（{p['class']}）\n")
        md.append("| 方法 | 类型 | options | resolve/reject |")
        md.append("|---|---|---|---|")
        for m in p["methods"]:
            if m["auto"]:
                continue
            opts = ", ".join(m["options"]) or "-"
            msgs = ", ".join(f"{x['api']}:{x['key']}" for x in m["messages"]) or "-"
            flag = "" if m["inSmali"] else " ⚠️仅运行时"
            md.append(f"| {m['name']}{flag} | {m['rtype']} | {opts} | {msgs} |")
        md.append("")
    mf = out / "M0-最终契约.md"
    mf.write_text("\n".join(md) + "\n", encoding="utf-8")

    print(f"[OK] plugins={len(merged)} pluginMethods={total_pm} withOptions={with_opts}")
    print(f"[DIFF] onlyRuntime={only_runtime} onlySmali={only_native}")
    print(f"[OUT] {jf}")
    print(f"[OUT] {mf}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
