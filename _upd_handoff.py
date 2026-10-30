# -*- coding: utf-8 -*-
"""写 b13 交接 + 登记（reg.ps1 由 bash 调）。"""
import io
import sys

sys.stdout.reconfigure(encoding="utf-8")

H = r"E:\ailian\.agents\memory\handoff.md"

T = """

================================================================
2026-10-29 21:47  手机版 b13：记忆优化 + b12 适配合并（走创作版 work 流水线）
================================================================
【进度】
- 用户要求「把 b12 适配包更新到手机创作版，跟之前推进的手机版记忆优化合并」。
- 查清了两条线是分开的：
    · 手机创作版 work\\  = 0.1.20 官方 + 记忆补丁 1~4（_patch_phone_memory*.py，18:27~18:54）
    · _临时\\v120build\\   = 0.1.20 官方 + b12 适配（无记忆补丁）
- 新增 _apply_b12.py：在 work\\assets\\public\\ 上就地改造（先备份 _backup_mem\\），
  跑 prep(SOURCE_FIXES/dvh→vh/fix_layout/埋点/内联样式/气泡) → esbuild 降级 →
  polyfill → uuid → diagnose，最后写回 work。不改目录结构，manifest 仍然有效。
- 新增 _slim_b13.py（剔除模型/so/音乐/语音 → 49 MB）与 _upd_record.py（追加版本记录）。
- 交付：产出版\\艾莲-0.1.20-b13-mem.apk 601,098,912 B
          sha256 a42e94ed37e6bf56986d28f6cc5497634ea5c01b2bf304370e7c78e845ee0006
        产出版\\艾莲-0.1.20-b13-mem-测试.apk 51,420,012 B
          sha256 e01d94590660bce35907bf3c2f08d8eb798309612ffacf1df97a8350214c1f9e
- 校验：index 136,087 charset@57 diag=1 static=1 __wt=4 BUILD_TAG=1；
  main/persona/service/worker 的 ??=/||=/&&= 全 0，uuid=1 polyfill=1；
  persona ((_a)=> = 0；记忆补丁特征 recoverInterrupted/anchorAt 计数与降级前一致。

【下一步】
- 让用户装 产出版\\艾莲-0.1.20-b13-mem-测试.apk（49 MB）验：能不能打开、界面是否满屏、
  记忆相关 UI（共同经历分组 / 召回）是否正常。
- 确认无误后发完整版。

【卡点】
- 无

【教训】
- _apply_b12.py 重跑前必须先从 _backup_mem 恢复，否则对已降级代码二次降级。
- _diagnose.py 的 BUILD_TAG 在模块级就替换掉了，import 后改常量无效，要再做一次字符串替换。
- esbuild 把中文转成大写 \\uXXXX，grep 中文明文得到 0 是正常的。
- 产出版现在堆了 15 个 apk（b6~b13），需要按「只留最近两个」清理一次。
"""

with io.open(H, "a", encoding="utf-8") as f:
    f.write(T)
print("[OK] handoff 追加", len(T), "字符")
