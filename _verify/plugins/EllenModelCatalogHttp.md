# EllenModelCatalogHttp —— M2 验收记录

对照来源：`dexwork\smali-b17\dev\ellen\mobile\platform\EllenModelCatalogHttpPlugin.smali`（909 行，含 `$Request` 与 lambda）。
实现：`app\app\src\main\java\cn\ellen\companion2\plugin\EllenModelCatalogHttpPlugin.kt`。

## 方法表

| 方法 | options（键 / 默认值） | resolve | reject |
|---|---|---|---|
| `request` | `requestId` / `apiKey` / `url`（默认 `""`） | `{status, body, contentType}` | `"模型列表请求未完成，请检查网络和服务地址。"` / `"模型列表正在读取或已关闭。"` / `"模型列表请求参数无效，未发送。"` / `"获取模型已取消。"` |
| `cancel` | `requestId`（默认 `""`） | 空（无参 resolve） | — |

`+5 自动` = listener/permission 五件套。新包 header 报 7 = 2 + 5。

## 与契约的 diff

- `contract\M0-最终契约.json` 记 2 个方法、options `requestId`/`apiKey`/`url` —— 一致。
- 需要补记：`cancel` 的 `requestId` 默认值是 `""`（不是 null）；`request` 的 url 默认 `""`。

## 语义要点

1. **单飞**：`active` 非空就拒绝（`MODEL_HTTP_BUSY`），不是排队。
2. 参数校验：`validId`（`[A-Za-z0-9][A-Za-z0-9._:-]{0,199}`）、apiKey 只认 `[\x21-\x7e]{1,4096}`、
   url 长度 ≤ `0x2000`、scheme 必须 `https`、无 userInfo/query/fragment、path 必须以 `/models` 结尾。
3. 请求：`GET`、不跟随重定向（3xx 直接失败）、connect/read 超时都是 **12000 ms**（`0x2ee0`）、
   `Accept: application/json`、`Authorization: Bearer <apiKey>`。
4. 只在 2xx 读 body（`0x4000` 分块，累计不得超过 `0x100000` = 1 MiB）；非 2xx 的 body 一律丢弃，`body` 返回空串。
5. `contentType` 取 `HttpsURLConnection.contentType`，可能为 `null` → 实现在 JSObject 里给空串。
6. 取消：`cancel` 只置标志 + disconnect，不等线程；`handleOnStop` 取消全部；`handleOnDestroy` 关闭后
   新请求一律 `MODEL_HTTP_BUSY`。

## 实测证据（同 `EllenModelHttp.md`，v0.2.0-m3 / pid 4835）

| 探针 | 结果 |
|---|---|
| 非法 url（`http://`） | `INVALID_MODEL_CATALOG_REQUEST` |
| 真实 GET `https://ark.cn-beijing.volces.com/api/v3/models`（假 key） | `status=401`、`bodyLen=0`、`contentType=application/json; charset=utf-8` |
| 并发第二个请求 | `MODEL_HTTP_BUSY` |

> `bodyLen=0` 是**正确**的：401 属非 2xx，按旧实现只读 2xx body。

截图：`_verify\shot-m3.png`。
