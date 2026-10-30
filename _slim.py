# -*- coding: utf-8 -*-
"""从完整降级包里剔除诊断用不到的大块，生成一个小的启动诊断包。

剔除原则：只删「启动流程用不到」的东西，保留能真实复现启动失败的全部逻辑。
  - 本地模型（ASR / VAD / 嵌入模型）—— 只在真正用语音时才加载
  - 音频素材（背景乐、TTS 参考音）—— 启动不读
  - x86 / x86_64 原生库 —— 真机是 arm64，模拟器才用
  - 前端图片与 wasm 运行时 —— 启动页不引用，JS 逻辑不需要

保留：classes*.dex、resources.arsc、AndroidManifest.xml、res/、
      lib/arm64-v8a、lib/armeabi-v7a、assets/public 下全部 js/css/html/字体、
      assets/mini、assets/capacitor.*
"""
import fnmatch
import os
import sys
import zipfile

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.join(HERE, "..", "产出版", "艾莲-0.1.8-免激活-关更新-降级.apk")
DST = os.path.join(HERE, "_build", "艾莲-0.1.8-启动诊断.apk")

os.makedirs(os.path.dirname(DST), exist_ok=True)

# 目录级剔除
DROP_DIRS = [
    "assets/local-asr/",
    "assets/local-call-asr/",
    "assets/local-vad/",
    "assets/voice-clone/",
    "assets/music/",
    "assets/public/local-embeddings/",
    "assets/public/semantic-runtime/",
    "lib/x86/",
    "lib/x86_64/",
    "lib/armeabi-v7a/",   # 32 位兼容库，天玑700 等 arm64 机型用不到
    "assets/mini/",       # 桌面挂件贴图，启动不引用
]

# 文件级剔除（在 assets/public/assets/ 下）
DROP_GLOBS = [
    "assets/public/assets/*.png",
    "assets/public/assets/*.webp",
    "assets/public/assets/*.jpg",
    "assets/public/assets/*.wasm",
    "assets/public/assets/*.mp3",
    "assets/public/assets/*.ogg",
]


def dropped(name):
    for d in DROP_DIRS:
        if name.startswith(d):
            return True
    for g in DROP_GLOBS:
        if fnmatch.fnmatch(name, g):
            return True
    return False


print("源包:", BASE, os.path.getsize(BASE), "bytes")
zin = zipfile.ZipFile(BASE)

keep, drop = [], []
for zi in zin.infolist():
    if zi.is_dir():
        continue
    (drop if dropped(zi.filename) else keep).append(zi)

raw_keep = sum(z.file_size for z in keep)
raw_drop = sum(z.file_size for z in drop)
print("保留 %d 项 / %.1f MB" % (len(keep), raw_keep / 1048576))
print("剔除 %d 项 / %.1f MB" % (len(drop), raw_drop / 1048576))

# 打印剔除的大项，便于核对
by_dir = {}
for z in drop:
    parts = z.filename.split("/")
    key = "/".join(parts[:3]) if parts[0] == "assets" else "/".join(parts[:2])
    by_dir[key] = by_dir.get(key, 0) + z.file_size
print()
print("=== 剔除明细（>1MB）===")
for k, v in sorted(by_dir.items(), key=lambda kv: -kv[1]):
    if v >= 1048576:
        print("  %-60s %7.1f MB" % (k, v / 1048576))

if os.path.exists(DST):
    os.remove(DST)

with zipfile.ZipFile(DST, "w") as zout:
    for zi in keep:
        data = zin.read(zi.filename)
        ni = zipfile.ZipInfo(zi.filename, zi.date_time)
        ni.compress_type = zi.compress_type
        ni.external_attr = zi.external_attr
        ni.create_system = zi.create_system
        ni.internal_attr = zi.internal_attr
        zout.writestr(ni, data)
zin.close()

size = os.path.getsize(DST)
print()
print("输出:", DST)
print("大小: %d bytes (%.1f MB)" % (size, size / 1048576))
