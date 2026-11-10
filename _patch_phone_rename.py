# -*- coding: utf-8 -*-
"""改包名：把 cn.ellen.companion 换成等长包名，另装一份独立测试版。

为什么等长：AndroidManifest.xml 是二进制 AXML，包名在字符串池里，
长度一变所有偏移都要重算；resources.arsc 同理。等长替换 = 纯字节替换，
不动任何偏移，风险最小。

用法:
    python _patch_phone_rename.py            # 打上
    python _patch_phone_rename.py --check    # 只看现状
    python _patch_phone_rename.py --revert   # 还原
"""
import os
import shutil
import sys

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.join(HERE, "work")

OLD = "cn.ellen.companion"
NEW = "cn.ellen.companiox"  # 必须与 OLD 等长

BAK = ".bak-rename"

TARGETS = [
    ("AndroidManifest.xml", ("utf-16-le",)),
    ("resources.arsc", ("utf-8", "utf-16-le")),
]


def enc_count(data, needle):
    n = 0
    for enc in TARGETS_ENCODINGS:
        n += data.count(needle.encode(enc))
    return n


def patch_file(rel, encodings, reverse):
    path = os.path.join(WORK, rel)
    if not os.path.exists(path):
        return None
    bak = path + BAK
    if reverse:
        if not os.path.exists(bak):
            return "no-backup"
        shutil.copy2(bak, path)
        return "reverted"
    if os.path.exists(bak):
        return "already-patched"
    data = open(path, "rb").read()
    src = NEW if reverse else OLD
    dst = OLD if reverse else NEW
    total = 0
    for enc in encodings:
        a = src.encode(enc)
        b = dst.encode(enc)
        total += data.count(a)
        data = data.replace(a, b)
    if total == 0:
        return "no-occurrence"
    shutil.copy2(path, bak)
    open(path, "wb").write(data)
    return "patched:%d" % total


def check():
    for rel, encs in TARGETS:
        path = os.path.join(WORK, rel)
        if not os.path.exists(path):
            print("%-24s MISSING" % rel)
            continue
        d = open(path, "rb").read()
        o = sum(d.count(OLD.encode(e)) for e in encs)
        n = sum(d.count(NEW.encode(e)) for e in encs)
        print("%-24s old=%d new=%d bak=%s" % (rel, o, n, os.path.exists(path + BAK)))


def main():
    args = sys.argv[1:]
    if "--check" in args:
        check()
        return
    if "--revert" in args:
        for rel, encs in TARGETS:
            print("%-24s %s" % (rel, patch_file(rel, encs, True)))
        check()
        return
    print("包名 %s -> %s（各 %d 字符）" % (OLD, NEW, len(OLD)))
    ok = True
    for rel, encs in TARGETS:
        r = patch_file(rel, encs, False)
        print("%-24s %s" % (rel, r))
        if r in (None, "no-occurrence"):
            ok = False
    print()
    check()
    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
