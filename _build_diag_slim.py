# -*- coding: utf-8 -*-
"""
造一个「瘦身诊断版」APK：保留全部启动路径，砍掉跟启动无关的大块。

能砍的依据：启动卡在 storage 阶段（index.html → main-C8dMeyqt.js → storage-worker），
这之前完全不碰 ASR / TTS / 向量模型 / onnx 运行时 / 背景音乐 / 参考音。
砍掉之后界面能起来、能打到日志，只是语音与语义检索用不了——诊断不需要它们。

被砍的清单（768MB → 约 40MB）：
  assets/local-asr/                 228MB  本地 ASR 模型
  assets/local-call-asr/            158MB  通话 ASR 模型
  assets/public/local-embeddings/   129MB  句向量模型
  lib/                              122MB  onnxruntime + sherpa-onnx（全架构）
  assets/music/                      28MB  背景音乐
  assets/voice-clone/                18MB  TTS 参考音
  assets/public/semantic-runtime/    11MB  onnx wasm
  ort-wasm / ort.wasm.bundle         21MB  onnx wasm

用法：python _build_diag_slim.py
产物：_build/艾莲-0.1.8-诊断瘦身.apk（未签名，需再跑 uber-apk-signer）
"""
import os
import sys
import zipfile
import shutil
import datetime

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "产出版", "艾莲-0.1.8-免激活-关更新-降级.apk")
OUTDIR = os.path.join(HERE, "_build")
DST = os.path.join(OUTDIR, "艾莲-0.1.8-诊断瘦身.apk")

DROP_PREFIX = (
    "assets/local-asr/",
    "assets/local-call-asr/",
    "assets/public/local-embeddings/",
    "assets/music/",
    "assets/voice-clone/",
    "assets/public/semantic-runtime/",
    "lib/",
    "assets/public/assets/ort-wasm-simd-threaded",
    "assets/public/assets/ort.wasm.bundle.min",
)


def main():
    os.makedirs(OUTDIR, exist_ok=True)
    src = os.path.abspath(SRC)
    if not os.path.exists(src):
        print("源包不存在:", src)
        return 1

    zin = zipfile.ZipFile(src, "r")
    kept = dropped = 0
    kept_b = dropped_b = 0

    with zipfile.ZipFile(DST, "w", zipfile.ZIP_DEFLATED) as zout:
        for zi in zin.infolist():
            name = zi.filename
            if zi.is_dir():
                continue
            if any(name.startswith(p) for p in DROP_PREFIX):
                dropped += 1
                dropped_b += zi.file_size
                continue
            nzi = zipfile.ZipInfo(zi.filename, zi.date_time)
            nzi.compress_type = zi.compress_type
            nzi.external_attr = zi.external_attr
            nzi.create_system = zi.create_system
            with zin.open(zi, "r") as fsrc, zout.open(nzi, "w") as fdst:
                shutil.copyfileobj(fsrc, fdst, 1024 * 1024)
            kept += 1
            kept_b += zi.file_size

    zin.close()
    print("保留 %d 条 / %.1f MB" % (kept, kept_b / 1048576))
    print("砍掉 %d 条 / %.1f MB" % (dropped, dropped_b / 1048576))
    print("written:", DST, os.path.getsize(DST), "bytes (%.1f MB)" % (os.path.getsize(DST) / 1048576))
    return 0


if __name__ == "__main__":
    sys.exit(main())
