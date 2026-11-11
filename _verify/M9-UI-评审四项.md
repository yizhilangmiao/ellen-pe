# M9 · 评审四项（顶栏 ⋯ / 回忆页签 / 报错系统条 / 横屏）

来源：`_verify\M9-UI-绝区零.md` 里空上下文评审给 4–5 分，扣分四处全在 DOM/文案层。
本轮把这四处逐条处理；其中第四处（横屏）结论是「真机不存在」，只留说明不做实现。

## 一、顶栏五个工具收进「⋯」

- `ui\icons.js` 加 `more`；`main.js` 的 `buildShell` 只保留一个 `.el-header-tool.is-more`，
  原五个按钮变成 `.el-header-menu-item`（图标 + 中文标签）装进 `.el-header-menu`。
- 交互：点「⋯」切换、点条目后自动收起、点外部（`document pointerdown`）收起、`Escape` 收起；
  `aria-expanded` 跟着变。
- 样式：`styles\zz-frame.css` 的 `.el-header-menu` 是绝对定位弹层（`top:46u; right:8u; z-index:40`）。
- 实测：`rect [227,39,126,155]`，条目 `["更换背景","切换深色外观","聊天历史","状态与提醒","设置"]`。
- 截图：`_verify\shot-ui2-menu.png`。

## 二、回忆页两排页签合并成一行

- 原因：`.el-segments` 是 `display:grid; grid-template-columns:repeat(3,1fr)`（`ui\views\memory\memory.css:23`），
  只写 `flex-wrap:nowrap` 不生效——**grid 下没有折行这回事**。
- 改法：`memory.js` 删掉「三段页签 + 三胶囊」两排结构，单排五个页签（`data-memory-tab`），
  同时保留 `data-memory-page` / `data-recall-group` 兼容旧选择器；
  `memory-calendar.css` 里覆盖成 `display:flex; grid-template-columns:none; flex-wrap:nowrap; overflow-x:auto`。
- 实测：`oneRow:true`（五个 `y` 全 = 136）、`scrollW == clientW == 292`（刚好放下，不折行）、
  标签 `["我们的回忆","她的过去","共同经历","星图","我眼里的你"]`。
- 页签配色（实测）：选中 `rgb(214,242,74)`（荧光）+ 深底 `rgb(27,31,34)`，未选中 `rgb(140,144,150)`。
- 截图：`_verify\shot-ui2-memory.png`。

## 三、报错进系统条（不再糊在气泡里）

- `ui\views\chat\chat.js`：删掉气泡内 `.el-msg-detail`（`renderMessage` / `patchLast` 两处），
  新增 `button.el-system-strip`（点一下 = 「知道了」），挂在 `stream` 与 `composer` 之间；
  `paintSystemStrip()` **只看最后两条消息**，历史旧失败不会每次开 App 都挂一条。
- `core\chat\session.js` 的 `explainFailure`：`400` 不再回「服务端拒绝了这次请求：<英文原文 160 字>」，
  改成「这次请求被服务端退了。多半是模型名不对——回设置里挑一个平台推荐的模型再试。」；
  有 message 但没命中分支时改成「服务端说这次请求不行，具体原因在下面那行。」
- 两个坑：
  1. `color-mix(in srgb, var(--z-signal) 12%, transparent)` 在 `--z-signal` 取不到的层会整条失效 → 条变全透明（实测 `rgba(0,0,0,0)`）。改成实色 `#2b2229` + 左 3u 荧光竖条。
  2. **条被气泡盖住**：`.el-chat-stream` 有 `z-index:1`，气泡会溢出自己的盒子画到底下 → 系统条必须 `position:relative; z-index:3`，否则「明明有 DOM、截图里看不见」。
- 实测（模型名改成 `nope-model-xxx` 造真 400）：气泡 = 那句人话、`detailInBubble:0`、
  条文案 `HTTP 400 · invalid_request_error · DeepSeek`、`bg rgb(43,34,41)`、左边 `rgb(214,255,92)`、
  `elementsFromPoint` 栈顶即系统条、条在输入框正上方（CSS y 456 / 高 26）。
- 恢复：把 vault 里 `model` 写回 `deepseek-chat` 并重启，发一句实测回「修好了。刚才那两次是模型名没对上，不怪你。」，条自动收起（`stripHidden:true`）。
- 截图：`_verify\shot-ui2-strip.png`（条可见那张）。

## 四、横屏设置页：不做（结论：真机不存在这个场景）

- `AndroidManifest.xml` 里 `MainActivity` 是 `android:screenOrientation="portrait"`，真机不会横屏；
  唯一能造出横屏的是 CDP `Emulation.setDeviceMetricsOverride`。
- 试过两种做法都不成立：`column-count:2` 挂在 flex 页面上无效（多列流只对块容器生效）；
  把卡片包进 `.el-settings-flow` 后再两栏，卡片被挤到 330px，字直接被切（截图 `shot-ui2-settings-land.png` 可见）。
- 最终决定：不写横屏特殊版式，只在 `ui\views\settings\settings.css` 末尾留注释说明原因。
  `.el-settings-flow` 包装保留——它是块容器，将来真要两栏是它的挂点。

## 五、本轮顺带修掉的

- 模型配置页走向导后，`settings.js` 末尾新增 `.el-settings-flow` 包装（见上），
  顺带让「卡片之间 10u 间距」在多列场景下也成立。
- 模拟器上被压测写坏的模型配置（`nope-model-xxx`）已改回 `deepseek-chat`。

## 六、还没做

- 回忆页五个页签在窄屏（320 CSS）会不会横向滚动——本轮只在 360 宽验过 `scrollW == clientW`。
- 系统条只展示 `status/code`，没有「点我重发」的动作。
- 顶栏菜单没有进屏动画（批 4 的节拍里没有给它排）。
