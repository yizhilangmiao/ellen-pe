# -*- coding: utf-8 -*-
"""给产出版\\版本记录.txt 追加 b13 段（只 append，不改旧内容）。"""
import io
import sys

sys.stdout.reconfigure(encoding="utf-8")

P = r"E:\ailian\艾莲手机版\产出版\版本记录.txt"

ADD = """
2026-10-29 21:45  b13 —— 记忆优化 + b12 适配合并版（走创作版 work 流水线）
============================================================
  艾莲-0.1.20-b13-mem.apk        601,098,912 B
    sha256 a42e94ed37e6bf56986d28f6cc5497634ea5c01b2bf304370e7c78e845ee0006
  艾莲-0.1.20-b13-mem-测试.apk    51,420,012 B
    sha256 e01d94590660bce35907bf3c2f08d8eb798309612ffacf1df97a8350214c1f9e

  内容 = 手机创作版 work 的全部记忆优化补丁（_patch_phone_memory.py 1~4）
       + b12 的全套 Chrome 83 适配（语法降级 / polyfill 7 项 / randomUUID / dvh→vh /
         布局硬覆盖 / 静态内联样式 / 诊断面板 + 自动重载 / STARTUP-CATCH 埋点）
       + 免激活（required()=0，由基准包自带）+ 关更新（stable/closed.json，基准包自带）
       + 未实名气泡提示

  构建指纹：build=0.1.20-b13-mem (2026-10-29T22:40)

  与 b12 的区别：
    b12 = 0.1.20 官方前端 + 适配（没有记忆补丁）
    b13 = 0.1.20 官方前端 + 记忆补丁 + 适配
    两个包 dex / arsc / lib / 模型 完全相同，只有 assets/public 下的前端文件不同。

  做法（创作版 work 就地改造，不重建目录）：
    python _apply_b12.py      # 备份 → prep → 降级 → polyfill → uuid → diagnose → 写回
    python _dev_pack.py       # 按 manifest 回包（529 条目：同 505 / 改 24 / 缺 0）
    pwsh  _dev_sign.ps1       # 签完整版
    python _slim_b13.py       # 剔除模型/so/音乐/语音素材 → 49 MB
    java -jar 工具\\apk工具链\\uber-apk-signer.jar -a 艾莲-0.1.20-b13-mem-slim.apk

  _apply_b12.py 的一次性坑：
    - 备份在 _backup_mem\\，重跑前先 rmtree + copytree 恢复，否则会对已降级的代码再降一次
    - _diagnose.py 的 BUILD_TAG 是模块级 `DIAG = DIAG.replace("__BUILD__", BUILD_TAG)`，
      import 时就已替换，之后改 BUILD_TAG 无效 → 脚本里再做一次字符串替换
    - esbuild 把中文转成 \\uXXXX（大写十六进制），所以 grep 中文明文会是 0，那是正常的
      （能看到 \\u5171\\u540C\\u7ECF\\u5386 就说明串在）

  验证要点：
    index.html 136,087 B / charset@57 / ellen-diag=1 / ellen-static-css=1 / __wt=4 / BUILD_TAG=1
    main      ??==0 ||==0 &&==0  uuid=1 polyfill=1  recoverInterrupted=2
    persona   ??==0 ((_a) =>=0  uuid=1
    service   ??==0 uuid=1  anchorAt=29
    worker    ??==0 uuid=1  anchorAt=14
    瘦身版：local-asr 不在、lib/ 不在、488 条目 / 63.0 MB 未压缩

  取舍（测试版）：聊天/记忆/设置/授权/界面/诊断正常；
    本地语音识别、通话本地识别、语义检索、背景音乐不可用。
"""

with io.open(P, "a", encoding="utf-8") as f:
    f.write(ADD)
print("[OK] 追加 b13 段，现", len(io.open(P, encoding="utf-8").read()), "字符")
