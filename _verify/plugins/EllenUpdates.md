# EllenUpdates · 边界与残留状态（native 侧）

> 2026-11-11 · 会话 native-plugins · 基线 `0.3.0-m7`（versionCode 1，未升版本）
> 代码：`app\app\src\main\java\cn\ellen\companion2\plugin\EllenUpdatesPlugin.kt`
> 实测环境：MuMu `127.0.0.1:16448` + 本地桩 `_临时\m8\stub-server.js`（Range + 限速 + 请求日志），
> 载荷 `payload.bin` 6 MB（sha256 `3d193d03…b97bf`）

## 为什么这个文件里有三层防御

这一版 `install()` / `state()` 外面套了三层，不是防御性编程习惯，是**同一个 bug 连修三次**换来的。链条记全，下次别只抄最后那层：

1. **症状**：摘掉 `REQUEST_INSTALL_PACKAGES` 的包，一进更新页整进程崩 —— `am_crash: java.lang.SecurityException at ComputerEngine.canRequestPackageInstalls(ComputerEngine.java:4009)`，紧接 `wm_finish_activity force-crash`、`am_proc_died`。因为 `state()` 里那句 `canRequestPackageInstalls()` 在调用路径上，没人接这个异常。
2. **第一层修**（`canInstallSafely()` 包 `try/catch` → `false`）**修好了崩溃，但立刻暴露第二个错**：`checkSelfPermission(REQUEST_INSTALL_PACKAGES)` 在 Android 15 上**永远 `DENIED`**（这个权限不是运行时授予的，`install permissions:` 里根本没有它），于是「申请了权限的正常包」也被判成 `no_permission`，`install()` 永远回「只能手动装」。
3. **根因分层**：「**包声明了没有**」要问 `requestedPermissions`（`declaresInstallPermission()`），「**现在授没授**」才问 `canRequestPackageInstalls()`（`canInstallSafely()`）—— 原来把两个问题混成一个判断。
4. **第三个错**：`state()` 读持久快照，把上一轮的 `canInstall` 当历史记录返回，UI 上表现为「进更新页看到的是旧值，点一下 check 才刷新」。
5. **收口测法**：翻 appop → 起进程 → 读 `state`，**用「旧实现会回 `true`」当判据**（持久快照存 `true`，`ignore` 后重启读到 `false`，只能是现算的）。

一句话记：**能崩的、判错的、读旧的，是三个不同层次的错，各自要有各自的那层防御**；只补 `try/catch` 会让崩溃消失、错误留下。

## 〇、线上 bug 修复记录（2026-11-11 实测挖出）

| 项 | 内容 |
|---|---|
| 错误码 / 栈顶 | `java.lang.SecurityException` at `com.android.server.pm.ComputerEngine.canRequestPackageInstalls(ComputerEngine.java:4009)` |
| 触发条件 | **包本身没申请 `REQUEST_INSTALL_PACKAGES`**（Android 15 / V2364A 实测）：`canRequestPackageInstalls()` 直接抛，`state()` 与 `install()` 都在调用路径上 → 整进程崩（`am_crash` → `wm_finish_activity force-crash` → `am_proc_died`） |
| 修法 | `canInstallSafely()`：`try { canRequestPackageInstalls() } catch (SecurityException) { Log.w(...); false }`，`state():118` 的 `canInstall` 与 `install()` 的未知来源判断都改走它；异常路径当 `false`，只留一条 `W` 日志记账 |

> **教训（比结论有用）**：`ws error: unknown` + 进程消失，第一嫌疑不是别人杀进程，而是自己代码在 CDP 调用路径上抛了未捕获异常。
> 查法固定三步：`logcat -b events | Select-String am_crash`（拿异常类型与栈顶）→ `am_proc_died` 拿 pid → 对照 `force-crash` 时间点。
> 同一条也解释了 14:45 那次「排期踩踏」的误判：那两次其实是同一个 `SecurityException`，跟别人 force-stop 无关。

### 〇.2 第二个 bug：`checkSelfPermission` 判「包申请了没有」是错的（同一轮挖出）

`dumpsys package cn.ellen.companion2` 在 Android 15 上长这样：

```
requested permissions:  android.permission.REQUEST_INSTALL_PACKAGES   ← 声明了
install permissions:    ... WAKE_LOCK granted=true                     ← 里面没有它
```

即 `REQUEST_INSTALL_PACKAGES` **不是运行时授予的权限**：`checkSelfPermission` 恒回 `DENIED`，
而 `canRequestPackageInstalls()` 回 `true`。所以正常包也会被判成「没申请」→ 回 `no_permission`、不跳设置页（实测 B 段就是这个错）。

**「包申请了没有」和「现在授没授」是两件事**，修法拆成两个函数：

