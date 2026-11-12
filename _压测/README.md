# _压测 — 手机版大数据压测

一次跑完「造数 → 测 → 清场」，结果写 `结果\`，跑完直接对基准。

**为什么单独开这个目录**：原来的压测脚本散在 `_临时\` 的二十多个变体里（`m5-journal.js`、`m8-journal-big1~5.js`、`m7-seed.js`、`seed-memory.js`、`stress-memory*.js`、`measure-recall-cost.js`）。而 `_临时\` 被 `.gitignore:40` 忽略、还有「>10 GB 自动清理」——压测事实随时会消失，下次谁也不知道当时怎么测的。这里不在忽略名单里，`git add` 直接能收。

## 一、连上 WebView（run.mjs 已自动做，手动只是排查用）

手机版的调试端口不是 Electron 的 9336，是 WebView 的 `localabstract`，必须 adb forward。
**`run.mjs` 每次跑都会自己重发一遍** —— APP 一重启 pid 就变，socket 名跟着变，老映射不会失效只会指向死 pid（症状：`fetch failed`）。

出问题时手动排查：

```powershell
$adb = "E:\ailian\工具\android-sdk\platform-tools\adb.exe"
& $adb connect 127.0.0.1:16448          # MuMu 实例 2 的 adb_port
& $adb -s 127.0.0.1:16448 shell "pidof cn.ellen.companion2"      # → 30754
& $adb -s 127.0.0.1:16448 shell "cat /proc/net/unix | grep devtools"
# → @webview_devtools_remote_30754
& $adb -s 127.0.0.1:16448 forward tcp:9222 localabstract:webview_devtools_remote_30754
```

`adb_port` 用 `MuMuManager.exe info -v 2` 查。APP 必须在前台 —— 冷启动还没画完时 `/json/list` 是空的。

验证：浏览器打开 `http://127.0.0.1:9222/json/list`，能看到 `"title": "艾莲"`。

## 二、跑

```powershell
cd E:\ailian\艾莲手机版\创作版
& "E:\ailian\工具\node\node-v24.21.0-win-x64\node.exe" _压测\run.mjs --scenario memory-5000
```

| 参数 | 作用 |
|---|---|
| `--scenario <名字>` | `memory-5000`（默认）/ `journal-503` / `backup-13929` |
| `--port 9222` | 已 forward 的端口 |
| `--serial 127.0.0.1:16448` | 设备序列号（MuMu 实例 2），换设备时改这里 |
| `--adb <路径>` | adb 可执行文件，默认 `E:\ailian\工具\android-sdk\platform-tools\adb.exe` |
| `--no-adb` | 不自动转发（端口已经自己弄好了） |
| `--keep` | 不清场（想自己进页面看效果时用） |
| `--skip-seed` | 不造数，只测库里现成的 |
| `--out <路径>` | 指定结果文件，默认 `结果\<日期>-<场景>.md` |

跑完打印判定表，出现 `CHECK` 时退出码 1。

## 三、场景与基准

| 场景 | 造什么 | 基准来自 |
|---|---|---|
| `memory-5000` | 5,000 条 memory，`memory:stress-0` 是「北极星吊坠」（3 年前） | `_verify\M16-记忆压测.md`：分解成本 544 ms、首屏 60 卡、吊坠 rank 1。**2026-11-11 21:25 起**召回改走单事务批量读，基准下调为 首问 120–1500 ms / 分解 150–900 ms |
| `journal-503` | 20,018 消息 + 503 手记 + 10 记忆 | `_verify\M8-回归.md` 第四节：写一篇 2,608 ms、查今天 19 ms、判该不该写 18 ms |
| `backup-13929` | 12,020 消息 + 1,504 记忆 + 404 手记 | `_verify\M7-备份.md`：manifest 7,696,183 B |

判定栏是「同口径对照」，不是绝对门槛 —— 换机器、换系统版本，绝对值会飘。真正该看的是**同机前后对比**：改完召回或列表代码，跑一遍和上一份 `结果\*.md` 比。

## 四、坑（改脚本前必读）

