# EllenScreenShell —— M2 验收记录

对照来源：`dexwork\smali-b17\dev\ellen\mobile\platform\EllenScreenShellPlugin.smali`（524 行，含 3 个 lambda）。
实现：`app\app\src\main\java\cn\ellen\companion2\plugin\EllenScreenShellPlugin.kt`。

## 方法表

| 方法 | options | resolve | reject |
|---|---|---|---|
| `setAppearance` | `theme`（`dark` / `light`） | 无参 resolve | `"Unsupported screen appearance"`（**单参 reject，没有错误码**） |

`+5 自动` = listener/permission 五件套。新包 header 报 6 = 1 + 5。

## 语义要点

1. 默认 `theme = "dark"`（构造器写死），与旧包一致 → 首帧背景 `#17191f`。
2. `setAppearance` 在 UI 线程里改主题、重刷外观、再 resolve；非法值走单参 reject（旧包就是没有 code，
   `e.code` 在新壳里会是 Capacitor 的默认值，不是我们编的）。
3. `applyAppearance()` 的守卫链：activity 非空 → 未 finishing → 未 destroyed → bridge 非空 → webView 非空，
   任一不满足直接静默返回（旧包同样不报错）。
4. `prepareWindow()`：`setDecorFitsSystemWindows(false)` + 状态栏/导航栏色 = 0（透明）
   + SDK≥29 关掉系统栏对比度强制（`isStatusBarContrastEnforced=false` / nav 同）。
5. **IME 边界补丁**只在 `Build.VERSION.SDK_INT >= 26` 且 WebView 主版本 ≥ **140** 时装：
   输入法可见、`ime.bottom > 0`、且 decorView 的 `paddingBottom == 0` 时，把 IME inset 改成 `Insets.NONE`
   再交给 `super.onApplyWindowInsets`。作用是避免「WebView 自己让一次 + 网页 `env(safe-area-inset-bottom)` 再让一次」的双份留白。
6. `load()` / `handleOnResume()` / `handleOnConfigurationChanged()` 都调 `reapplyAfterCore()`（post 到 decorView 再刷），
   因为 Capacitor 的 WebView 在这三个时点会重置底色。

## 与契约的 diff

- `contract\M0-最终契约.json` 记 1 个方法、option `theme` —— 一致。
- 补记：reject **没有错误码**（单参 `reject(String)`），不是 `SCREEN_*` 之类。
- 实现偏差 1 处：activity 为 null 时旧包会 NPE（`getActivity().runOnUiThread`），新实现改成同样的单参 reject。
  实际调用时 activity 恒非空，这条分支只在进程正在销毁的极端场景生效。

## 实测证据（MuMu 实例 1 / Android 15 / v0.2.0-m4 / pid 5102）

| 探针 | 结果 |
|---|---|
| `setAppearance({theme:'sepia'})` | reject `Unsupported screen appearance` |
| `setAppearance({theme:'dark'})` | OK |
| `setAppearance({theme:'light'})` | OK（窗口底色切到 `#f8f7f5`，状态栏图标转深色） |

`window.__m4.appearanceOk = true`、`errors = []`。
