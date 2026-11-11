# web 产物 ↔ 原生契约 交叉核对（M0 自动生成）

> 产物：autonomy-cavPmG33.js, dist-CMedSjkm.js, embedding-worker-gjfdPtme.js, main-CFFhpb4h.js, ort.wasm.bundle.min-DAwYOVSu.js, persona-CBp1pExX.js, persona-Dkk6mfxq.js, rolldown-runtime-D8NudN84.js, service-DGjhUELY.js, storage-worker-C5hDp6Bk.js, transformers.web-C3J9_dM3.js, web-BM7xF5pS.js

**插件 21 个 · web 里出现方法 105 个（含全量计数）· 契约里没被调用 3 个 · 完全没出现的插件 0 个**

| 插件 | 出现次数 | 用到的方法 | addListener |
|---|---|---|---|
| `EllenArchive` | 5 | 1 | 1 |
| `EllenAudio` | 9 | 5 | 0 |
| `EllenAutonomy` | 10 | 6 | 1 |
| `EllenBackground` | 7 | 5 | 0 |
| `EllenCallCapture` | 5 | 2 | 1 |
| `EllenCallProbe` | 5 | 1 | 4 |
| `EllenCallSession` | 5 | 5 | 1 |
| `EllenDocuments` | 5 | 1 | 0 |
| `EllenFeedbackHttp` | 5 | 2 | 1 |
| `EllenLicense` | 7 | 2 | 0 |
| `EllenLocalSpeech` | 5 | 2 | 0 |
| `EllenLocalSync` | 5 | 3 | 0 |
| `EllenMedia` | 7 | 6 | 0 |
| `EllenMini` | 8 | 0 | 0 |
| `EllenModelCatalogHttp` | 5 | 2 | 0 |
| `EllenMusic` | 5 | 2 | 0 |
| `EllenReleaseInfo` | 5 | 1 | 0 |
| `EllenScreenShell` | 5 | 1 | 0 |
| `EllenSecureConfig` | 5 | 2 | 0 |
| `EllenUpdates` | 5 | 1 | 1 |
| `EllenVoiceHttp` | 6 | 2 | 0 |

## 逐插件明细


### EllenArchive（5 处 / main-CFFhpb4h.js, persona-CBp1pExX.js, storage-worker-C5hDp6Bk.js）

用到：`cancel`

同窗口出现的其它插件方法（噪音/串联）：`configure`, `consumeOpen`, `foreground`, `organizationComplete`, `release`, `state`

### EllenAudio（9 处 / main-CFFhpb4h.js, persona-CBp1pExX.js, storage-worker-C5hDp6Bk.js）

用到：`capabilities`, `close`, `pause`, `play`, `setVolume`

同窗口出现的其它插件方法（噪音/串联）：`cancel`, `releaseSelections`

### EllenAutonomy（10 处 / autonomy-cavPmG33.js, main-CFFhpb4h.js, persona-CBp1pExX.js, storage-worker-C5hDp6Bk.js）

用到：`configure`, `consumeOpen`, `foreground`, `organizationComplete`, `release`, `state`

同窗口出现的其它插件方法（噪音/串联）：`cancel`

### EllenBackground（7 处 / main-CFFhpb4h.js, persona-CBp1pExX.js, storage-worker-C5hDp6Bk.js）

用到：`consumeOpen`, `requestPermission`, `state`, `stop`, `update`

同窗口出现的其它插件方法（噪音/串联）：`cancel`

### EllenCallCapture（5 处 / main-CFFhpb4h.js, persona-CBp1pExX.js, storage-worker-C5hDp6Bk.js）

用到：`close`, `releaseRecognizer`

### EllenCallProbe（5 处 / main-CFFhpb4h.js, persona-CBp1pExX.js, storage-worker-C5hDp6Bk.js）

用到：`close`

同窗口出现的其它插件方法（噪音/串联）：`releaseRecognizer`, `remove`

### EllenCallSession（5 处 / main-CFFhpb4h.js, persona-CBp1pExX.js, storage-worker-C5hDp6Bk.js）

用到：`close`, `start`, `state`, `stop`, `update`

同窗口出现的其它插件方法（噪音/串联）：`cancel`, `request`

### EllenDocuments（5 处 / main-CFFhpb4h.js, persona-CBp1pExX.js, storage-worker-C5hDp6Bk.js）

用到：`cancel`

### EllenFeedbackHttp（5 处 / main-CFFhpb4h.js, persona-CBp1pExX.js, storage-worker-C5hDp6Bk.js）

用到：`cancel`, `request`

同窗口出现的其它插件方法（噪音/串联）：`configure`, `consumeOpen`, `foreground`, `organizationComplete`, `release`, `state`

### EllenLicense（7 处 / persona-CBp1pExX.js, service-DGjhUELY.js, storage-worker-C5hDp6Bk.js）

用到：`activate`, `state`

### EllenLocalSpeech（5 处 / main-CFFhpb4h.js, persona-CBp1pExX.js, storage-worker-C5hDp6Bk.js）

用到：`cancel`, `close`

同窗口出现的其它插件方法（噪音/串联）：`capabilities`, `releaseSelections`

### EllenLocalSync（5 处 / main-CFFhpb4h.js, persona-CBp1pExX.js, storage-worker-C5hDp6Bk.js）

用到：`cancel`, `records`, `state`

### EllenMedia（7 处 / main-CFFhpb4h.js, persona-CBp1pExX.js, service-DGjhUELY.js, storage-worker-C5hDp6Bk.js）

用到：`cancel`, `capabilities`, `close`, `commit`, `releaseSelections`, `removeCachedFile`

### EllenMini（8 处 / persona-CBp1pExX.js, storage-worker-C5hDp6Bk.js）

用到：（窗口内没抓到，可能动态调用）

### EllenModelCatalogHttp（5 处 / main-CFFhpb4h.js, persona-CBp1pExX.js, storage-worker-C5hDp6Bk.js）

用到：`cancel`, `request`

同窗口出现的其它插件方法（噪音/串联）：`close`, `start`, `state`, `stop`, `update`

### EllenMusic（5 处 / main-CFFhpb4h.js, persona-CBp1pExX.js, storage-worker-C5hDp6Bk.js）

用到：`cancelImport`, `discard`

### EllenReleaseInfo（5 处 / main-CFFhpb4h.js, persona-CBp1pExX.js, storage-worker-C5hDp6Bk.js）

用到：`state`

同窗口出现的其它插件方法（噪音/串联）：`cancel`, `request`

### EllenScreenShell（5 处 / main-CFFhpb4h.js, persona-CBp1pExX.js, storage-worker-C5hDp6Bk.js）

用到：`setAppearance`

### EllenSecureConfig（5 处 / main-CFFhpb4h.js, persona-CBp1pExX.js, storage-worker-C5hDp6Bk.js）

用到：`read`, `write`

同窗口出现的其它插件方法（噪音/串联）：`close`

### EllenUpdates（5 处 / main-CFFhpb4h.js, persona-CBp1pExX.js, storage-worker-C5hDp6Bk.js）

用到：`cancel`

同窗口出现的其它插件方法（噪音/串联）：`close`, `remove`

### EllenVoiceHttp（6 处 / main-CFFhpb4h.js, persona-CBp1pExX.js, storage-worker-C5hDp6Bk.js）

用到：`cancel`, `requestStream`
