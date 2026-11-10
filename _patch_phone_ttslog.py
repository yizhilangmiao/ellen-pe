# -*- coding: utf-8 -*-
"""临时诊断补丁：把每一条送进 TTS 的朗读文本打到 WebView console（logcat 可见）。

只加一行 console.log，不改任何取值逻辑。测完必须 --revert，再出正式包。

用法:
    python _patch_phone_ttslog.py --check
    python _patch_phone_ttslog.py
    python _patch_phone_ttslog.py --revert
"""
import argparse
import os
import shutil
import sys

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(HERE, "work", "assets", "public", "assets", "persona-CBp1pExX.js")

MARK = "/* ellen-tts-trace */"

OLD = "    return /[\\p{L}\\p{N}]/u.test(s3) ? s3.replace(/[ \\t]{2,}/gu, ` `).trim() : o3;"

NEW = (
    "    let c3 = /[\\p{L}\\p{N}]/u.test(s3) ? s3.replace(/[ \\t]{2,}/gu, ` `).trim() : o3;\n"
    "    " + MARK + " try { console.log(`[TTS-READ] src=` + o3 + ` || out=` + c3); } catch (_te) {}\n"
    "    return c3;"
)

ANCHOR = "  function i2(e3) {\n    /* ellen-readaloud-strip */"


def load():
    if not os.path.isfile(TARGET):
        sys.exit("缺目标文件: " + TARGET)
    with open(TARGET, encoding="utf-8", newline="") as f:
        return f.read()


def save(text):
    bak = TARGET + ".bak-ttslog"
    shutil.copyfile(TARGET, bak)
    with open(TARGET, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    return bak


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()

    t = load()
    has = MARK in t
    if args.revert:
        if not has:
            print("[nothing-to-revert]")
            return
        save(t.replace(NEW, OLD, 1))
        print("[reverted]")
        return

    n_anchor = t.count(ANCHOR)
    n_old = t.count(OLD)
    if has:
        print("[already]")
    elif n_anchor != 1 or n_old != 1:
        print("[conflict] anchor=%d old=%d（都要 1）" % (n_anchor, n_old))
        sys.exit(2)
    elif args.check:
        print("[pending] 锚点各 1 次，可以打")
    else:
        bak = save(t.replace(OLD, NEW, 1))
        print("[applied] 备份 " + os.path.basename(bak))


if __name__ == "__main__":
    main()