| 函数 | 回答什么 | 实现 | 失败兜底 |
|---|---|---|---|
| `declaresInstallPermission()` | 清单里声明了没有 | `getPackageInfo(packageName, GET_PERMISSIONS)`（33+ 用 `PackageInfoFlags.of(...)`）→ `requestedPermissions?.contains(REQUEST_INSTALL_PACKAGES) == true` | 读不到按 **true**（不能因为读不到把正常升级路径挡死） |
| `canInstallSafely()` | 未知来源开关开没开 | `try { canRequestPackageInstalls() } catch (SecurityException) { Log.w; false }` | 异常按 **false** |

判断顺序必须保住：**先 `declares`，再 `canInstall`** —— 这是「摘权限的包不许跳设置页」的因果。

四格回归表（改完照这张表跑）：

| 包 | `declares` | `canInstall` | `install()` 结果 | `SpaActivity` |
|---|---|---|---|---|
| strip（无该权限） | false | false（**不崩**） | `phase:"permission"` / `reason:"no_permission"` | 0 |
| normal（有该权限） | true | true | `phase:"permission"` / `reason:"permission"` | ≥1（跳了设置页） |

### 〇.3 `canInstall` 是瞬时值：`state()` 必须现算（第三处修）

`state()` 原来把持久快照里的 `canInstall` 直接返回，表现是「进更新页看到的是上一轮的开关状态，点一下 check 才刷新」。
改成 `out.put("canInstall", canInstallSafely())`（`sanitize` 之后覆盖），注释写明：**`canInstall` 是瞬时值，由 `canInstallSafely()` 现算；持久快照只留 `phase` / 进度**。

**测法（关键）**：把「旧实现的错误行为」当判据 —— 持久快照里存的是 `true`，所以只要**翻 appop 后重启进程读到 `false`**，就只可能是现算的。

```text
appops set cn.ellen.companion2 REQUEST_INSTALL_PACKAGES ignore → 起进程 → state().canInstall = false  ✔
appops set cn.ellen.companion2 REQUEST_INSTALL_PACKAGES allow  → 起进程 → state().canInstall = true   ✔
```

### 〇.4 MuMu 环境知识（踩过，别重踩）

- **改 `REQUEST_INSTALL_PACKAGES` 的 appop 会静默 kill 应用进程**：`am_crash` 里没有任何记录、`pidof` 直接空。所以「改完 appop 不重启直接读 state」这条路走不通，必须「翻 appop → 起进程 → 读 state」。
- **`appops reset <pkg> <op>` 在这台机器上报 `Unsupported argument: REQUEST_INSTALL_PACKAGES`**，而且**不会**还原（值仍停在 `ignore`）。还原只能用 `appops set <pkg> <op> allow`，改完用 `appops get` 复核一次。
- 未知来源在这台模拟器上默认就是 `allow`，所以「跳设置页」那格（`reason:"permission"` + `SpaActivity`）**在 MuMu 上验不了**：`SpaActivity` 是 vivo 专有页，且 appop 一撤进程就被杀。这格留给真机。

## 一、改前的问题（都在这一版修掉了）

| # | 现象 | 根因 |
|---|---|---|
| 1 | 卸载/退出时下载还在跑，要等 60 s read 超时才断 | `handleOnDestroy` 只置标志位 + `shutdownNow()`，**打断不了阻塞在 socket read 的线程** |
| 2 | cancel 之后立刻 download 被 `UPDATE_UNAVAILABLE` 挡回 | `publish()` 每次重建 state 不带 `latest`，cancelled/error 相位下 `latest` 丢了 |
| 3 | 换 sha 重下会拿旧残片续传，永远校验不过 | `download()` 读的 `downloadingSha` 这个键**从来没写过** |
| 4 | 同 versionCode 重发的包永远推不下去 | `check()` 只比 `versionCode <= currentCode` |
| 5 | 「装不了」只有一种文案 | `install` 只判 `canRequestPackageInstalls()`，没区分「包本身没申请权限」 |

## 二、现在的边界行为

| 边界 | 行为 | 关键实现 |
|---|---|---|
| `cancel` | 关流 → 等 worker 放掉 `busy`（≤1.5 s）→ 回 `{cancelled, stopped, keptBytes}` | `closeActive()` + `awaitIdle()` |
| cancel 后立刻 `download` | 从 part 长度续传，发 `Range: bytes=<kept>-` | `partFile()` 长度做 offset，`downloadingSha` 决定残片是否作废 |
| `handleOnDestroy` | 置 `cancelled` → 关流 → `shutdownNow` → `awaitTermination(1 s)` | 顺序不能反：先关流打醒 read |
| 同 versionCode、sha 不同 | `phase:"available"`，`message:"有同版本的新包：<version>"` | `installedApkSha()` 与清单 sha 比 |
| 同 versionCode、sha 相同 | `phase:"current"` | 同上 |
| 没有 `REQUEST_INSTALL_PACKAGES` | `phase:"permission"` + resolve `{started:false, reason:"no_permission"}` | `checkSelfPermission(...)` 分支，在 `canRequestPackageInstalls()` 之前判 |
| 续传点越界（416） | 删残片从头下 | `status == 416` 分支 |
| 残片已等于总长 | 直接进 `verifying` 校验，不再发请求 | `offset == total` 早退 |