1. **`data-revisions` 的 keyPath 是 `revisionId`，不是 `id`**；`head.revisions` 数组里放的也是 revisionId。写错任何一处，库里数得到、页面一张都不出。
2. **profileId 别硬编码**。老 `seed-memory.js` 写死 `profile:old-device`，换个库就查不到。现在从现库 `profilesInUse()` 取最多的那个。
3. **IDB 版本别写死**（老 `m7-seed.js` 写的是 `open(..., 3)`）。prelude 的 `openDB()` 不传版本 = 按当前版本打开。
4. **造数直插 IndexedDB，绕过了写入方的 `invalidateRecall()`** —— 所以 `run.mjs` 造完数会重载页面。不重载的话召回索引缓存还是旧数据，「冷启动 +500 ms」测出来是假的。
5. **清场后同样要重载**：`clean.js` 默认带 `reload: true`。
6. **别在真机上跑**：5,000 条写进去之后切页会卡，而且压测数据会混进真实记录。用 MuMu 实例 2。
7. **`probe-list` 依赖选择器** `.el-memory-card` / `.el-journal-more` / `[data-memory-tab]`。改 UI 动了类名，这里会静默返回 `cards: 0` —— 看到 0 先怀疑选择器，别怀疑性能。
8. **备份场景会真的往「文档」写包**。反复跑会攒包，跑前先把 `retainGroups` 调小或手动清。
9. **`journal.force()` 不新建 head，它往「今天那篇」上加 revision。** `writeJournal` 按天找 head，今天已经有日记就复用那个 head 追加一条修订。所以在有真日记的库里跑 `force()`，等于**往老大今天的日记里塞一版 AI 内容**。`probe-journal.js` 自己写完立刻回滚（删 revision + `head.last` 指回原来那条；如果 head 本来就是空的，连 head 一起删），只留耗时。
10. **`clean.js` 只按前缀删，绝不接受精确 id 清单。** 2026-11-11 栽过一次：想让清场顺手带走 `force()` 写的那一条，传了 `headIds`，结果那个 headId 是**今天那篇真日记**，清场把整条日记（head + 3 个 revision）删了。`adb pull` 出 leveldb 逐字节翻过，无残留，恢复不了。这个坑就是第 9 条的另一面 —— 任何「按 id 删」的路径都会指向真数据。
11. **`journalDue` / `todayJournal` 在 2 万条消息下每次约 230–320 ms**，而且连调三次都一样（不是冷启动），M8 记的 18/19 ms 在同量级数据下复现不出来。判该不该写是每条消息前都会走的路，这块有优化空间（待查是不是在扫全表）。
12. **基准是绑实现的，实现变了基准必须跟着改，否则「变快」也会判 CHECK。** 2026-11-11 召回从逐条事务改成单事务批量读，首问 2,454 → 265 ms，五项判定里两项直接 CHECK（低于下界）。下界不能删 —— 它防的是「快得不正常」（没真读到数据也会很快）。判据是同时看 `吊坠排位` 和 `首屏卡片数`：那两个还 PASS 才说明数据真的进来了。
13. **改了 `app\web\src` 必须重新构建装包才生效**，压测连的是 APK 里的 `assets/public/assets/index.js`，不是磁盘上的源码。`app\build-apk.ps1` 一条命令搞定（vite build → gradle assembleDebug），装完 `adb install -r` 数据保留。验代码真进包了：`python -c "import zipfile;z=zipfile.ZipFile('app-debug.apk');print(z.read('assets/public/assets/index.js').decode().count('回退 listLatest'))"`，返回 1 就是新的。

## 四之二、单独跑一段脚本

不想整套场景时，用 `lib/run-page.mjs`：

```powershell
node lib/run-page.mjs page/counts.js
node lib/run-page.mjs page/purge-orphans.js                    # dry-run
node lib/run-page.mjs page/purge-orphans.js '{"apply":true}'   # 真删
```

它只跑一个文件、直接打印返回的 JSON，不出 md、不做判定。排查时用它，别去改 `run.mjs` 的场景表。

## 五、目录

```
_压测/
├─ run.mjs                入口：场景编排 + 判定 + 出 md
├─ lib/cdp.mjs            连 WebView；evaluate / reloadPage / shot
├─ lib/adb.mjs            自动 adb forward（pid 一变就重发，别手搓）
├─ lib/run-page.mjs       单跑一个 page/*.js，不出 md
├─ lib/prelude.js         注入页面的垫片（openDB / 各类 count）
├─ page/                  每个文件 = 一段在页面里跑的表达式
│  ├─ counts.js           数库
│  ├─ seed-memory.js      造 5,000 条记忆
│  ├─ seed-backup.js      造 message / memory / journal 三类
│  ├─ probe-recall.js     测召回（真实链路 + 分解成本）
│  ├─ probe-batch-read.js 两套读法对账：逐条事务 vs 单事务批量读
│  ├─ probe-list.js       测记忆列表首屏 / 翻页
│  ├─ probe-backup.js     测备份组包（顺带报 skipped 原因）
│  ├─ probe-journal.js    测手记：判该不该写 / 查今天 / 写一篇（写完自回滚）
│  ├─ purge-orphans.js    清孤儿 revision（默认 dry-run，要 apply:true 才删）
│  └─ clean.js            按前缀清场
└─ 结果/                  每次跑的 md
```

`page/*.js` 的写法固定：整个文件是一个 `(async (ARGS) => { ... })`，`run.mjs` 把它和 prelude 拼成 `(async () => { <prelude>; return await (<file>)(<args>) })()` 再喂给 `Runtime.evaluate`。
所以这些文件可以单独 `node --check`，但**不能**直接 `node` 运行（里面没有 Node API，只有页面 API）。
