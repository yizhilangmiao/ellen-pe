# -*- coding: utf-8 -*-
"""修 Android 返回键接管：单次返回会被派发两次、且根页面没有双按保护。

现象（真机实测）：信匣开着按一次返回 → 信匣关了，但紧接着又退到桌面。
根因两点：
  1. Capacitor 的 backButton 事件在真机上会一次按键派发两次（实测 btc=2），
     第一次 appBack() 关掉一层，第二次 appBack() 已经没东西可关 → 直接 leaveApp()。
  2. installBackGuard 里的监听器没有 onBackPop 那套「1.5 秒内连按两下才退后台」的保护，
     只要 appBack() 返回 false 就无条件 leaveApp()。

改法：加 450ms 去抖吞掉重复派发 + 根页面改成双按确认，与 onBackPop 行为一致。

用法:
    python _patch_phone_backguard.py --check
    python _patch_phone_backguard.py
    python _patch_phone_backguard.py --revert
"""
import argparse
import os
import shutil
import sys

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(HERE, "work", "assets", "public", "ellen-startup-opening.js")

MARK = "/* ellen-backguard-fix */"

OLD = (
    '        App.addListener("backButton", function () {\n'
    "          if (appBack()) return;\n"
    "          if (!leaveApp()) {\n"
    "            try {\n"
    "              window.history.back();\n"
    "            } catch (e) {}\n"
    "          }\n"
    "        });"
)

NEW = (
    '        App.addListener("backButton", function () {\n'
    "          " + MARK + "\n"
    "          var __nb = Date.now();\n"
    "          /* 一次按键会被派发两次，450ms 内的重复事件直接吞掉 */\n"
    "          if (__nb - (window.__ellenBackAt || 0) < 450) return;\n"
    "          window.__ellenBackAt = __nb;\n"
    "          if (appBack()) return;\n"
    "          /* 根页面：1.5s 内连按第二下才退到后台，与 onBackPop 保持一致 */\n"
    "          var __now = Date.now();\n"
    "          if (__now - ROOT_BACK_AT < 1500) {\n"
    "            leaveApp();\n"
    "            ROOT_BACK_AT = 0;\n"
    "            return;\n"
    "          }\n"
    "          ROOT_BACK_AT = __now;\n"
    "        });"
)


def load():
    if not os.path.isfile(TARGET):
        sys.exit("缺目标文件: " + TARGET)
    with open(TARGET, encoding="utf-8", newline="") as f:
        return f.read()


def save(text, tag):
    bak = TARGET + ".bak-" + tag
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
        save(t.replace(NEW, OLD, 1), "backguard-before")
        print("[reverted]")
        return

    if has:
        print("[already]")
        return
    n_old = t.count(OLD)
    if n_old != 1:
        print("[conflict] old=%d（要 1）" % n_old)
        sys.exit(2)
    if args.check:
        print("[pending] 锚点 1 次，可以打")
        return
    bak = save(t.replace(OLD, NEW, 1), "backguard")
    print("[applied] 备份 " + os.path.basename(bak))


if __name__ == "__main__":
    main()
