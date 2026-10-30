# -*- coding: utf-8 -*-
"""开发版回包：把 work/ 按解包时的 ZipInfo 原样写回一个新 APK（未签名）。

只有内容变化的条目会重新计算 CRC；顺序、压缩方式、时间戳与原包一致，
所以「什么都没改」时应与基准包逐条哈希相同，便于空跑自检。

用法:
    python _dev_pack.py                       # 输出 _build/<版本>-dev-unsigned.apk
    python _dev_pack.py --out X.apk
    python _dev_pack.py --report              # 只列改动，不写包
"""
import argparse
import hashlib
import json
import os
import re
import sys
import zipfile

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.join(HERE, "work")
MANIFEST = os.path.join(WORK, ".zextract-manifest.json")
BUILD = os.path.join(HERE, "_build")


def read_version():
    """从 work/AndroidManifest.xml（二进制 AXML）里抠 versionName。

    AXML 的字符串池是 UTF-16LE，版本串形如 0\\x00.\\x001\\x00.\\x002\\x000\\x00，
    所以按「数字+\\x00 重复四段、以 . 分隔」匹配，命中一处即可。
    """
    try:
        with open(os.path.join(WORK, "AndroidManifest.xml"), "rb") as f:
            d = f.read()
        m = re.search(rb"(\d)\x00\.\x00(\d)\x00\.\x00(\d)\x00(\d)\x00", d)
        if m:
            return "%s.%s.%s%s" % tuple(c.decode() for c in m.groups())
    except Exception:
        pass
    return None


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", default=WORK)
    ap.add_argument("--out", default=None)
    ap.add_argument("--report", action="store_true")
    args = ap.parse_args()

    if not os.path.isfile(MANIFEST):
        sys.exit("先跑 _dev_extract.py（缺 %s）" % MANIFEST)
    meta = json.load(open(MANIFEST, encoding="utf-8"))
    entries = [e for e in meta["entries"] if not e["skipped"]]

    plan = []
    changed, missing, same = [], [], 0
    for e in entries:
        p = os.path.join(args.work, e.get("path", e["name"]).replace("/", os.sep))
        if not os.path.isfile(p):
            missing.append(e["name"])
            continue
        h = sha256_file(p)
        if h == e["sha256"]:
            same += 1
        else:
            changed.append(e["name"])
        plan.append((e, p))

    print("条目 %d / 同 %d / 改 %d / 缺 %d" % (len(entries), same, len(changed), len(missing)))
    for n in changed:
        print("  [CHANGED] " + n)
    for n in missing:
        print("  [MISSING] " + n)
    if missing:
        sys.exit("有文件缺失，拒绝出包")
    if args.report:
        return

    base = os.path.basename(meta["source_apk"])
    ver = base.replace(".apk", "")
    # 包名跟着 AndroidManifest 的 versionName 走，改版本号只需改 manifest
    v = read_version()
    if v:
        ver = re.sub(r"\d+\.\d+\.\d+\w*", v, ver, count=1)
    out = args.out or os.path.join(BUILD, ver + "-dev-unsigned.apk")
    os.makedirs(os.path.dirname(out), exist_ok=True)

    with zipfile.ZipFile(out, "w") as zo:
        for e, p in plan:
            zi = zipfile.ZipInfo(e["name"], tuple(e["date_time"]))
            zi.compress_type = e["compress"]
            zi.external_attr = e["external_attr"]
            with open(p, "rb") as f:
                zo.writestr(zi, f.read())

    print("已写出:", out, os.path.getsize(out), "bytes")
    print("sha256:", sha256_file(out))


if __name__ == "__main__":
    main()
