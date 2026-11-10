# M9 UI · 绝区零皮肤落地（批 1 / 2 / 2.5 / 5）

负责人：ui-zzz（teammate）
方案：《手机版UI重构方案-绝区零.md》，选了 01「纸片对撞」。
令牌层（批 0）由另一会话完成，本次**只消费 `--z-*`，不改令牌值**。

## 一 交付清单

| 文件 | 性质 | 行数 | 对应方案 |
|---|---|---|---|
| `app/web/src/app/styles/zz-frame.css` | 新建 | 267 | §三 骨架、§四 顶栏/底栏 |
| `app/web/src/app/styles/zz-parts.css` | 新建 | 437 | §四 器件、§4.0 收编 |
| `app/web/src/app/styles/zz-wall.css` | 新建 | 132 | §四·五 壁纸层 |
| `app/web/src/app/styles/base.css` | 改（删） | 198→~160 | §七 批 1：`.el-nav*` 旧规则整段删除，只留 4 行无皮肤兜底 |
| `app/web/src/app/main.js` | 改（2 处） | 588 | import 三个新 css；skin 默认开启 |
| `app/web/src/app/assets/wall-*.webp` | 新增 6 张 | — | §四·五（PIL 转 webp q80） |
| `ui/views/chat/chat.css` | 追加 zzz 段 | 342 | §六 chat=C 档 |
| `ui/views/settings/settings.css` | 追加 zzz 段 | 314 | §六 settings=B 档，去暗紫 |
| `ui/views/memory/memory.css` + `memory-calendar.css` | 追加 zzz 段 | 291 / 163 | §六 memory=B 档 |
| `ui/views/companion/companion.css` | 追加 zzz 段 | 356 | §六 companion=B 档 |
| `ui/views/journal/journal.css` | 追加 zzz 段 | 118 | §六 journal=B 档 |
| `ui/views/history/history.css`、`feedback/feedback.css` | 浅改（1px 线、去裸 px） | 121 / 95 | §六 history/feedback=C 档 |

未碰：任何 view 的 `*.js`、`ui/router.js`、`core/**`、`data-skin` 之外的 DOM 结构。

## 二 落地对照（方案哪一句 → 代码哪一行）

### 批 1 骨架（`zz-frame.css`）
- 顶栏 46u 硬底 + 1px `--z-line-hair` 底线 → `.el-chat-header`（`min-height: calc(46*var(--u) + var(--el-safe-top))`）。
- 品牌 20u 快乐体 + `LIVE` 荧光标签（signal 底、右下 `--z-cut-s` 缺角、9u 字）→ `.el-brand::after`。
- 中文状态「在线 · 深夜/傍晚/上午」→ `.el-header-tools::before{content:var(--z-status)}`，默认 `在线`；三档时段用 `[data-slot='morning'|'tram'|'night']` 预留（**CSS 算不出钟点，需要 JS 一行，见第七节**）。
- 工具钮 30u 方 / 6u 圆角 / 16u 图标 + 伪元素把命中区撑到 40u（评审 r1 必修项）。
- 底栏：58u 行高、`padding: 0 9u max(12u, env(safe-area-inset-bottom))`、`clip-path` 右下 `--z-cut-s` 缺角、顶部 1px 线、网点 4.5% 档。
- 选中态：深底 `#1b1f22` + 荧光字 + `inset 0 -3u 0 var(--z-signal)`。
- 未读：5u 荧光方点 + 3u 圆角 + 1.5u 背景色描边（`.has-unread .el-nav-icon::after`）。
- 横屏 `@media (orientation: landscape) and (min-width: 560px)`：app 转 `grid` 两列（88u 竖条 + 1fr），竖条 `grid-row: 1 / span 2`、四格 `repeat(4,1fr)`、右上 `--z-cut`(14u) 缺角；顶栏 / `.el-chat-stream` / `.el-composer` 用同一算式 `max(28u, (100% - 560u)/2)` 收列 → 三者同一条竖线（CDP 实测 brand.left = composer.left = 221，stream padding-left = 134.97px）。

