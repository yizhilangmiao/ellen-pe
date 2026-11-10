# -*- coding: utf-8 -*-
"""手机版优化：资料文件导出写循环的吞吐（大文件导出等待太久）。

真机实测（vivo V2162A / Android 14 / WebView 101，2026-11-01）：
    导出「聊天资料」3,910,594 B 媒体：点击 -> 「正在写入」1.31 s，
    -> 「请选择保存位置」5.51 s，即写循环 4.20 s（约 1.08 s/MB，块 64 KiB 约 70 ms/块）。
    base64 微基准：64 KiB 全验证只 1.39 ms —— JS 侧 atob/btoa 不是瓶颈。
    Capacitor 空桥调用 0.10~0.16 ms —— 桥本身不是瓶颈。
    256 KiB 块实测失败：进度停在「已处理 0 / 3,910,594 字节 · 文件 0/16」，
    报「资料文件未完整通过检查」，说明 native readChunk 不接受 256 KiB。
    => 60~70 ms/块 的开销在 native 侧（读写 + 可能的 fsync），JS 只能靠重叠掩盖。

三处改动（都在 main-CFFhpb4h.js）：

1. readChunk 深度 2 预取
   原循环是「读一块 -> 校验 -> 写一块」严格串行，两段 native 往返互相等待。
   改成先把下一块的 readChunk 发出去，再 await 当前块、写当前块，
   让读与写在不同 native 调用之间重叠。内存代价 1 个 64 KiB base64 串。

2. 去掉每块 base64 的二次编码校验
   原：`(n2.length !== t2 || btoa(n2) !== e2) && Gi('INVALID_MEDIA_CHUNK')`
   改：`(n2.length !== t2) && Gi('INVALID_MEDIA_CHUNK')`
   保留长度校验（能抓住截断/空白块），去掉 `btoa(atob(x)) === x` 回编比对。
   base64 由自家 native 插件编码，回编比对是自证，量级 1.4 ms/块。

3. 进度回调节流 120 ms
   原来每块一次 onProgress -> React setState。节流后仍保证最后一次
   （doneBytes >= totalBytes）必发，不会漏掉 100%。

用法:
    python _patch_phone_export_perf.py --check
    python _patch_phone_export_perf.py
    python _patch_phone_export_perf.py --revert
"""
import argparse
import os
import shutil
import sys

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(HERE, "work", "assets", "public", "assets", "main-CFFhpb4h.js")

MARK_PF = "/* ellen-export-prefetch */"
MARK_THROTTLE = "/* ellen-export-throttle */"

# --- 1. readChunk 深度 2 预取 ---
OLD_LOOP = (
    "    for (let i2 = 0; i2 < t3.sizeBytes; ) {\n"
    "      Hi(r2);\n"
    "      let o3 = Math.min(Ii, t3.sizeBytes - i2), c2 = await e2.readChunk({ id: t3.id, sha256: t3.sha256, offset: i2, length: o3 });\n"
    "      Hi(r2), Ji(c2 == null ? void 0 : c2.base64, o3);\n"
)
NEW_LOOP = (
    "    let __ellenPf = null; " + MARK_PF + "\n"
    "    for (let i2 = 0; i2 < t3.sizeBytes; ) {\n"
    "      let o3 = Math.min(Ii, t3.sizeBytes - i2),\n"
    "          __ellenP = __ellenPf || e2.readChunk({ id: t3.id, sha256: t3.sha256, offset: i2, length: o3 }),\n"
    "          __ellenKn = i2 + o3,\n"
    "          __ellenKl = Math.min(Ii, t3.sizeBytes - __ellenKn);\n"
    "      __ellenPf = __ellenKl > 0 ? e2.readChunk({ id: t3.id, sha256: t3.sha256, offset: __ellenKn, length: __ellenKl }) : null,\n"
    "      __ellenPf && __ellenPf.catch(function () { });\n"
    "      Hi(r2);\n"
    "      let c2 = await __ellenP;\n"
    "      Hi(r2), Ji(c2 == null ? void 0 : c2.base64, o3);\n"
)

