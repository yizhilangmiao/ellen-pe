# -*- coding: utf-8 -*-
"""环境自检：一条命令看清「这台机器能不能改 APK、还缺什么」。

用法（在 创作版\\ 目录下）：
    python _check_env.py
    python _check_env.py --apk "..\\产出版\\艾莲-0.1.21.b1.apk"

输出每一行是 [OK] / [!!] / [??]，最后一句是结论。
[!!] = 必须解决，否则下一步做不了；[??] = 可选，缺了也能出包，只是验收要人眼。
"""
import argparse
import glob
import os
import shutil
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
PARENT = os.path.dirname(HERE)
WORK = os.path.join(HERE, "work")
MANIFEST = os.path.join(WORK, ".zextract-manifest.json")

REQUIRED = [
    "_dev_extract.py",
    "_dev_pack.py",
    "_dev_selftest.py",
    "_dev_sign.ps1",
    "_patch_phone_letter.py",
    "_edit_text.py",
    os.path.join("_phone-sync", "inject-letter.js"),
]
SIGNER_CANDS = [
    r"E:\ailian\工具\apk工具链\uber-apk-signer.jar",
    os.path.join(PARENT, "_工具", "uber-apk-signer.jar"),
    os.path.join(HERE, "_工具", "uber-apk-signer.jar"),
    os.path.join(HERE, "uber-apk-signer.jar"),
]

ok = []
bad = []
opt = []


def line(tag, msg, fix=None):
    print("  %s %s" % (tag, msg))
    if fix:
        print("       修复: " + fix)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apk", default=None, help="基准 APK 路径（不给就自动找 ..\\产出版\\*.apk）")
    args = ap.parse_args()

    print("")
    print("== 艾莲手机版 · 环境自检 ==")
    print("脚本目录: " + HERE)
    print("")

    # 1 python
    v = sys.version_info
    if v >= (3, 8):
        line("[OK]", "Python %d.%d.%d   (%s)" % (v[0], v[1], v[2], sys.executable))
        ok.append("python")
    else:
        line("[!!]", "Python 太旧: %d.%d.%d" % (v[0], v[1], v[2]),
             "装 Python 3.10 以上：https://www.python.org/downloads/windows/  装的时候勾 Add python.exe to PATH")
        bad.append("python")

    # 2 java（签名要用）
    java = shutil.which("java")
    if not java:
        cands = []
        if os.environ.get("JAVA_HOME"):
            cands.append(os.path.join(os.environ["JAVA_HOME"], "bin", "java.exe"))
        for root in (r"C:\Program Files\Java", r"C:\Program Files\Eclipse Adoptium", r"C:\Program Files\Microsoft"):
            for hit in glob.glob(os.path.join(root, "*", "bin", "java.exe")):
                cands.append(hit)
        java = next((c for c in cands if os.path.isfile(c)), None)
    if java:
        line("[OK]", "Java: " + java)
        ok.append("java")
    else:
        line("[!!]", "没有 java —— 签名这一步做不了（回包能做）",
             "装 JDK 17 或 21：https://adoptium.net/  ；装完新开一个窗口再跑本脚本")
        bad.append("java")

    # 3 脚本齐不齐
    missing = [p for p in REQUIRED if not os.path.isfile(os.path.join(HERE, p))]
    if not missing:
        line("[OK]", "流水线脚本齐全（%d 个）" % len(REQUIRED))
        ok.append("scripts")
    else:
        line("[!!]", "缺文件: " + ", ".join(missing), "把源码包重新解压一份，别只拷 py 不拷 _phone-sync\\")
        bad.append("scripts")

    # 4 签名器
    signer = next((c for c in SIGNER_CANDS if os.path.isfile(c)), None)
    if signer:
        line("[OK]", "签名器: " + signer)
        ok.append("signer")
    else:
        line("[!!]", "没找到 uber-apk-signer.jar（签名必需）",
             "放到下面任一位置：%s" % " 或 ".join(SIGNER_CANDS[:3]))
        bad.append("signer")

    # 5 基准 APK
    apk = args.apk
    if not apk:
        cands = sorted(glob.glob(os.path.join(PARENT, "产出版", "*.apk")), key=os.path.getmtime, reverse=True)
        apk = cands[0] if cands else None
    if apk and os.path.isfile(apk):
        size = os.path.getsize(apk)
        line("[OK]", "基准 APK: %s  (%.1f MB)" % (os.path.basename(apk), size / 1048576))
        ok.append("apk")
        if size < 300 * 1048576:
            line("[??]", "这个包偏小（正常约 570 MB），可能不是完整包")
            opt.append("apk-size")
    else:
        line("[!!]", "没找到基准 APK（整个流程的起点）",
             "把 艾莲-0.1.21.b1.apk 放进 ..\\产出版\\ ，或跑：python _dev_extract.py --clean --apk <APK完整路径>")
        bad.append("apk")

    # 6 是否已解包
    if os.path.isfile(MANIFEST):
        import json
        meta = json.load(open(MANIFEST, encoding="utf-8"))
        src = os.path.basename(meta.get("source_apk", "?"))
        line("[OK]", "work\\ 已解包（基准=%s，%d 条目）" % (src, meta.get("entry_count", 0)))
        ok.append("work")
        if not os.path.isfile(os.path.join(WORK, "assets", "public", "ellen-startup-opening.js")):
            line("[!!]", "work\\ 里没有 ellen-startup-opening.js —— 注入类改动没法落点",
                 "确认基准包对不对，然后重跑 _dev_extract.py --clean")
            bad.append("work-anchor")
    else:
        line("[??]", "work\\ 还没解包（正常，第一次先解包）",
             "python _dev_extract.py --clean --apk \"..\\产出版\\<基准APK>\"   # 约 2-5 分钟")

    # 7 磁盘空间
    drive = os.path.splitdrive(HERE)[0] or "C:"
    try:
        free = shutil.disk_usage(drive + os.sep).free
        if free > 3 * 1024 ** 3:
            line("[OK]", "%s 剩余 %.1f GB" % (drive, free / 1024 ** 3))
            ok.append("disk")
        else:
            line("[!!]", "%s 只剩 %.1f GB —— 解包 + 回包 + 签名要 3 GB 以上" % (drive, free / 1024 ** 3),
                 "清点空间再开工，中途写满会产出半包")
            bad.append("disk")
    except OSError:
        line("[??]", "读不到磁盘剩余空间")
        opt.append("disk")

    # 8 adb（可选）
    adb = shutil.which("adb") or next((p for p in glob.glob(r"E:\ailian\工具\platform-tools\adb.exe") if os.path.isfile(p)), None)
    if adb:
        line("[OK]", "adb: " + adb)
        ok.append("adb")
    else:
        line("[??]", "没有 adb —— 装到手机可以改用数据线拷文件/微信传，不阻塞")
        opt.append("adb")

    print("")
    if bad:
        print("结论: 还差 %d 项（%s），按上面「修复」做完再开工。" % (len(bad), ", ".join(bad)))
        return 1
    print("结论: 环境齐了，可以开工。（可选缺项 %s）" % (", ".join(opt) if opt else "无"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