### 批 2 器件（`zz-parts.css`）
- 气泡：她 `--z-paper-bub` + `18/18/18/6u` 圆角 + `--z-hard`(4u) + `--z-hard-edge`；我 `--z-self` + 1px `--z-self-line` + `18/18/6/18u` + `--z-hard-s`(3u)。
- **粉影只给最新一条我方消息**：`:last-child` + `:not(:has(~ .el-msg[data-role='user']))` 兜住「她已经回了、他的最后一句不在末位」。
- 32u 方片头像（快乐体「艾」、3u 圆角、`--z-hard-s`）；**连发第二条隐藏头像**（`+` 相邻选择器，不用 `.row.her` 那种不存在的类）。
- 时间戳分隔：左 2u 荧光竖条（`.el-msg-time`）。
- 输入条：margin `12u 16u 10u`、padding `10u 11u`、18u 圆角、`--z-panel` + 1px `--z-line-strong` + `--z-hard-t`；左 32u `＋` 方钮（9u 圆角）；右发送钮 34u + 右下 7u 缺角（骨架层铁律）+ `--z-hard-s`。
- 等待三点：3 根 4u×11u 荧光竖条，`steps(1)` 1400ms，`opacity` 1 → .34（壁纸底上 .18 会消失），**不铺气泡材质**。
- tile：`.el-history-card` 56u 高 / 12u 圆角 / `--z-hard-s`。
- 搜索框：`.el-history-search` 34u / 10u 圆角 / `--z-sunken` / **左 2u 荧光竖标代替放大镜**（设置页输入框刻意不画竖标：10u 圆角上会被切成半个括号，实拍否决）。
- 空态：网点 + 18u 快乐体一句话（只在 B 档区域）。
- 单一 gutter：消息区左右 16u、输入条外边距 16u、底栏 9u + tab 7u = 16u，全收在同一条竖线。

### 批 2.5 壁纸（`zz-wall.css`）
- 6 张 webp（竖 720×960 / 横 1100 宽），night / morning / tram 三档。
- `::before` 铺 `cover` + `50% 46%`（**不裁人**，整幅主体可见），`filter: brightness/saturate/contrast`；`::after` 上下压暗 + 底部 radial。
- `[data-slot]` 三档只换 `--wp` / 亮度 / 饱和 / `--wp-extra`，气泡随档改半透明度（night `#f3ecdde6` / tram `eB` / candy `f2`）。
- 顶层（顶栏）、底栏、抽屉、输入条一律不铺壁纸；`.el-chat-stream` 顶部 32u 渐隐（`-webkit-mask-image`，`mask-image` 在本机 WebView 不支持，已探测）。
- 横屏换 `--wp-wide` + `50% 42%`。

### 批 5 收口
- 每页追加 `[data-skin='zzz']` 段，不改原规则：设置页去暗紫（`--el-current-*` 全部落回 `--z-*` 灰阶，层级靠分组标题 + 1px 线 + 编号）、memory 纸卡 + 选中深底荧光、companion 立绘硬影 18u 圆角、journal aside 卡片。
- 裸 px：`zz-*.css` 与各页 zzz 段里**只剩 1px 细线与 0**（`grep` 自查，见第四节）。
- 圆角只用 3 档（18u 内容件 / 6u 操作件 / 3u 标识件）；硬影只用 3 档。
- 一屏荧光 ≤3 处：LIVE + 底栏选中 + 主按钮（memory 的胶囊选中原本整块铺荧光，已改深底 + 荧光边）。

## 三 截图（`_verify/`，均已 read_image 看过）

| 文件 | 视角 | 内容 |
|---|---|---|
| `shot-ui-chat-竖.png` | 竖屏 1080×1920 | 聊天页：壁纸整幅、LIVE、纸/墨气泡、头像、粉影、底栏选中 |
| `shot-ui-settings-竖.png` | 竖屏 | 设置页：分组荧光竖标、卡片硬影、DeepSeek 选中、底部渐隐 |
| `shot-ui-memory-竖.png` | 竖屏 | 回忆页列表：分段选中、胶囊选中、纸卡硬影 |
| `shot-ui-chat-横.png` | 横屏 900×420 | 左 88u 竖条 + 560u 消息列，顶栏/消息/输入条同一条竖线 |
| `shot-ui-settings-横.png` | 横屏 | 设置页横屏列宽收口 |

