# -*- coding: utf-8 -*-
"""瘦身升级版：把内存修复补丁打成 50MB 级「测试」包，便于快速验证与分发。

依据同目录 _slim_b13.py：剔除本地 ASR / 通话 ASR / 句向量模型 / onnx 运行时 /
背景音乐 / 语音参考音 / lib 原生库。这些跟「聊天 + 记忆整理」无关，
所以记忆修复在瘦身版里照样生效，只是语音识别、通话本地识别、语义检索不可用。

来源：_build/艾莲-0.1.23-免激活-dev-aligned-debugSigned.apk（已含 _patch_phone_memory6 的 P1~P7）
产物：_build/艾莲-0.1.23-b1-测试-unsigned.apk（未签名，接着跑) _dev_sign.ps1 -Apk 即可

用法：python _slim_mem.py
"""
import os
import shutil
import sys
import zipfile

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "_build", "艾莲-0.1.23-免激活-dev-aligned-debugSigned.apk")
DST = os.path.join(HERE, "_build", "艾莲-0.1.23-b1-测试-unsigned.apk")

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
    if not os.path.exists(SRC):
        print("缺来源包:", SRC)
        return 2
    if os.path.exists(DST):
        os.remove(DST)
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
    for n, s in sorted(big, key=lambda x: -x[1])[:8]:
        print("  - %-58s %7.1f MB" % (n, s / 1048576))
    return 0


if __name__ == "__main__":
    sys.exit(main())