`installedApkSha()` 按 `versionCode` 缓存（prefs `installedSha` / `installedShaCode`），
从 `packageManager.getApplicationInfo(packageName,0).sourceDir` 算，别每次 check 都读 100 MB。

### `install()` 两种「装不了」的原文（`phase` 都是 `permission`，靠 `reason` 区分）

| 情况 | 判定 | `message`（原文） | resolve |
|---|---|---|---|
| 包本身没申请 `REQUEST_INSTALL_PACKAGES` | `checkSelfPermission(REQUEST_INSTALL_PACKAGES) != GRANTED`（`EllenUpdatesPlugin.kt:426`，在未知来源判断**之前**） | `这个安装包没有申请安装应用的权限，更新只能手动装。` | `{started:false, reason:"no_permission"}`，不跳设置页 |
| 申请了但用户没开未知来源 | `!canRequestPackageInstalls()`（`EllenUpdatesPlugin.kt:436`） | `需要在系统设置里允许安装未知来源。` | `{started:false, reason:"permission"}` + 跳 `Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES`（绝不代点安装） |

### 顺序断言（本次要证的因果，比「行为描述」强）

```text
install() 里 checkSelfPermission(REQUEST_INSTALL_PACKAGES) 一定先于 canRequestPackageInstalls() 求值
⇒ 摘掉该权限的包，即使「未知来源」也没开，也不可能跳 ACTION_MANAGE_UNKNOWN_APP_SOURCES
⇒ 摘权限后调 install() 的 logcat 里 SpaActivity / PackageInstaller 命中数必须为 0，
  且 phase 必为 "permission"、reason 必为 "no_permission"
```

三条同时成立才算这条边界过；缺一条就说明分支顺序被改动过。

### APK 基线体积（带权限版，`versionName 0.3.0-m7` / `versionCode 1`）

```
app-debug.apk            100,269,828 B   ← 默认构建（build-apk.ps1 -SkipWeb，无 -Split），2026-11-11 14:51:15
app-x86_64-debug.apk      68,795,486 B   ← 带 -Split
app-arm64-v8a-debug.apk   64,550,138 B   ← 带 -Split
```

体积对不上就说明构建参数（`-Split` / `-SkipWeb` / 依赖）变了，先查再谈行为。
普通构建会**清掉** `-Split` 那一对（14:47 那对被 14:51 的普通构建删了），要装哪个就先构哪个。
摘掉 `REQUEST_INSTALL_PACKAGES` 的对照版是 `68,794,574 / 64,549,226 B`（各小 912 B），**已作废，只作对照**。

## 三、实测（模拟器，逐条原始输出）

| 边界 | 证据 |
|---|---|
| 同版本换 sha | `phase:"available"`、`message:"有同版本的新包：0.3.0-m8"`（`current.versionCode=1`、`latest.versionCode=1`） |
| 同版本同 sha | `phase:"current"`、`message:"已经是最新的（0.3.0-m7）。"`，且 `latest` 仍在（说明 sha 是算出来的，不是猜的） |
| cancel | `{cancelled:true, stopped:true, keptBytes:983040}`；桩日志 `client-closed sent=983040`（0.5 s 内断开，非超时） |
| 续传 | 桩日志 `range=bytes=983040-` → `206 start=983040 len=5308416` → `done` → `phase:"ready"`（sha256 通过），全程 17.0 s |
| onDestroy | logcat `W EllenUpdates: handleOnDestroy busy=true`；桩 `client-closed sent=1638400`；`update.part` 停在 1638400 两次采样不变 |
| 无权限分支 | **待跑（30 s 窗口）**：strip 包已构好 `E:\ailian\_临时\m8\app-strip-perm.apk`（100,334,897 B），判据见上「顺序断言」三条 |

### 权限核验的正确做法（踩过一次）

`aapt` 是 C++ 工具，**吃不了中文路径**：直接对 `E:\ailian\艾莲手机版\...\app-debug.apk` 跑
`aapt dump permissions` 会输出 `W ziparchive: Illegal byte sequence` + `ERROR: dump failed because no AndroidManifest.xml found`，
用 `Select-String` 数条数就是 **0** —— 假阴性，看着像「权限没进包」。

正确做法：先把 apk 拷到纯 ASCII 路径（`E:\_tmp\m8apk\`）再 dump。2026-11-11 15:06 复核结果：

```
E:\_tmp\m8apk\normal.apk  → 有 uses-permission: name='android.permission.REQUEST_INSTALL_PACKAGES'
E:\_tmp\m8apk\strip.apk   → 无该行（USE_EXACT_ALARM / SCHEDULE_EXACT_ALARM 都在）
```

**14:45 那轮报给 lead 的「aapt 条数 = 0」是假阴性，已作废**；strip/normal 的差异以此处复核为准。

## 四、state 字段口径（沿用，未改）

`received` / `total` / `lastError` 只在 `downloading` / `verifying` / `ready` 相位出现，
`unpublished` / `idle` / `checking` 不再带上一轮的残留进度（M7 已修，这次回归仍是干净值）。
