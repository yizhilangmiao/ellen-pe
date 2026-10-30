# -*- coding: utf-8 -*-
"""空跑自检：基准 APK  vs  work/ 解包回包 的逐条比对。

用法:
    python _dev_selftest.py                          # work/ 原样回包后与基准比
    python _dev_selftest.py --apk A.apk --other B.apk  # 比两个包

期望结果：所有非签名条目 name/size/crc/sha256 完全一致。
"""
import argparse
import hashlib
import os
import sys
import zipfile

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_BASE = r"E:\ailian\艾莲手机版\产出版\艾莲-0.1.20-免激活.apk"
DEFAULT_OTHER = os.path.join(HERE, "_build", "艾莲-0.1.20-免激活-dev-unsigned.apk")


def digest(z, name):
    return hashlib.sha256(z.read(name)).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apk", default=DEFAULT_BASE)
    ap.add_argument("--other", default=DEFAULT_OTHER)
    args = ap.parse_args()
    for p in (args.apk, args.other):
        if not os.path.isfile(p):
            sys.exit("缺文件: " + p)

    a, b = zipfile.ZipFile(args.apk), zipfile.ZipFile(args.other)
    na = [n for n in a.namelist() if not n.startswith("META-INF/")]
    nb = [n for n in b.namelist() if not n.startswith("META-INF/")]
    sa, sb = set(na), set(nb)

    print("基准:", os.path.basename(args.apk), len(na), "条")
    print("回包:", os.path.basename(args.other), len(nb), "条")
    print("顺序一致:", na == nb)

    only_a, only_b = sorted(sa - sb), sorted(sb - sa)
    for n in only_a:
        print("  [仅基准有] " + n)
    for n in only_b:
        print("  [仅回包有] " + n)

    diff, same = [], 0
    for n in sorted(sa & sb):
        ia, ib = a.getinfo(n), b.getinfo(n)
        if ia.file_size != ib.file_size or ia.CRC != ib.CRC or digest(a, n) != digest(b, n):
            diff.append(n)
        else:
            same += 1
    for n in diff:
        print("  [内容不同] " + n)

    ok = not only_a and not only_b and not diff
    print()
    print("一致条目: %d / 差异: %d" % (same, len(diff)))
    print("结论:", "PASS —— 解包/回包无损" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
