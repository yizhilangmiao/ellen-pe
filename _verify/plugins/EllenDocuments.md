# EllenDocuments —— M2 验收记录

> **⚠️ 状态（2026-11-10 18:50 重写后）：本文件下面「方法表 / 语义要点 / 实测证据」三节描述的是 b17 旧契约
> （`pickText` / `pickCharacter` / `cancel`），重写版本里**没有实现**它们（web 生产代码 grep 0 命中，只有
> `m4.js` 探针在引用）。现役实现是 `save / open / remove / stat` 四个方法，见文末「重写版实现」一节。
> 旧契约留着备查，别照它写调用。

对照来源：`dexwork\smali-b17\dev\ellen\mobile\platform\EllenDocumentsPlugin.smali`（33 KB，含 `$Job` 与 lambda）。
实现：`app\app\src\main\java\cn\ellen\companion2\plugin\EllenDocumentsPlugin.kt`。

## 方法表

| 方法 | options | resolve | 主要 reject（消息 / 码） |
|---|---|---|---|
| `pickText` | `requestId` | `{cancelled:false, name, text}` | `文件选择已关闭。/DOCUMENTS_CLOSED`、`文件选择器已打开。/DOCUMENTS_BUSY`、`无效的文件选择操作。/INVALID_REQUEST`、`系统文件选择暂时不可用，可粘贴资料正文。/DOCUMENT_PICK_FAILED`、`请选择系统文件列表中的资料文件。/INVALID_DOCUMENT`、`资料文件须使用UTF-8文字编码。/INVALID_DOCUMENT_ENCODING`、`世界书文件最多1 MB。/DOCUMENT_TOO_LARGE`、`资料文件无法读取，原稿未改。/DOCUMENT_READ_FAILED` |
| `pickCharacter` | `requestId` | `{cancelled:false, name, base64}` | 同上，但超限文案是 `角色卡文件最多32 MiB。` |
| `cancel` | `requestId`（null = 取消当前任意一个） | 无参 resolve | 被取消的那个 call 收 `文件选择已取消。/CANCELLED` |

`+5 自动` → header 报 8 = 3 + 5。

## 语义要点（状态机，别简化）

1. `requestId` 必须给：非 null、非空、长度 ≤ **160**；不够格直接 `INVALID_REQUEST`。
2. 单飞：`pending != null` 就 `DOCUMENTS_BUSY`，不排队。
3. Intent = `ACTION_OPEN_DOCUMENT` + `CATEGORY_OPENABLE` + `*/*` + `EXTRA_ALLOW_MULTIPLE=false` + `FLAG_GRANT_READ_URI_PERMISSION`，
   回调点注册名 `"picked"`（`@ActivityCallback`）。
4. `picked()` 只在 `resultCode == RESULT_OK` 且 `data.data.scheme == "content"` 时进读盘线程；
   用户取消（RESULT_CANCELED）→ 清 pending 后**resolve `{cancelled:true}`**，不是 reject。
5. 读盘：先查 `_display_name` / `_size`（默认名 `世界书.json`、默认 size -1）；
   `size > limit` 直接 `TOO_LARGE`；名字剔控制字符（`[\p{Cntrl}]`）→ 空则回默认 → 截到 200 字符。
6. 上限：文本 **1 MiB**、二进制 **32 MiB**；边读边累加，越过上限立刻 `DOCUMENT_TOO_LARGE`。
7. 文本解码用**严格 UTF-8**（`onMalformedInput/onUnmappableCharacter = REPORT`）→ 非法编码走
   `INVALID_DOCUMENT_ENCODING`，不是静默替换成 `�`。二进制走 `Base64.DEFAULT`（含换行）。
8. `Job.done` 是 `AtomicBoolean`：谁先 CAS 成功谁才有权 resolve/reject，重复回调只会触发一次。
9. `cancel(requestId)` 的 `requestId` 为 null 时取消当前 pending；不匹配则什么都不做（但 `cancel` 自己永远 resolve）。
10. `handleOnDestroy`：`closed = true` → 取消 pending → `worker.shutdownNow()`。

## 实测证据（v0.2.0-m4 / pid 5102）

| 探针 | 结果 |
|---|---|
| `pickText({})`（缺 requestId） | `INVALID_REQUEST` |
| 真拉起选择器后再发第二个 | `DOCUMENTS_BUSY` |
| `cancel({requestId:'m4-pick-a'})` | cancel 自身 OK；第一个 call 收 `CANCELLED` |

`window.__m4.pickNoRequestId/pickBusy/pickCancelled` 与预期一致，`errors = []`。

> 「选了文件后真的读到内容」这条要人手点选择器，留到 M4 资料导入联调时用真实世界书跑。

## 重写版实现（2026-11-10，v0.3.0-m8-rewrite）

落点 `context.filesDir/attachments`，uri 由 `${applicationId}.fileprovider` 出（`res/xml/file_paths.xml` 的 `files-path path="."` 已覆盖）。

| 方法 | 入参 | resolve | reject |
|---|---|---|---|
| `save` | `{name, base64}`（可带 `data:...;base64,` 前缀） | `{uri, name, bytes, mimeType}` | `DOCUMENT_EMPTY` / `DOCUMENT_TOO_LARGE` / `DOCUMENT_INVALID_DATA` / `DOCUMENT_WRITE_FAILED` |
| `open` | `{uri}` | `{base64, bytes, name, mimeType}` | `DOCUMENT_INVALID_URI` / `DOCUMENT_NOT_FOUND` / `DOCUMENT_TOO_LARGE` / `DOCUMENT_READ_FAILED` |
| `remove` | `{uri}` | `{removed:Boolean}` | `DOCUMENT_INVALID_URI` |
| `stat` | `{uri}` | `{exists, bytes, mtime, name}` | `DOCUMENT_INVALID_URI` |

约束：

1. 单次 base64 上限 **32 MiB**（先按字符数 `len/4*3` 挡一道，解码后再核一次）。
2. 文件名 = 调用方 `name` 的净化前缀（非字母数字→`_`，截 40）+ 自生成 16 位 id + 原扩展名；**绝不拿 name 拼路径**。
3. 读只认本机 fileprovider 的 `content://` 或纯文件名；带 `/`、反斜杠、`..` 的一律 `DOCUMENT_INVALID_URI`。
4. 先写 `<name>.part` 再 `renameTo`，中途失败不留半个附件。

实测（模拟器 16448 / pid 2997 / CDP 9336）：

| 探针 | 结果 |
|---|---|
| `Object.keys(window.Capacitor.Plugins)` | 18 = 14 自定义 + 4 core，`EllenDocuments` 在列，4 方法齐 |
| `save({name:'../../evil 测试.txt', base64:'aGVsbG8…'})` | `…/attachments/______evil_测试-2659a3050f1d495e.txt`，23 B，`mimeType:text/plain` |
| `stat` / `open` / `remove` / 再 `stat` | `exists:true,23` → 往返 base64 一致 → `removed:true` → `exists:false` |
| `open({uri:'content://other.provider/x.txt'})` | 「这个 uri 不是本机附件。」 |