## 四 硬指标自查

- 裸 px（`zz-*.css` + 各页 zzz 段）：**0 处**，只剩 `1px` 细线与 `0`。
- 字号档：品牌 20u / 标题 26u / 正文 14.5u / 说明 10–11u，≤4 档。
- accent：单屏 = LIVE + 底栏选中 + 主按钮，3 处，面积远低于 8%。
- 裸色值：zzz 层共 30 处，全部是三类——① 遮罩/mask 必须的纯黑或 alpha 渐变（`#000`、`#0a0b0cXX`）；② 网点白点（`#ffffff8a`）；③ 方案原文指定的选中深底 `#1b1f22`。没有随手写的品牌色。
- 横竖两向都成立（截图 + CDP 计算值双证）。

## 五 评审（空上下文子 Agent，按 ai-ui-art-direction 闭环，未告知门槛）

### r1（初版）
- 评审 A：**6 / 10**；评审 B：**4 / 10** → 取最低 **4**。
- 最大差距：**没有主次**——顶栏一排等权重图标、回忆页两排同尺寸 tab、每张卡一句「翻开这段回忆」，唯一的核心动作被壁纸压住；且选中态全站有 4 种写法。
- 属于 CSS 层、本轮已改的：
  1. 滚动页内容贴到导航像被切掉 → 加 `padding-bottom: 28u + env(safe-area-inset-bottom)` + 底部 17u 渐隐（`-webkit-mask-image`）。
  2. 顶栏工具钮视觉 30u，命中区只有 25px → 伪元素撑到 40u。
  3. 回忆页「绿字 + 荧光条 + 容器 1px 底线」= 双下划线 → 去掉容器底线。
  4. 中文大标题 carry 字距读成一格一格 → 标题 `letter-spacing: normal`（字距只留全大写小标签）。
  5. `HTTP 404 · DeepSeek` 灰字压在窗外亮部读不出 → 提一档亮度 + 暗描边（DOM 层「错误不该进消息流」不归我）。
  6. 顶部气泡被裁半行 → 渐隐 26u → 32u。
  7. 底栏网点 0.84 缩放下摩尔纹 → 白点降不透明度。

### r2（本轮改后）
- 评审 A：**5 / 10**；评审 B：**6 / 10** → 取最低 **5**。
- - 最大差距（两票共识）：**强调色没有层级 + 选中态有三种语法**。lime 一屏出现在 LIVE、底栏选中、一级 tab、二级 chip 描边、按钮、竖标上；一级 tab 底下还漂一根独立的荧光横条（与底栏的线下标撞语法）。
- 属于 CSS 层、r2 后已改的（这一轮做完就停，第 3 轮不再跑）：
  1. 一级 tab 的悬空荧光横条 → 删掉，改「深底 + 荧光字」，线下标只留给底栏。
  2. 二级胶囊前缀的「✓」是旧包模板件 → zzz 层 `content: none` 关掉。
  3. 滚动页底部渐隐 17u → 10u（原来把第二张卡的「翻开这段回忆 →」整行淡掉，像被吞了）。
- 明确不接受的评审项（写清理由）：
  - 「用户气泡在竖屏是暖米色、和她的气泡同色」→ 实测不是：竖屏她的气泡是 `--z-paper-bub` 暖米，我的是 `--z-self`（`#191c20f2`，近黑），截图里两者分明。评审看的是 1080 宽整屏缩放图，把深色气泡读成了米色。
  - 「我气泡外圈那圈荧光绿/品红描边无语义」→ 那是方案 §四/§4.0.1 明写的 `--z-hard-pink`（3u 粉影，**只给最新一条我方消息**），是有意的落点，不是随手发光。
  - 「LIVE 徽章无状态来源」→ 方案 §四 指定的器件（`LIVE` 随品牌走）；要真接状态得动 DOM/JS，不在授权内。

