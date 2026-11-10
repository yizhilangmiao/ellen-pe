# 艾莲手机版 · 开发版（0.1.20 基线）

这个目录是**唯一**的安卓开发版工作区。以后所有手机端改动都改这里，再从这里的成品发到 `产出版\`。

基准包：`..\产出版\艾莲-0.1.20-免激活.apk`（600,742,223 B，571 条目）

## 目录

```
创作版\
├─ work\                    0.1.20 全量解包（assets / classes*.dex / resources.arsc / res / lib）
│  └─ .zextract-manifest.json   每个条目的原始 ZipInfo + sha256（回包靠它还原）
├─ _dev_extract.py          解包：APK -> work\（--clean 重来，--apk 换基准）
├─ _dev_pack.py             回包：work\ -> _build\*-dev-unsigned.apk（只重算改动条目）
├─ _dev_sign.ps1            签名：uber-apk-signer（v2/v3），-Publish 直接进产出版
├─ _dev_selftest.py         自检：基准包 vs 回包逐条 sha256 比对，期望 100% 一致
├─ _build\                  中间产物（未签 / 已签）
└─ （以下为 0.1.8 时期遗留，暂留未清）
   web\ web_out\ web_out.bak\ dexwork\ dexcheck\ package\ esbuild.tgz 及各 _*.py 旧脚本
```

## 流水线

```powershell
cd E:\ailian\艾莲手机版\创作版

# 1. 解包（只在换基准版本时跑一次）
python _dev_extract.py --clean

# 2. 改 work\ 里的文件（前端在 work\assets\public\，dex 用 _pack_dex 流程另说）

# 3. 回包
python _dev_pack.py                       # 只看改动：加 --report

# 4. 签名（默认签最新的 *-dev-unsigned.apk）
pwsh -File _dev_sign.ps1

# 5. 要发行才发布
pwsh -File _dev_sign.ps1 -Publish
```

## 改完必须做

- `python _dev_selftest.py` —— 应当 PASS（除签名块外逐条一致）。改过的文件会出现在 `[内容不同]` 里，那是预期；**其余条目一条都不许变**。
- 真机装一次。打包通过 ≠ 能跑。

## 已知坑

- **新增文件（2026-10-31 起已修）**：`_dev_pack.py` 会补扫 `work\assets\`、`work\res\` 下**未登记**的文件，回包时打印 `[NEW]` 行（`*.bak*`、`*.py`、`.`/`_` 开头的排除）。以前它只写 `.zextract-manifest.json` 里有的条目，新加的 js 会被**静默丢掉**，`index.html` 引用 404 却没有任何报错 —— `ellen-proactive.js` / `ellen-proactive-ui.js` 就是这么丢的。
- **大小写冲突**：APK 里有 10 组只差大小写的混淆资源名（`res/Bb.xml` vs `res/bb.xml`）。Windows 不区分大小写，所以重复条目落到 `work\_dup1\...`，回包时按 manifest 的 `path` 读、按 `name` 写。别手动改 `_dup` 里的路径。
- **签名块不入库**：`META-INF/` 42 个条目在解包时跳过，回包后由 uber-apk-signer 重新生成。
- **验收顺序**：解包时只有 `_dev_selftest.py` 报 PASS，才算工作区可信。

## 记忆补丁脚本（按顺序）

| 脚本 | 内容 | 锚点 |
|---|---|---|
| `_patch_phone_memory.py` | ①字面召回（Vl 加第三条路 + 门槛）②摘要 IIFE 注入（je 的 rules E） | 唯一 |
| `_patch_phone_memory2.py` | ③周期维护（je 入口 30 分钟节流调 T.recoverInterrupted）④关联召回（anchorAt ±15 分钟图路） | 唯一 |
| `_patch_phone_memory3.py` | 共同经历 UI 分组（main bundle，3 处 filter 去掉 `!f||` 限制） | 唯一 |
| `_patch_phone_memory4.py` | ⑤`await H(signal,{complete:!0})` 全量 view 预取 ⑥摘要改用全量 view（P6） | 唯一 |

坑：⑤ 插在 `let f=[...],p=...,m=p.view,h=null;` 这条 let 声明链中间会打断链，必须连同 `,h=null` 一起换掉或写成 `catch{};let h=null;`。

## 朗读补丁

| 脚本 | 内容 | 锚点 |
|---|---|---|
| `_patch_phone_readaloud.py` | 朗读文本剥括号动作（`persona-CBp1pExX.js` 的 `spoken`/`i2`） | 唯一（`function i2(e3)` 三行） |

**为什么需要**：`forSegment`（`r2`）要求 `display(sceneParts) === text` 严格相等。老消息没有 `sceneParts`、
流式中断的分段没有 `sceneParts`、或者两边差一个标点，`r2` 就返回 null，`spoken` 退回整条 `text`；
而入库的 `text` 本来就是 `display(sceneParts)`（动作段带着 `（…）`），于是 TTS 把动作念出来。
补丁在朗读取值处统一剥 `（）()【】[]**` 动作段，剥完没实词才退回原文（否则会掉进 `tr()` 的
`INVALID_SPEECH_TEXT`，用户看到"这条台词暂时无法合成"）。**只动朗读，不动 `r2` 与渲染路径**。

残留：整条只有动作、没有台词的消息，仍会念出动作内容（已去掉括号符号）。要彻底静默得改自动朗读的分派层。
