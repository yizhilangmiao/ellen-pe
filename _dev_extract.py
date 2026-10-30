# -*- coding: utf-8 -*-
"""开发版解包：把基准 APK 全量解到 work/，并记录每个条目的 ZipInfo，
供 _dev_pack.py 原样回包（顺序/压缩方式/时间戳都可还原，便于空跑比对）。

用法:
    python _dev_extract.py                 # 用下面 BASE 默认包
    python _dev_extract.py --apk X.apk     # 换基准包
    python _dev_extract.py --clean         # 先清空 work/
"""
import argparse
import hashlib
import json
import os
import shutil
import sys
import zipfile

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_APK = r"E:\ailian\艾莲手机版\产出版\艾莲-0.1.20-免激活.apk"
WORK = os.path.join(HERE, "work")
MANIFEST = os.path.join(WORK, ".zextract-manifest.json")
SKIP_PREFIX = ("META-INF/",)  # 签名块不入库，回包时重新签


def sha256(b):
    return hashlib.sha256(b).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apk", default=DEFAULT_APK)
    ap.add_argument("--out", default=WORK)
    ap.add_argument("--clean", action="store_true")
    args = ap.parse_args()

    if not os.path.isfile(args.apk):
        sys.exit("找不到基准包: " + args.apk)
    if args.clean and os.path.isdir(args.out):
        shutil.rmtree(args.out)
    os.makedirs(args.out, exist_ok=True)

    z = zipfile.ZipFile(args.apk)
    entries = []
    total = 0
    used = set()  # Windows 不区分大小写：同名不同大小写的条目必须分开落盘
    for info in z.infolist():
        name = info.filename
        if name.endswith("/"):
            continue
        skipped = name.startswith(SKIP_PREFIX)
        data = z.read(name)
        low = name.lower()
        path = name
        n = 0
        while low in used:
            n += 1
            path = "_dup%d/%s" % (n, name)
            low = path.lower()
        used.add(low)
        rec = {
            "name": name,
            "path": path,
            "size": info.file_size,
            "compress": info.compress_type,
            "crc": info.CRC,
            "date_time": list(info.date_time),
            "external_attr": info.external_attr,
            "sha256": sha256(data),
            "skipped": skipped,
        }
        entries.append(rec)
        if skipped:
            continue
        dst = os.path.join(args.out, path.replace("/", os.sep))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, "wb") as f:
            f.write(data)
        total += len(data)

    meta = {
        "source_apk": os.path.abspath(args.apk),
        "source_size": os.path.getsize(args.apk),
        "source_sha256": sha256(open(args.apk, "rb").read()),
        "entry_count": len(entries),
        "extracted_bytes": total,
        "zip_comment": z.comment.decode("utf-8", "replace"),
        "entries": entries,
    }
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)

    print("基准包 :", os.path.basename(args.apk), meta["source_size"], "bytes")
    print("条目   :", len(entries), "（签名块跳过 %d）" % sum(1 for e in entries if e["skipped"]))
    print("解出   :", total, "bytes ->", args.out)
    for key in ["classes.dex", "classes2.dex", "resources.arsc", "AndroidManifest.xml"]:
        hit = [e for e in entries if e["name"] == key]
        print("  %-22s %s" % (key, hit[0]["size"] if hit else "MISSING"))
    js = [e for e in entries if e["name"].startswith("assets/public/assets/") and e["name"].endswith(".js")]
    print("  前端 js            %d 个" % len(js))


if __name__ == "__main__":
    main()
