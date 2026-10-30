# -*- coding: utf-8 -*-
"""手机版功能注入补丁（骨架版）：把 _phone-sync/inject-<feat>.js 挂进已有条目。

为什么是「挂进已有条目」：_dev_pack.py 只按 .zextract-manifest.json 里
已有的条目回包，新增文件永远进不了 APK。所以所有新代码必须落在已有文件里。
ellen-startup-opening.js 是最佳落点：它是自写 polyfill、非 module、在 bundle
之前执行、整文件可替换。

幂等：BEGIN 标记已存在 → 视为已打，不重复写。
回滚：删掉 BEGIN..END 整段。

用法:
    python _patch_phone_letter.py --check     # 只报告状态
    python _patch_phone_letter.py            # 注入
    python _patch_phone_letter.py --revert   # 撤销注入
    python _patch_phone_letter.py --list     # 列出可注入模块
"""
import argparse
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
SYNC = os.path.join(HERE, "_phone-sync")
TARGET = os.path.join(HERE, "work", "assets", "public", "ellen-startup-opening.js")

# 锚点：目标文件末尾的收尾句（必须唯一，改目标文件时要重新核对）
ANCHOR = (
    '  if (typeof document !== "undefined" && typeof window !== "undefined") '
    "startStartupOpening();\n})();"
)

FEATURES = {
    "letter": "inject-letter.js",
}


def marker(feat):
    return "/* ==== ELLEN-INJECT %s BEGIN ==== */" % feat, "/* ==== ELLEN-INJECT %s END ==== */" % feat


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


def strip_block(text, feat):
    b, e = marker(feat)
    i = text.find(b)
    if i < 0:
        return text, False
    j = text.find(e, i)
    if j < 0:
        return text, False
    return (text[:i] + text[j + len(e):]).rstrip() + "\n", True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--revert", action="store_true")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--feat", default="letter")
    ap.add_argument("--report", action="store_true", help="输出 JSON 报告")
    args = ap.parse_args()

    if args.list:
        for k, v in FEATURES.items():
            print("%-10s %s" % (k, v))
        return

    feat = args.feat
    b, _e = marker(feat)
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
        new_text, removed = strip_block(text, feat)
        if removed:
            save_target(new_text)
            status["state"] = "reverted"
        else:
            status["state"] = "nothing-to-revert"
    elif not args.check and not has_block:
        if anchor_n != 1:
            status["state"] = "conflict"
            status["error"] = "锚点命中 %d 次（要求 1 次），拒绝注入" % anchor_n
        else:
            code = load_inject(feat)
            new_text = text.replace(ANCHOR, ANCHOR + "\n\n" + block(feat, code), 1)
            save_target(new_text)
            status["state"] = "applied"
    elif not args.check and has_block:
        # 已打过：内容变了就整段替换（同一模块改代码后可重跑）
        code = load_inject(feat)
        old_block = block(feat, "")
        del old_block
        _, e = marker(feat)
        i = text.find(b)
        j = text.find(e, i) + len(e)
        new_text = text[:i] + block(feat, code) + text[j:]
        if new_text != text:
            save_target(new_text)
            status["state"] = "updated"
        else:
            status["state"] = "unchanged"

    if args.report:
        print(json.dumps(status, ensure_ascii=False, indent=2))
    else:
        print("[%s] %s  (锚点 %d)" % (status["state"], status["target"], status["anchor_hits"]))
        if status.get("error"):
            print("  !! " + status["error"])


if __name__ == "__main__":
    main()
