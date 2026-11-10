# M2 插件验收 · EllenSecureConfig

状态：**通过**（2026-11-03，MuMu 实例 1 / Android 15，包 `cn.ellen.companion2` v0.2.0-m2）

依据 smali（全文 767 行逐行对照）：`dexwork\smali-b17\dev\ellen\mobile\platform\EllenSecureConfigPlugin.smali`
新实现：`app\app\src\main\java\cn\ellen\companion2\plugin\EllenSecureConfigPlugin.kt`

## 一、方法表

| 方法 | options | resolve | reject |
|---|---|---|---|
| `read` | `scope`（`model`\|`voice`，默认 `model`） | `{}` 空对象（无配置时）或 `{value:string}` | `SECURE_STORAGE_FAILED`「安全配置无法读取，请重新保存。」 |
| `write` | `scope`、`value`(string) | 空 | `INVALID_CONFIG`「配置无效。」/「配置过长。」、`SECURE_STORAGE_FAILED`「安全配置保存失败。」 |
| `remove` | `scope` | 空 | `SECURE_STORAGE_FAILED`「安全配置移除失败。」 |

## 二、磁盘格式（必须逐字节复刻，否则读不出老配置）

```
alias（AndroidKeyStore 别名） = "ellen.mobile." + scope + "-settings.v1"
文件                          = context.noBackupFilesDir / (scope + "-settings.vault")   ← AtomicFile
内容                          = [0]=0x01 版本 | [1..12]=12 字节 IV | 其余=GCM 密文（含 16 字节 tag）
算法                          = AES/GCM/NoPadding，256 bit，setRandomizedEncryptionRequired(true)
GCMParameterSpec(128, iv)；AAD = alias.getBytes(UTF_8)
明文                          = UTF-8；上限 16000 字符 且 16000 字节
```

旧码分支顺序（新码原样保留，写反了 reject 码就错）：

1. `value == null || value.length > 0x3e80` → `INVALID_CONFIG`「配置无效。」
2. `value.getBytes(UTF_8).length > 0x3e80` → `INVALID_CONFIG`「配置过长。」
3. 其余异常 → `SECURE_STORAGE_FAILED`

## 三、实测证据

**往返（CDP）**

```json
{"secureWriteOk":true,"secureReadOk":true,"secureRoundTripOk":true,"secureKeyCount":1,
 "secureRemoveOk":true,"secureEmptyAfterRemove":true,"errors":[]}
```

写入值 `m2-<时间戳>-中文-🔐`，读回完全一致；删除后 `read` 返回空对象（`value === undefined`）。

**分支覆盖**

| 用例 | 期望 | 实测 |
|---|---|---|
| `write({value:null})` | `配置无效。` | `配置无效。` ✓ |
| `write({value:'x'.repeat(16001)})` | `配置无效。`（先撞字符上限） | `配置无效。` ✓ |
| `write({value:'中'.repeat(6000)})` → 6000 字符 / 18000 字节 | `配置过长。` | `配置过长。` ✓ |
| `write({value:'a'.repeat(16000)})` → 恰好 16000 字节 | 通过 | `RESOLVED` ✓ |
| `read({scope:'nope'})` | `安全配置无法读取，请重新保存。` | 同 ✓（内部 `IllegalArgumentException("Invalid scope")` 被统一 catch，与旧码行为一致） |
| `write({scope:'voice',value:''})` → 空串 | 能读回 `''` | ✓（见第五节偏离） |

**盘上字节（`run-as` 直读，写入 `M2-vault-check-中文`）**

```
-rw------- 50 model-settings.vault
01 0d ea 5a 1c 4d 32 d2 8d 26 81 fd a9 | 85 e2 29 18 87 9b 39 b3 84 22 8c 4d c1 ce c2 ...
^版本  ^--------- 12 字节 IV ----------^  ^------------- GCM 密文 --------------
```

50 = 1(版本) + 12(IV) + 37(密文)。明文 21 字节（`M2-vault-check-` 15 + `中文` 6）+ 16 字节 tag = 37。**逐字节吻合**。

## 四、与 `contract\M0-最终契约.json` 的 diff

| 项 | 契约记录 | 实测/真相 | 处理 |
|---|---|---|---|
| `read` options | `model` | 真实键是 **`scope`**（默认值才是字符串 `model`） | 契约错，已在 `contract\M0-契约总览.md` §契约修正 记录，native-plugins 抽取器把默认值当键抓了 |
| `write` options | `model, value` | `scope, value` | 同上 |
| `remove` options | `model` | `scope` | 同上 |
| 方法数 / reject 码 | 3 / 2 码 | 一致 | — |

## 五、有意偏离旧实现（1 处，已确认安全）

旧码 `read` 的长度下限写 `0x1e = 30`，而最小合法密文是 `1 + 12 + 16 = 29` 字节
→ 旧包把**空字符串**写进去以后自己再也读不回来（抛 `Invalid vault` → `SECURE_STORAGE_FAILED`）。
新码下限改 29：旧文件全部仍可读（它们最小 29 也是合法的），只是把这个死角补上。

## 六、迁移硬约束（M4 必须遵守）

AndroidKeyStore 别名与 `noBackupFilesDir` 都挂在**包名**下，换包名后旧 vault 在新包内**无法解密**：

- 新包不能直接搬 `model-settings.vault` 文件（搬过去没有对应密钥）。
- 唯一通路：旧 App 用 `EllenSecureConfig.read` 拿到明文 → 走导出通道交出来（明文，注意 D12 之外的敏感性）→ 新 App `EllenSecureConfig.write` 重新加密落盘。
- 因此 M4 的导入包必须包含 `model` / `voice` 两段明文配置，且导入后**立刻**重新加密，不落中间明文文件。
