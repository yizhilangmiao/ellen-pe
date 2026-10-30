# -*- coding: utf-8 -*-
"""改手机版版本号：work/AndroidManifest.xml（二进制 AXML）里的 versionName
+ work/assets/public/index.html 里的构建指纹。

不改 versionCode（覆盖安装不要求递增；真要发布新版本时再统一升）。
AXML 的字符串池是 UTF-16LE，"0.1.20" 与 "0.1.21" 等长，所以是原位替换，不动任何长度字段。

用法:
    python _set_version.py 0.1.21          # 改成 0.1.21
    python _set_version.py --check         # 只看当前版本
"""
import argparse
import os
import re
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.join(HERE, "work")
AXML = os.path.join(WORK, "AndroidManifest.xml")
INDEX = os.path.join(WORK, "assets", "public", "index.html")

# UTF-16LE 的三段式版本串：d \0 . \0 d \0 . \0 d \0 d \0
VRE = re.compile(rb"(\d)\x00\.\x00(\d)\x00\.\x00(\d)\x00(\d)\x00")


def read_axml_version():
    with open(AXML, "rb") as f:
        d = f.read()
    m = VRE.search(d)
    if not m:
        return None, d, None
    v = "%s.%s.%s%s" % tuple(c.decode() for c in m.groups())
    return v, d, m.start()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("version", nargs="?", default=None, help="目标版本，如 0.1.21")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    cur, d, off = read_axml_version()
    if cur is None:
        sys.exit("AndroidManifest.xml 里找不到 versionName（不是 AXML？）")
    print("manifest versionName 当前: %s  (offset %d)" % (cur, off))

    if args.check or not args.version:
        return
    new = args.version.strip()
    if not re.fullmatch(r"\d+\.\d+\.\d+", new):
        sys.exit("版本号要写成 x.y.z，收到: %r" % new)
    if len(new) != len(cur):
        sys.exit("版本串长度必须一致（原位改 AXML）：%s → %s" % (cur, new))

    changed = 0
    if new != cur:
        enc = new.encode("utf-16-le")
        d2 = d[:off] + enc + d[off + len(enc):]
        with open(AXML, "rb") as f:
            pass
        with open(AXML, "wb") as f:
            f.write(d2)
        changed += 1
        print("[ok] AndroidManifest.xml  versionName %s → %s" % (cur, new))
    else:
        print("[skip] AndroidManifest.xml 已是 %s" % new)

    # index.html 里的构建指纹：build=0.1.20-b15-mem (2026-10-29T23:21)
    if os.path.exists(INDEX):
        with open(INDEX, "r", encoding="utf-8") as f:
            html = f.read()
        stamp = time.strftime("%Y-%m-%dT%H:%M")
        pat = re.compile(r"build=(\d+\.\d+\.\d+)([^\s(]*) \(([^)]*)\)")
        m = pat.search(html)
        if m and (m.group(1) != new):
            html2 = pat.sub("build=%s (%s)" % (new, stamp), html, count=1)
            with open(INDEX, "w", encoding="utf-8", newline="") as f:
                f.write(html2)
            changed += 1
            print("[ok] index.html  build=%s → build=%s (%s)" % (m.group(0)[6:], new, stamp))
        else:
            print("[skip] index.html 构建指纹已是 %s" % (m.group(1) if m else "未找到"))
    else:
        print("[warn] 没找到 %s" % INDEX)

    print("改动 %d 处" % changed)


if __name__ == "__main__":
    main()
