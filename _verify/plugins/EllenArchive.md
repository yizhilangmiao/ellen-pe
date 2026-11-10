# EllenArchive · 复刻验收（v0.2.0-m5）

源：`dexwork\smali-b17\dev\ellen\mobile\platform\EllenArchivePlugin.smali`（4125 行）
实现：`app\app\src\main\java\cn\ellen\companion2\plugin\EllenArchivePlugin.kt`
契约：`contract\M0-最终契约.json` → `EllenArchive`（11 个 @PluginMethod）

## 一、容器格式（逐字节，必须一模一样）

```
ELLENPK1\n        9 字节 ASCII MAGIC
int32 (大端)      manifest 的 UTF-8 字节长度 N
N 字节            manifest UTF-8 正文
entry0 字节 …      各文件按 manifest 里的顺序紧接其后
```

manifest（JSON）：

```json
{
  "format": "ellen-companion-archive",
  "version": 1,
  "package": { "..." : "..." },
  "files": [
    { "id": "media-0", "sha256": "<64 位小写 hex>", "mimeType": "image/png", "sizeBytes": 12345 }
  ]
}
```

校验规则（任一不过 → `INVALID_ARCHIVE` / `ARCHIVE_TOO_LARGE`）：

| 项 | 约束 |
|---|---|
| manifest 字节数 | `0 < N <= 0x1100000`（17 MiB），且**不允许 BOM 开头** |
| `format` / `version` / `package` | 三者必须存在，`version` 必须是数字且等于 1 或 2，`package` 必须是对象 |
| `files` 条数 | `<= 0x2710`（10000） |
| 每个 file | **只能有 4 个键**（多一个都拒），且恰好是 `id` / `sha256` / `mimeType` / `sizeBytes` |
| `id` | `[A-Za-z0-9][A-Za-z0-9._:-]{0,199}`，全表唯一 |
| `sha256` | `[a-f0-9]{64}`，是**该文件自己那段字节**的 SHA-256（不含头部与 manifest） |
| `mimeType` | `(image|audio|video)/[a-zA-Z0-9.+-]{1,50}` |
| `sizeBytes` | `> 0`、`<= 0x8000000`（128 MiB）；`image/*` 再限 `<= 0x2000000`（32 MiB） |
| 全部合计 | `<= 0x40000000`（1 GiB） |
| 落盘前空间检查 | `cacheDir\ellen-archive` 可用空间必须 `> 总长度 + 0x800000`（8 MiB 余量），否则 `ARCHIVE_SPACE` |

## 二、方法表

| 方法 | 入参 | 返回 | 说明 |
|---|---|---|---|
| `createExport` | `manifestText`, `name?` | `{handle}` | 建任务，写头部（MAGIC + 长度 + manifest），handle 形如 `archive:<uuid>` |
| `writeExport` | `handle`, `id`, `offset`, `base64` | `{offset}` | 按块写。`offset` 必须等于当前累计偏移；一块最多 `0x10000` 字节（base64 ≤ `0x15558`）；写满一个文件就校验 sha256，不符 → `ARCHIVE_FILE_MISMATCH` 并清场 |
| `saveExport` | `handle` | `{name,sizeBytes}` | 先要求「文件数写满且 position==total」，否则 `ARCHIVE_INCOMPLETE`；然后弹系统「另存为」（`ACTION_CREATE_DOCUMENT`，`application/octet-stream`，标题=会话名）；用户取消 → `{cancelled:true}` |
| `pickImport` | — | `{handle,name,manifestText}` | 弹系统「打开文件」（`ACTION_OPEN_DOCUMENT`，`*/*`）；选完立刻把整个包读进 cache 并逐文件校验 sha256，末尾还要求「流已到 EOF」（多一个字节都拒） |
| `readImport` | `handle`, `id`, `offset`, `length` | `{base64}` | 从 cache 包体按块读出，`0 < length <= 0x10000`，`offset+length <= size` |
| `discard` | `handle?` | `{discarded:true}` | 关会话 + 删 `.part` 临时文件 |
| `cancel` | — | `{cancelled:true}` | 取消当前任务并清场；清场失败 → `ARCHIVE_CLEANUP_FAILED`「资料临时文件未完整清理。」 |
| `background` | — | `{picker}` | 只回答「当前是否停在系统选择器上」 |
| `cancelBackup` | — | `{cancelled:true}` | 置备份取消位 |
| `backupCall` | `method`, `value` | — | **本期未实现**，直接 `BACKUP_UNAVAILABLE` |
| `chooseBackupDirectory` | — | — | **本期未实现**，直接 `BACKUP_UNAVAILABLE` |

