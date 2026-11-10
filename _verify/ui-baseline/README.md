# 旧包 UI 基线（复刻依据）

设备：MuMu 实例 1（Android 15，1080×2400 物理 / **432×936 CSS**，dpr 2.5）。
应用：`cn.ellen.companion` 0.1.23 b17（旧包，与新包并存）。
截图日期：2026-11-03。

## 一、截图清单

| 文件 | 页面 | 怎么到 |
|---|---|---|
| `01-home.png` | 聊天首页（暗色，未配模型状态） | 启动即到 |
| `11-chat-clean.png` | 同上，干净版（关掉「信匣/相识」浮层后） | 点 `button.elbs-x` |
| `02-settings.png` | 设置页（暗紫主题） | 底栏「设置」 |
| `02-settings-light.png` | 设置页（浅色主题） | 顶栏「外观」先切主题 |
| `03-companion.png` | 相处页（WITH YOU / 艾莲的此刻 / 便签 / 我们之间 / 相处天数） | 底栏「相处」 |
| `04-memory.png` | 回忆页 · 我们的回忆（手记日历） | 底栏「回忆」 |
| `06-appearance.png` | 回忆页的浅色主题 | 顶栏「外观」（**主题开关，不是页面**） |
| `08-memory-tab.png` | 回忆页 · 记忆（她的过去 / 共同经历 / 星图 + 记忆卡片） | `button.el-segment[data-memory-page="memories"]` |
| `09-eyes-tab.png` | 回忆页 · 我眼里的你 | `button.el-segment[data-memory-page="understanding"]` |
| `05-history.png` | 聊天历史（全屏页：开始新聊天 / 搜索 / 和艾莲·恋人 / 语音通话记录） | 顶栏「历史」 |
| `07-notify.png` | 状态与提醒（空态「暂时没有需要处理的提醒。」） | 顶栏「通知」 |
| `10-model-config.png` | 聊天模型配置（三步小白引导：把 key 粘进来 / 选平台并存下 …） | 设置页 `text:聊天模型` |
| `12-chat-prefs.png` | 聊天偏好 | 设置页 `text:聊天偏好` |

## 二、交互坐标与选择器（**优先用 CDP 选择器，别用 adb tap**）

底栏是 `button.el-nav-item`（当前页带 `.is-active`），顺序：聊天 / 回忆 / 相处 / 设置。
设置条目是 `button.el-settings-entry.el-settings-nav-entry`。
浮层关闭键是 `button.elbs-x`；浮层容器 `.elbs-layer` / `.elbs-reader` / `.elbs-toast` / `.elbs-quit` / `.elbs-alert`。
顶栏工具都是 `button.el-round.icon-only.el-header-tool`，另有 `button.el-chat-palette`（外观）。

非要用 adb tap 时（1080×2400 物理坐标）：
- 底栏 y 必须取 **2260**（2235 落在图标与文字间的空隙，点了不响应）：聊天 x=165 · 回忆 x=420 · 相处 x=682 · 设置 x=995
- 顶栏：外观 x=650 · 历史 x=770 · 通知 x=882 · 设置 x=995（y=110）
- 全屏页关闭：x=82 y=132

## 三、版式与令牌

- 根容器 `<main id="app" class="ellen-ui-root">`，尺寸 **432×936 CSS**（= 真机 864 物理 / dpr 2，与 `_phone-sync\UI规范-相对单位.md` 的基准屏一致）。
- 字体族 `EllenKuaiLe, "Microsoft YaHei", sans-serif`（自定义字族，字重全靠它）。
- 全部颜色/尺寸令牌见 `contract\ui-tokens.md`（35 张样式表、3101 条规则、`--el-*` 变量实测值）。
- 页面骨架（**新 web 的组件命名契约**）：
  - `section.el-page.el-chat-page`（聊天）/ `section.el-page.el-scroll-page`（滚动页）/
    `section.el-page.el-scroll-page.el-companion-home.el-current-home`（相处）/
    `section.el-page.el-scroll-page.el-settings-context`（设置）
  - `h1.el-page-title`（26px / lh 37.7 / ls .78）、`p.el-page-subtitle`（12px / lh 22.8）
  - `button.el-segment` + `.is-active`（13px，选中底 `rgb(81,71,84)`）
  - 手记：`article.el-journal-preview`、`button.el-journal-day[data-day][data-status]`、
    `button.el-journal-month-arrow[data-journal-control=previous|next]`、`button.el-journal-latest`
  - 按钮：`button.el-primary`（14px）、`button.el-secondary`（13px）
  - 聊天：`button.el-chat-model-chip`、`button.el-chat-thinking-chip`、`button.el-stop`、
    `button.el-back-latest`、`button.el-hint-action`、`div.el-understanding-task-entry`
  - 记忆胶囊：`button.el-recall-group[data-recall-group=past|shared]`、`button.el-entry`
  - 浮钮：`button.elbs-fab`（46×46、`rgba(28,32,38,.92)`、描边 `rgba(214,160,180,.5)` ← 老 bug 清单里的 `#d6a0b4` 就是这条描边）

## 四、取页面/样式的正确姿势（CDP）

```powershell
$adb='E:\ailian\工具\android-sdk\platform-tools\adb.exe'
$pid1 = (& $adb -s 127.0.0.1:16416 shell pidof cn.ellen.companion).Trim()
& $adb -s 127.0.0.1:16416 forward tcp:9555 localabstract:webview_devtools_remote_$pid1
cd 'E:\ailian\艾莲手机版\创作版'
$node='E:\ailian\工具\node\node-v24.21.0-win-x64\node.exe'
& $node _tools\cdp_eval.js eval 9555 '_临时\dom-probe.js'        # DOM/类名/可点元素清单
& $node _tools\cdp_eval.js eval 9555 '_临时\style-probe.js' > '_临时\style-probe.out.json'
& $node _tools\tokens_to_md.js '_临时\style-probe.out.json'        # → contract\ui-tokens.md
& $node _tools\cdp_click.js 9555 'text:回忆'                       # 文本点击
& $node _tools\cdp_click.js 9555 'button.el-segment[data-memory-page="memories"]'
```

**要点**：旧包是单页 SPA，**所有页面同时存在于 DOM**（靠 `display` + 类切换显隐），所以按选择器 `.click()` 精确切页比 adb tap 可靠；adb tap 落空时连拍的几张会是同一页，别拿它当「没这个页面」的证据。
