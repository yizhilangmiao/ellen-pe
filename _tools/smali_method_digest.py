"""smali 方法摘要器 —— 给剩下的插件做「够写 Kotlin」的紧凑输出。

为什么不用整篇读：剩下 16 个插件 smali 合计 200 KB+，逐个全文读太贵。
这里只抽「契约相关」的骨架：
  - 每个 @PluginMethod 方法：参数读取键、常量字符串顺序、JSObject.put 键、notifyListeners 事件名、
    resolve/reject 的中文消息与错误码、以及调到的私有 helper 名字。
  - 非注解 helper 也打印（一行式），因为参数常在 helper 里读。

用法：
    python _tools/smali_method_digest.py <目录或文件> [--full <方法名>]

输出是给人看的摘要，不是 JSON —— 写代码时对着它抄。
"""

import re
import sys
from pathlib import Path

METHOD_RE = re.compile(r"^\.method\s+([\w\s$]+?)\s+(\S+?)\((.*?)\)(\S+)$")
END_RE = re.compile(r"^\.end method")
ANNO_RE = re.compile(r"Lcom/getcapacitor/PluginMethod;")
CONST_RE = re.compile(r'const-string(?:/jumbo)?\s+(?:v\d+|\{v\d+\}),\s*"(.*)"$')
PLUGINCALL_RE = re.compile(r"Lcom/getcapacitor/PluginCall;->(\w+)")
JSObject_PUT_RE = re.compile(r"Lcom/getcapacitor/JSObject;->put\(")
NOTIFY_RE = re.compile(r"->notifyListeners$")
INVOKE_RE = re.compile(r"^invoke-\S+\s+\{[^}]*\},\s*(L[\w/$]+;|[A-Za-z][\w/$]*)->([\w$<>]+)\(")
HELPER_RE = re.compile(r"^invoke-\S+\s+\{[^}]*\},\s+(\w+)->([\w$]+)\(", re.M)


def split_methods(text):
    """返回 [(annotated, signature, body_lines)]。"""
    out, cur, sig, anno = [], None, None, False
    runner = []
    for line in text.splitlines():
        m = METHOD_RE.match(line)
        if m:
            if sig is not None:
                out.append((anno, sig, runner))
            sig = f"{m.group(1)} {m.group(2)}({m.group(3)}){m.group(4)}"
            runner = []
            anno = False
            continue
        if sig is None:
            continue
        if END_RE.match(line):
            out.append((anno, sig, runner))
            sig, runner, anno = None, [], False
            continue
        if ANNO_RE.search(line):
            anno = True
        runner.append(line)
    if sig is not None:
        out.append((anno, sig, runner))
    return out


def digest(sig, body):
    strings, keys, puts, events, msgs, helpers = [], [], [], [], [], []
    for i, line in enumerate(body):
        s = line.strip()
        m = CONST_RE.search(s)
        if m:
            strings.append(m.group(1))
        m = PLUGINCALL_RE.search(s)
        if m and m.group(1).startswith("get"):
            keys.append(m.group(1))
        if JSObject_PUT_RE.search(s):
            nxt = next((x for x in body[i : i + 4] if CONST_RE.search(x.strip())), None)
            if nxt:
                puts.append(CONST_RE.search(nxt.strip()).group(1))
        if NOTIFY_RE.search(s):
            prev = next((x for x in reversed(body[max(0, i - 4) : i]) if CONST_RE.search(x.strip())), None)
            if prev:
                events.append(CONST_RE.search(prev.strip()).group(1))
        m = INVOKE_RE.match(s)
        if m and m.group(1) in ("Lcom/getcapacitor/PluginCall;", "PluginCall"):
            if m.group(2) in ("reject", "resolve"):
                msgs.append((m.group(2), [x for x in strings[-2:]]))
        hm = HELPER_RE.match(s)
        if hm and hm.group(1) in ("p0", "p1", "this"):
            helpers.append(hm.group(2))
    return {
        "strings": strings,
        "keys": keys,
        "puts": puts,
        "events": events,
        "msgs": msgs,
        "helpers": sorted(set(helpers)),
    }


def dump_file(path, full=None):
    text = path.read_text(encoding="utf-8", errors="replace")
    methods = split_methods(text)
    print(f"\n===== {path.name} ({len(text.splitlines())} 行, {len(methods)} 方法) =====")
    for anno, sig, body in methods:
        d = digest(sig, body)
        mark = "@PluginMethod" if anno else "           "
        print(f"\n{mark} {sig}")
        if d["strings"]:
            print(f"    const-string: {d['strings']}")
        if d["events"]:
            print(f"    notify:       {d['events']}")
        if d["keys"]:
            print(f"    call.get*:    {d['keys']}")
        if d["puts"]:
            print(f"    JSObject.put: {d['puts']}")
        if d["msgs"]:
            print(f"    resolve/reject: {d['msgs']}")
        if anno and d["helpers"]:
            print(f"    helpers:      {d['helpers'][:12]}")
        if full and full in sig:
            print("    ---- body ----")
            for line in body:
                print("      " + line)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    full = None
    if "--full" in sys.argv:
        full = sys.argv[sys.argv.index("--full") + 1]
        args = [a for a in args if a != full]
    target = Path(args[0])
    files = sorted(target.rglob("*Plugin.smali")) if target.is_dir() else [target]
    for f in files:
        dump_file(f, full)


if __name__ == "__main__":
    main()