# --- 2. base64 二次编码校验 ---
OLD_JI = "(n2.length !== t2 || btoa(n2) !== e2) && Gi(`INVALID_MEDIA_CHUNK`);"
NEW_JI = "(n2.length !== t2) && Gi(`INVALID_MEDIA_CHUNK`);"

# --- 3. 进度节流 ---
OLD_XI = (
    "function Xi(e2, t2) {\n"
    "  try {\n"
    "    e2 == null ? void 0 : e2({ ...t2 });\n"
    "  } catch (e3) {\n"
    "  }\n"
    "}"
)
NEW_XI = (
    "var __ellenXiAt = 0; " + MARK_THROTTLE + "\n"
    "function Xi(e2, t2) {\n"
    "  try {\n"
    "    if (e2 == null ? void 0 : e2) {\n"
    "      var __ellenXiNow = Date.now(),\n"
    "          __ellenXiDone = t2.doneBytes >= t2.totalBytes;\n"
    "      if (!__ellenXiDone && __ellenXiNow - __ellenXiAt < 120) return;\n"
    "      __ellenXiAt = __ellenXiNow;\n"
    "      e2({ ...t2 });\n"
    "    }\n"
    "  } catch (e3) {\n"
    "  }\n"
    "}"
)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--revert", action="store_true")
    args = ap.parse_args()

    with open(TARGET, encoding="utf-8", newline="") as f:
        text = f.read()

    n_pf = text.count(MARK_PF)
    n_thr = text.count(MARK_THROTTLE)
    patched = n_pf == 1 and n_thr == 1

    def save(new_text):
        shutil.copyfile(TARGET, TARGET + ".bak-exportperf")
        with open(TARGET, "w", encoding="utf-8", newline="") as f:
            f.write(new_text)

    if args.check:
        if patched:
            print("[applied] %s  (prefetch-2, no-btoa, throttle=120ms)"
                  % os.path.basename(TARGET))
        elif n_pf == 0 and n_thr == 0:
            c_loop, c_ji, c_xi = text.count(OLD_LOOP), text.count(OLD_JI), text.count(OLD_XI)
            ok = c_loop == 1 and c_ji == 1 and c_xi == 1
            print("[%s] %s  (原始锚点 loop=%d ji=%d xi=%d)"
                  % ("pending" if ok else "conflict", os.path.basename(TARGET),
                     c_loop, c_ji, c_xi))
            if not ok:
                sys.exit(2)
        else:
            print("[conflict] 半补丁态 pf_mark=%d throttle_mark=%d" % (n_pf, n_thr))
            sys.exit(2)
        return

    if args.revert:
        if not patched:
            print("[nothing-to-revert] %s" % os.path.basename(TARGET))
            return
        new = text.replace(NEW_LOOP, OLD_LOOP).replace(NEW_JI, OLD_JI).replace(NEW_XI, OLD_XI)
        save(new)
        print("[reverted] %s" % os.path.basename(TARGET))
        return

    if patched:
        print("[unchanged] %s" % os.path.basename(TARGET))
        return

    c_loop, c_ji, c_xi = text.count(OLD_LOOP), text.count(OLD_JI), text.count(OLD_XI)
    if not (c_loop == 1 and c_ji == 1 and c_xi == 1):
        print("[conflict] 原始锚点 loop=%d ji=%d xi=%d（要求都是 1），拒绝改动"
              % (c_loop, c_ji, c_xi))
        sys.exit(2)

    new = text.replace(OLD_LOOP, NEW_LOOP).replace(OLD_JI, NEW_JI).replace(OLD_XI, NEW_XI)

    # 自证：三处都变、且没多改别处
    assert new.count(MARK_PF) == 1
    assert new.count(MARK_THROTTLE) == 1
    assert new.count(OLD_LOOP) == 0
    assert new.count(OLD_JI) == 0
    assert new.count("btoa(n2)") == 0
    assert new.count(OLD_XI) == 0
    assert new.count("var Ii = 65536,") == 1   # 块大小保持 64 KiB（native 上限）

    save(new)
    print("[applied] %s  预取深度2 + 去 btoa 回编 + 进度节流 120ms"
          % os.path.basename(TARGET))


if __name__ == "__main__":
    main()
