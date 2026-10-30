# -*- coding: utf-8 -*-
"""手机版注入补丁模板。用 new-phone-sync.ps1 生成，不要直接手改这份。

复制后只改两处：
  1. FEATURES 里的 feat → 注入模块文件名
  2. ANCHOR → 目标文件末尾的收尾句（必须唯一）

用法:
    python _patch_phone___FEAT__.py --check
    python _patch_phone___FEAT__.py
    python _patch_phone___FEAT__.py --revert
关键设计：
  - 幂等：BEGIN 标记存在 = 已打；重跑时整段替换（改了模块代码可以再跑）
  - 回滚：删 BEGIN..END 整段，不留残渣
  - 锚点必须唯一，命中数 != 1 就拒绝写盘
"""
import argparse
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
SYNC = os.path.join(HERE, "_phone-sync")
TARGET = os.path.join(HERE, "work", "assets", "public", "ellen-startup-opening.js")

# 目标文件末尾的收尾句。目标文件一变就要重新核对（--check 会报锚点命中数）
ANCHOR = (
    '  if (typeof document !== "undefined" && typeof window !== "undefined") '
    "startStartupOpening();\n})();"
)

FEATURES = {
    "__FEAT__": "inject-__FEAT__.js",
}


def marker(feat):
    return (
        "/* ==== ELLEN-INJECT %s BEGIN ==== */" % feat,
        "/* ==== ELLEN-INJECT %s END ==== */" % feat,
    )


def load_target():
    if not os.path.isfile(TARGET):
        sys.exit("缺目标文件: " + TARGET + "（先跑 _dev_extract.py）")
    with open(TARGET, encoding="utf-8") as f:
        return f.read()


def save_target(text):
    with open(TARGET, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def load_inject(feat):
    name = FEATURES.get(feat)
    if not name:
        sys.exit("未知功能: %s（可选: %s）" % (feat, ", ".join(FEATURES)))
    p = os.path.join(SYNC, name)
    if not os.path.isfile(p):
        sys.exit("缺注入模块: " + p)
    with open(p, encoding="utf-8") as f:
        return f.read()


def block(feat, code):
    b, e = marker(feat)
    return b + "\n" + code.rstrip() + "\n" + e


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--revert", action="store_true")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--feat", default="__FEAT__")
    ap.add_argument("--report", action="store_true")
    args = ap.parse_args()

    if args.list:
        for k, v in FEATURES.items():
            print("%-10s %s" % (k, v))
        return

    feat = args.feat
    b, e = marker(feat)
    text = load_target()
    has_block = b in text
    anchor_n = text.count(ANCHOR)
    status = {
        "feat": feat,
        "target": os.path.relpath(TARGET, HERE),
        "state": "applied" if has_block else "pending",
        "anchor_hits": anchor_n,
    }

    if args.revert:
        if has_block:
            i = text.find(b)
            j = text.find(e, i) + len(e)
            save_target((text[:i] + text[j:]).rstrip() + "\n")
            status["state"] = "reverted"
        else:
            status["state"] = "nothing-to-revert"
    elif not args.check:
        code = load_inject(feat)
        if has_block:
            i = text.find(b)
            j = text.find(e, i) + len(e)
            new_text = text[:i] + block(feat, code) + text[j:]
        else:
            if anchor_n != 1:
                status["state"] = "conflict"
                status["error"] = "锚点命中 %d 次（要求 1 次），拒绝注入" % anchor_n
                new_text = text
            else:
                new_text = text.replace(ANCHOR, ANCHOR + "\n\n" + block(feat, code), 1)
        if new_text != text:
            save_target(new_text)
            status["state"] = "applied" if not has_block else "updated"
        else:
            status["state"] = status.get("state", "unchanged")

    if args.report:
        print(json.dumps(status, ensure_ascii=False, indent=2))
    else:
        print("[%s] %s  (锚点 %d)" % (status["state"], status["target"], status["anchor_hits"]))
        if status.get("error"):
            print("  !! " + status["error"])


if __name__ == "__main__":
    main()