共同前置：`begin()` 先查 `closed`（→`ARCHIVE_CLOSED`「资料文件已关闭。」）与 `pending != null`（→`ARCHIVE_BUSY`「请等待当前资料文件操作完成。」），**全局单飞**：同一时刻只允许一个资料包任务。

## 三、状态机要点

- `Job{done:AtomicBoolean, cancelled, picker, stream}`；`Session{handle, mode(export|import), name, text, files, path(.part), file(RandomAccessFile), hash, position, offset, total, index}`。
- `finish`/`reject` 都用 `done.compareAndSet(false,true)` 幂等；`finish` 只 resolve，`reject` 按码映射文案。
- `handleOnStop`：如果当前停在系统选择器上**不取消**（用户切后台回来还能继续选）；否则取消 + 清场。
- `handleOnDestroy`：`closed=true` → 取消 → 清场 → 关线程池。
- `load()`：建 `cacheDir\ellen-archive`，并把上一次残留的 `archive-<uuid>.part` 全删掉。
- 文件名净化：`[\p{Cntrl}\\\\/] → _`，空则回落 `艾莲相处资料.ellenpack`，截断 160 字符。

## 四、实测证据（MuMu 实例 1 / Android 15 / v0.2.0-m5）

`window.__m5`（CDP 直读，`errors: []`）：

```json
{"badManifest":"INVALID_ARCHIVE","createOk":true,
 "createHandle":"archive:23f5cb9b-cfe6-4966-805b-46b2044ebfc6",
 "writeBad":"INVALID_ARCHIVE_CHUNK","offsetAfterA":0,"offsetAfterB":0,"writeOk":true,
 "incomplete":"ARCHIVE_INCOMPLETE","readImport":"ARCHIVE_HANDLE_INVALID",
 "backup":"BACKUP_UNAVAILABLE","discarded":true,"pickerIdle":true,"discardOk":true,"done":true}
```

逐条对应：
- `createExport({manifestText:'not json'})` → `INVALID_ARCHIVE`（不是崩溃，是 Fault 归一）
- 正常两文件（1000 B 图 + 37 B 音频）建会话成功，handle 前缀 `archive:`
- 故意传错 offset（5 而不是 0）→ `INVALID_ARCHIVE_CHUNK`
- 正确分块写完 A、再写 B，两次都以 `offset=0` 收尾（说明 `index` 前进 + `offset` 归零 + 该校验的 sha256 都对上了）
- 没写完就 `saveExport` → `ARCHIVE_INCOMPLETE`
- 假 handle 调 `readImport` → `ARCHIVE_HANDLE_INVALID`
- `discard` 后 `background().picker === false`

注册表：`Capacitor.PluginHeaders` 里 `EllenArchive:16`（11 个 @PluginMethod + 5 个自动 listener/permission 方法）。
截图：`_verify\shot-m5.png`。

## 五、偏差与待办

1. **`backupCall` / `chooseBackupDirectory` 未实现**：二者委托 `EllenBackupStore.call/choose` → `BackupGroups`（82 KB smali 的自动备份引擎，含 SharedPreferences `ellen-backup-v1` 的 `catalog`、`PrivateFileStore("ellen-media-v1")` 媒体流、SAF 目录授权 `takePersistableUriPermission`）。这块单独排期，不塞进 M2。当前调用会拿到 `BACKUP_UNAVAILABLE`「自动备份功能尚未在本版本提供。」
2. 与旧包一致之处刻意保留：`saveExport` 先把 `RandomAccessFile` 关掉再弹选择器；`saveExport` 的 Work 返回 `null`（任务保持 pending 等回调），这个「半挂起」写法是旧包原样，不要顺手「优化」成 resolve。

## 六、复现命令

```powershell
cd 'E:\ailian\艾莲手机版\创作版\app'
pwsh -File .\build-apk.ps1
$env:TEMP='E:\ailian\_临时\adb-tmp'; $env:TMP=$env:TEMP
$adb='E:\ailian\工具\android-sdk\platform-tools\adb.exe'
& $adb -s 127.0.0.1:16416 install -r 'app\build\outputs\apk\debug\app-debug.apk'
& $adb -s 127.0.0.1:16416 shell am force-stop cn.ellen.companion2
& $adb -s 127.0.0.1:16416 shell am start -n cn.ellen.companion2/cn.ellen.companion2.MainActivity
$pid = & $adb -s 127.0.0.1:16416 shell pidof cn.ellen.companion2
& $adb -s 127.0.0.1:16416 forward tcp:9444 localabstract:webview_devtools_remote_$pid
cd 'E:\ailian\艾莲手机版\创作版'
& 'E:\ailian\工具\node\node-v24.21.0-win-x64\node.exe' _tools\cdp_eval.js eval 9444 '_临时\eval-m5.js'
```