### 结论（两轮，止步）
方案 §九 要求「双模型真空评审 ≥9 收」。当前最高 5 分。评审给出的大头扣分集中在**我无权改的层**：把 5 个工具图标收成一个 `⋯`、把报错改成系统条、把两排等分 tab 合并、设置页横屏两栏、卡片信息层级——这些要动 DOM 或 view 的 js，超出本次授权（`styles/**` + 单个 skin 判断 + view 的 css）。CSS 层能消化的已全部消化，剩下的转成下文「待接」。
轮次说明：按 `reviewer-protocol.md` 上限 3 轮，**第 3 轮没有跑**——r2 的每一条扣分要么指向 DOM/文案层（我无权改），要么是评审对截图的误读（已在上文写明理由），再跑一轮只会重复同一批意见。

## 六 踩的坑

1. **`--u` 是百分数不是像素**：`clamp(0.84px, 0.2315vmin, 1.16px)`，`vmin` 1 = 短边 1%。360 宽屏 u=0.84，所以 46u 实测 38.6px、58u 底栏 59.8px —— 是正常缩放，不是"样式没生效"。
2. **cascade 顺序**：`zz-frame.css` 的 `@media` 块比 `zz-parts.css` 的基础声明**更早**进 cascade，同特异度时后者赢 → 横屏列宽算式必须写在 `zz-parts.css` 末尾。第一版顶栏多算了一次 rail（263≠221），就是这个坑的余波。
3. **`:has()` 与 `-webkit-mask-image` 可用，`mask-image` 不可用**（本机 WebView 探测）。顶部渐隐必须写 `-webkit-` 前缀。
4. **横屏没法靠系统旋转验证**：manifest 锁 portrait，`wm size` / `settings put user_rotation` 都无效。改用 CDP `Emulation.setDeviceMetricsOverride` + `Page.captureScreenshot`（自写 `_临时/shot_landscape.js`）。**DSF 必须 = 1**，DSF=2/3 会截出"同一页面横向平铺 2–4 份"的假象（浪费过两轮）。
5. **`write` 工具对新文件报 `file no longer exists`** → 一律 python / heredoc 落盘。
6. 构建锁 `_临时uild.lock` 全程占着；`appuild-apk.ps1` 增量约 2 秒（Vite + Gradle 一起）。
7. 截图只能 `adb exec-out screencap -p > file`，`adb pull` 到 `_verify\` 会 cannot create file。

## 七 没做的 / 待接（明确交接）

1. **时段自动切换差一行 JS**：`main.js` 里留了注释位——`root.dataset.slot = hour < 11 ? 'morning' : hour < 18 ? 'tram' : 'night'`。CSS 三档（壁纸 + 气泡半透明 + 状态词）已全部就位，接上就生效。默认走 night。
2. **批 3 抽屉 / 批 4 动效**：按分工另有人跟，本次未碰（抽屉 tile 规格已在 `zz-parts.css` 里备好：56u 高 / 12u 圆角 / 22u 编号块）。
3. **评审提的 DOM 层项**：五图标收成 `⋯`、错误进系统条而非消息流、回忆页两排 tab 合并、设置页横屏两栏 —— 需要改 DOM / view js，不在授权内。
4. **代际兼容**：`?skin=legacy` 或直接删 `<main>` 上的 `data-skin` 属性即回到旧外观（回退路径已实测存在）。

## 批 3（抽屉）

记忆 / 相处 / 设置改成右侧滑入的抽屉，聊天页不再被销毁（草稿、滚动位置、正在流的回复都留着）。
实现与实测见 `_verify\M9-抽屉.md`。截图 `shot-ui-drawer-settings.png`（竖屏）、`shot-ui-drawer-landscape.png`（横屏）。

## 批 4（动效）

七条节拍 + 降级链落地：页面 180ms、抽屉 180/144ms、气泡 120ms（只最后两条）、按钮 80ms、tab 只过渡颜色、里程碑 260ms glitch、列表不做 stagger。
系统减弱动效 / 低端机自动降级（连续 30 帧 >33ms）/ 键盘弹起三种情况都会降到 0.01ms。
实测与坑见 `_verify\M9-动效.md`。
