# -*- coding: utf-8 -*-
"""瘦身：从完整版剔除本地模型/原生库/音乐/语音素材，产出 49MB 级测试包。

用途：给客户快速验证「能不能打开、界面是否正常、记忆是否生效」，
代价是本地语音识别、通话本地识别、语义检索、背景音乐不可用。
"""
import os
import shutil
import sys
import zipfile

sys.stdout.reconfigure(encoding="utf-8")

SRC = r"E:\ailian\艾莲手机版\产出版\艾莲-0.1.20-b15-mem.apk"
DST = r"E:\ailian\艾莲手机版\创作版\_build\艾莲-0.1.20-b15-mem-slim.apk"

DROP_PREFIX = (
    "assets/local-asr/",
    "assets/local-call-asr/",
    "assets/public/local-embeddings/",
    "assets/public/semantic-runtime/",
    "assets/music/",
    "assets/voice-clone/",
    "lib/",
)
DROP_GLOB = (
    "assets/public/assets/ort-wasm-simd-threaded",
    "assets/public/assets/ort.wasm.bundle.min",
)


def main():
    zin = zipfile.ZipFile(SRC)
    kept = dropped = 0
    kept_bytes = dropped_bytes = 0
    big = []
    with zipfile.ZipFile(DST, "w", zipfile.ZIP_DEFLATED) as zout:
        for zi in zin.infolist():
            n = zi.filename
            drop = n.startswith(DROP_PREFIX) or any(n.startswith(g) for g in DROP_GLOB)
            if drop:
                dropped += 1
                dropped_bytes += zi.file_size
                if zi.file_size > 1 << 20:
                    big.append((n, zi.file_size))
                continue
            nz = zipfile.ZipInfo(n, date_time=zi.date_time)
            nz.compress_type = zi.compress_type
            nz.external_attr = zi.external_attr
            nz.create_system = zi.create_system
            nz.internal_attr = zi.internal_attr
            with zin.open(zi) as f, zout.open(nz, "w") as g:
                shutil.copyfileobj(f, g, 1 << 20)
            kept += 1
            kept_bytes += zi.file_size
    zin.close()
    print("保留 %d 条 / %.1f MB" % (kept, kept_bytes / 1048576))
    print("剔除 %d 条 / %.1f MB" % (dropped, dropped_bytes / 1048576))
    print("产出 %d bytes  %.1f MB" % (os.path.getsize(DST), os.path.getsize(DST) / 1048576))
    print()
    print("剔除的大件：")
    for n, s in sorted(big, key=lambda x: -x[1]):
        print("  %-62s %7.1f MB" % (n, s / 1048576))
    return 0


if __name__ == "__main__":
    sys.exit(main())
