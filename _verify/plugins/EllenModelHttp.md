# EllenModelHttp —— M2 验收记录

对照来源：`dexwork\smali-b17\dev\ellen\mobile\platform\EllenModelHttpPlugin.smali`（216 行）
+ `ModelHttpTransport.smali`（1916 行）+ `ModelHttpTransport$Request.smali` + `$Completion.smali`。
实现：`app\app\src\main\java\cn\ellen\companion2\plugin\EllenModelHttpPlugin.kt` + `ModelHttpTransport.kt`
（transport 单独一个文件，因为 M5 的 `EllenAutonomy` 也要用它）。

## 方法表

| 方法 | options（键 / 默认值） | 完成时 resolve | 失败时 reject |
|---|---|---|---|
| `open` | `requestId` / `url`（默认 `""`）/ `apiKey` / `body` | `{status, contentType}` | `"聊天连接操作未完成。"` + 错误码 |
| `read` | `requestId` / `sequence`（默认 `-1`） | `{sequence, done, data?}`，`data` 是 base64 | 同上 |
| `cancel` | `requestId` | `{cancelled:true}` | 同上 |

`+5 自动`：`addListener` / `removeListener` / `removeAllListeners` / `checkPermissions` / `requestPermissions`
（新包 header 报 8 = 3 + 5，与 b17 的 3 个业务方法一致）。

## 与契约的 diff

- `contract\M0-最终契约.json` 记 `EllenModelHttp` 3 个方法、options `requestId`/`url`/`apiKey`/`body`/`sequence`
  —— 与本实现一致，无修正。
- 唯一需要在契约里补记的：`read` 的 `sequence` 默认值 `-1`（不是 0），且**首个合法 sequence 必须是 1**。

## 语义要点（写新 web 层必须照做）

1. `read` 的合法序号是 `req.sequence + 1`，`req.sequence` 初值 0 → 首次 read 传 **1**，之后 2、3…
   传错直接 `INVALID_MODEL_HTTP_REQUEST`。旧产物 `service-DGjhUELY.js` 里 `read({requestId, sequence: l2+1})`
   且 `l2` 从 0 起算，与之吻合。
2. 端点被写死校验：`https` + host `ark.cn-beijing.volces.com` + port `-1|443`
   + 无 userInfo/query/fragment + path 严格 `/api/plan/v3/chat/completions`。
   换服务商要改 transport 常量（不是配置项），旧包同样如此。
3. 并发上限 4（`active.size >= 4` → `MODEL_HTTP_BUSY`），单请求截止 180 s（`MODEL_HTTP_TIMEOUT`）。
4. 错误体（HTTP ≥ 400）最多读 `0x8000` 字节；正常体上限 `0x1000000`，超了 `MODEL_HTTP_LIMIT`。
5. `cancel` 对不存在的 id 也成功：`validId && !closed` 时写进 `earlyCancels`（60 s TTL，最多 64 条），
   之后同名 `open` 直接 `CANCELLED` —— 这是让 abort 抢先到达的机制，必须保留。
6. 超时错误码按阶段换：连接阶段 `MODEL_HTTP_CONNECT_TIMEOUT`，写出 body 之后改成
   `MODEL_HTTP_READ_TIMEOUT`。
7. D10：`EllenLicense` 不实现 → `load()` 里传 `authorized = { true }`，`LICENSE_REQUIRED` 分支在新壳永远走不到。

## 实测证据（MuMu 实例 1 / Android 15 / v0.2.0-m3 / pid 4835 / `adb forward tcp:9444`）

`window.__m3` 与页面卡片全绿：

| 探针 | 结果 |
|---|---|
| 异常 url（`example.com`） | `INVALID_MODEL_HTTP_REQUEST` |
| 异常 apiKey（含中文） | `INVALID_MODEL_HTTP_REQUEST` |
| `read` 未知 id | `CANCELLED` |
| `cancel` 未知 id | `{"cancelled":true}` |
| 真实请求（假 key → 期望 401） | `status=401`，`contentType=application/json; charset=utf-8` |
| 错序号 `read`（sequence 5） | `INVALID_MODEL_HTTP_REQUEST` |
| 按 `seq+1` 循环读到 done | `首个 sequence=1`、`chunks=1`、`bytes=184`、`done=true`、无错误码 |
| 中途 abort（open 未完成就 cancel） | `cancel` → `{"cancelled":true}`，`open` → `CANCELLED` |

截图：`_verify\shot-m3.png`。

## 复现

```powershell
pwsh -File E:\ailian\艾莲手机版\创作版\app\build-apk.ps1     # web + 原生一起出包
# 装包、启动、forward 见 _注册表进度.md 顶部命令块
node E:\ailian\艾莲手机版\创作版\_tools\cdp_eval.js eval 9444 E:\ailian\艾莲手机版\创作版\_临时\m3-peek.js
```

`m3-peek.js` 打印 `window.__m3` 全字段；`m3-cards.js` 打印 11 张卡片的文本与颜色。
