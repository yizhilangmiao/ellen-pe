# M2 插件验收 · EllenReleaseInfo

状态：**通过**（2026-11-03，MuMu 实例 1 / Android 15，包 `cn.ellen.companion2` v0.2.0-m2）

依据 smali（全文逐行对照）：`dexwork\smali-b17\dev\ellen\mobile\platform\EllenReleaseInfoPlugin.smali`（191 行）
新实现：`app\app\src\main\java\cn\ellen\companion2\plugin\EllenReleaseInfoPlugin.kt`

## 一、方法表

| 方法 | options | resolve | reject |
|---|---|---|---|
| `state` | 无 | `available`(bool,恒 true)、`appName`(string)、`packageName`(string)、`version`(string)、`versionCode`(number/long)、`debuggable`(bool)、`channel`(`development`\|`release`)、`androidVersion`(string)、`minimumAndroidAPI`(number) | `VERSION_UNAVAILABLE`「当前安装包版本暂时无法读取。」 |

实现细节必须与旧码一致的三点：

1. `versionCode` 在 `SDK_INT >= 28` 走 `PackageInfo.getLongVersionCode()`，否则把 `versionCode` 抬成 `long`（JS 侧都是 number）。
2. `debuggable` = `ApplicationInfo.flags & 0x2`（`FLAG_DEBUGGABLE`）。
3. `channel` 由 `debuggable` 推导，不是读 manifest 里的渠道字段。

## 二、实测证据（CDP 现场返回）

```json
{"available":true,"appName":"艾莲","packageName":"cn.ellen.companion2","version":"0.2.0-m2",
 "versionCode":1,"debuggable":true,"channel":"development","androidVersion":"15","minimumAndroidAPI":24}
```

旧包（b17，`cn.ellen.companion`）同一方法返回 `packageName=cn.ellen.companion`、`version=0.1.23`。
两者字段集合完全一致，只换值——**契约对齐，无字段增删**。

## 三、与 `contract\M0-最终契约.json` 的 diff

| 项 | 契约记录 | 实测 | 结论 |
|---|---|---|---|
| 方法数 | 1（`state`） | 1 | 一致 |
| reject 码 | `VERSION_UNAVAILABLE` | 同 | 一致 |
| options | 空 | 空 | 一致 |

无 diff。

## 四、新包里的语义变化（要记住，不是 bug）

`packageName` 现在是 `cn.ellen.companion2`，`appName` 取的是 `application/@android:label`（当前为「艾莲」）。
旧 web 层有「读自己包名/版本 → 判断要不要更新」的分支，在新包上会得出「不是同一个 app」的结论。
按 D10（不做激活校验、装完即用），这一支在新壳里**不实现**；M7 的更新检查改为只读 `versionName` 做展示。
