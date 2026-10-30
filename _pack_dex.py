# -*- coding: utf-8 -*-
"""
把重新汇编的 classes.dex 打进 APK：逐条复制原 zip，只替换 classes.dex。
保持每条 ZipInfo 的 compress_type / external_attr / create_system / date_time，
流式写入避免 573MB 全量进内存。
"""
import os
import sys
import zipfile
import shutil
import datetime

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
# BASE = 刚由 _pack.py 打出来的 web 版（已含 index.html/polyfill/日志面板），
# 这里只负责把重新汇编的 classes.dex 换进去。必须按这个顺序，否则 dex 会被覆盖回基准包。
BASE = os.path.join(HERE, "_build", "艾莲-0.1.8-免激活-关更新-降级.apk")
DEX = os.path.join(HERE, "dexwork", "classes-new.dex")
OUTDIR = os.path.join(HERE, "_build")
DST = os.path.join(OUTDIR, "艾莲-0.1.8-免激活-关更新-降级-full.apk")


def main():
    os.makedirs(OUTDIR, exist_ok=True)
    if not os.path.exists(DEX):
        print("缺 dex:", DEX)
        return 1
    print("基准包:", BASE, os.path.getsize(BASE))
    print("新 dex :", DEX, os.path.getsize(DEX))

    zin = zipfile.ZipFile(BASE, "r")
    zout = zipfile.ZipFile(DST, "w", zipfile.ZIP_DEFLATED)
    replaced = 0
    total = 0
    try:
        for zi in zin.infolist():
            total += 1
            if zi.filename == "classes.dex":
                ni = zipfile.ZipInfo(zi.filename, date_time=zi.date_time)
                ni.compress_type = zi.compress_type
                ni.external_attr = zi.external_attr
                ni.create_system = zi.create_system
                with open(DEX, "rb") as f, zout.open(ni, "w") as w:
                    shutil.copyfileobj(f, w)
                replaced += 1
                continue
            ni = zipfile.ZipInfo(zi.filename, date_time=zi.date_time)
            ni.compress_type = zi.compress_type
            ni.external_attr = zi.external_attr
            ni.create_system = zi.create_system
            if zi.is_dir():
                zout.writestr(ni, b"")
                continue
            with zin.open(zi, "r") as r, zout.open(ni, "w") as w:
                shutil.copyfileobj(r, w, 1 << 20)
    finally:
        zin.close()
        zout.close()

    print("条目 %d，替换 classes.dex %d 次" % (total, replaced))
    print("written:", DST, os.path.getsize(DST))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
