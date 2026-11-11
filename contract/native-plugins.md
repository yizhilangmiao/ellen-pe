# 手机版原生插件契约（M0 自动生成）

> 源：`E:\ailian\艾莲手机版\创作版\dexwork\smali-b17`　生成器：`_tools/dump_plugins.py`（重跑即刷新，勿手改）

**插件 28 个 · 方法 826 个 · `@PluginMethod` 195 个**

覆盖率：带 options 82 个 · 带 events 1 个 · 带 resolve/reject 键 112 个 · option 键合计 151 · 事件名合计 1

| 插件 | @PluginMethod | 全部方法 | smali | 静态常量 |
|---|---|---|---|---|
| `EllenMedia` | 33 | 130 | 252 KB | 0 |
| `EllenAudio` | 21 | 86 | 159 KB | 0 |
| `EllenArchive` | 11 | 63 | 117 KB | 0 |
| `EllenBackground` | 11 | 30 | 38 KB | 0 |
| `EllenCallCapture` | 11 | 79 | 176 KB | 2 |
| `EllenMini` | 11 | 38 | 31 KB | 0 |
| `EllenMusic` | 9 | 34 | 63 KB | 2 |
| `EllenAutonomy` | 8 | 30 | 39 KB | 0 |
| `EllenLocalSync` | 8 | 19 | 70 KB | 1 |
| `App` | 7 | 22 | 20 KB | 6 |
| `CapacitorHttp` | 6 | 11 | 9 KB | 0 |
| `EllenVoiceHttp` | 6 | 42 | 112 KB | 0 |
| `CapacitorCookies` | 5 | 11 | 13 KB | 0 |
| `EllenCallProbe` | 5 | 41 | 108 KB | 2 |
| `EllenCallSession` | 5 | 27 | 24 KB | 0 |
| `EllenUpdates` | 5 | 21 | 17 KB | 0 |
| `EllenDiagnostics` | 4 | 15 | 24 KB | 0 |
| `EllenLocalSpeech` | 4 | 25 | 61 KB | 1 |
| `SystemBars` | 4 | 31 | 38 KB | 9 |
| `WebView` | 4 | 5 | 4 KB | 2 |
| `EllenDocuments` | 3 | 13 | 32 KB | 0 |
| `EllenModelHttp` | 3 | 10 | 6 KB | 0 |
| `EllenSecureConfig` | 3 | 8 | 20 KB | 0 |
| `EllenFeedbackHttp` | 2 | 9 | 29 KB | 2 |
| `EllenLicense` | 2 | 3 | 3 KB | 0 |
| `EllenModelCatalogHttp` | 2 | 8 | 23 KB | 0 |
| `EllenReleaseInfo` | 1 | 2 | 5 KB | 0 |
| `EllenScreenShell` | 1 | 13 | 15 KB | 0 |


## EllenMedia — `dev.ellen.mobile.media.EllenMediaPlugin`

| 方法 | 参数 | 返回注解 | options | events | resolve/reject |
|---|---|---|---|---|---|
| `beginReceive` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId |  | reject:MODULE_CLOSED, reject:DUPLICATE_REQUEST |
| `cancel` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId |  | reject:CANCELLED |
| `capabilities` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `captureScreen` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:MODULE_CLOSED, reject:MEDIA_BUSY |
| `close` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId |  | reject:CANCELLED |
| `commit` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId |  | reject:MODULE_CLOSED, reject:DUPLICATE_REQUEST |
| `commitAppearance` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId |  | reject:MODULE_CLOSED, reject:DUPLICATE_REQUEST |
| `commitFile` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId |  | reject:MODULE_CLOSED, reject:DUPLICATE_REQUEST |
| `describe` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId |  | reject:MODULE_CLOSED, reject:DUPLICATE_REQUEST |
| `describeAppearance` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId |  | reject:MODULE_CLOSED, reject:DUPLICATE_REQUEST |
| `discard` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId |  | reject:MODULE_CLOSED, reject:DUPLICATE_REQUEST |
| `discardAppearance` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId |  | reject:MODULE_CLOSED, reject:DUPLICATE_REQUEST |
| `discardReceive` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId |  | reject:MODULE_CLOSED, reject:DUPLICATE_REQUEST |
| `extractVideoAudio` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId |  | reject:MODULE_CLOSED, reject:DUPLICATE_REQUEST |
| `finishReceive` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId |  | reject:MODULE_CLOSED, reject:DUPLICATE_REQUEST |
| `has` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId |  | reject:MODULE_CLOSED, reject:DUPLICATE_REQUEST |
| `loadVideo` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `pasteImage` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:MODULE_CLOSED |
| `pauseVideo` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `pick` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:MODULE_CLOSED, reject:MEDIA_BUSY, reject:MEDIA_OPERATION_FAILED |
| `pickAlbum` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:MODULE_CLOSED, reject:MEDIA_BUSY |
| `playVideo` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `prepare` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:selectionToken, getBoolean:retainSelection, getString:requestId |  | reject:INVALID_SELECTION, reject:MODULE_CLOSED, reject:DUPLICATE_REQUEST |
| `preview` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId |  | reject:MODULE_CLOSED, reject:DUPLICATE_REQUEST |
| `readAppearanceChunk` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId |  | reject:MODULE_CLOSED, reject:DUPLICATE_REQUEST |
| `readChunk` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId |  | reject:MODULE_CLOSED, reject:DUPLICATE_REQUEST |
| `readFrames` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId |  | reject:MODULE_CLOSED, reject:DUPLICATE_REQUEST |
| `releaseSelections` | `(Lcom/getcapacitor/PluginCall;)V` |  | getArray:tokens |  | reject:MEDIA_OPERATION_FAILED |
| `releaseVideo` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `removeAppearance` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId |  | reject:MODULE_CLOSED, reject:DUPLICATE_REQUEST |
| `removeCachedFile` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId |  | reject:MODULE_CLOSED, reject:DUPLICATE_REQUEST |
| `writeAppearance` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId |  | reject:MODULE_CLOSED, reject:DUPLICATE_REQUEST |
| `writeChunk` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId |  | reject:MODULE_CLOSED, reject:DUPLICATE_REQUEST |

> 非 `@PluginMethod`：`$r8$lambda$0GKvZsXXrHZcF02Kd6YelOGcjbQ`, `$r8$lambda$3H3MvaYpiSh4sQ_96kAQCgOfrNE`, `$r8$lambda$416F7IkuxtrY4wlv4ngMmucSUiA`, `$r8$lambda$4scdPJP2l5LCHKX9y1HNG1d5my4`, `$r8$lambda$6fTw1UTXfOj2CGvjWa1bH_3S34M`, `$r8$lambda$6o4t8Mzrwa14oolWufEm5oKo4zI`, `$r8$lambda$72RXGLpziGZ562ZPLBklT96duw4`, `$r8$lambda$8nclRdcKwWDPGiActPHcyrnOwkc`, `$r8$lambda$EQGtU6lr521k2grjG2DHVQk3qxU`, `$r8$lambda$HnPHzlW4bb5509dkICtbx53i1LE`, `$r8$lambda$KyJvwGC3MGcHkCoQCfB_bOuPfa8`, `$r8$lambda$M0Vz9ZcwSf_XbB6CoKsJadZmA4E`, `$r8$lambda$O4QgN2t_oGBMmjyr7rDodlbJOBU`, `$r8$lambda$O9mNxwAwWVh1ZTaYTjZtKRbCW0s`, `$r8$lambda$RosShA9tE4mMwg6n4LPHGzAfPZw`, `$r8$lambda$SfbiE0nC3olE6XKipt5l1YOWZ8k`, `$r8$lambda$UjFm8h2sSXRbRNV06Gn7fFxgiUo`, `$r8$lambda$VByAyUlOBkGpLFXU45c5TcNhpLM`, `$r8$lambda$VcJ07ShuSyADof3cN0jXkI3P3Ec`, `$r8$lambda$YonvbrHpPnMmgC_AK93mAKgaMsY`, `$r8$lambda$Zwfir_KFbNyJvDnAH6T8Qunfmqs`, `$r8$lambda$f8cjvc8SfgIBIYTnsXiqVx1lQfU`, `$r8$lambda$gTJB5WRGairLXSYIHwDWpfrRYm0`, `$r8$lambda$hOvvZNfKzHIq49eAoC0zxfnIwug`, `$r8$lambda$pYolfZPs3fqU5yFIkgor7yjLu28`, `$r8$lambda$qKVGhoMEB3i1iFhCdZyMaL1Q474`, `$r8$lambda$vI56hBz658W2efd5tdy0Ir3DRXk`, `$r8$lambda$wdLZ3w0WzmUJtpgwAhciYFamVvY`, `<init>`, `albumAccess`, `albumAccessResult`, `appearanceId`, `appearanceStore`, `cancelAlbum`, `cancelJobs`, `captureApproved`, `checkCancelled`, `json`, `lambda$albumAccessResult$2`, `lambda$beginReceive$32`, `lambda$cancel$26`, `lambda$cancel$27`, `lambda$cancel$28`, `lambda$captureScreen$5`, `lambda$captureScreen$6`, `lambda$close$42`, `lambda$close$43`, `lambda$commit$36`, `lambda$commitAppearance$14`, `lambda$commitFile$37`, `lambda$describe$29`, `lambda$describeAppearance$12`, `lambda$discard$38`, `lambda$discardAppearance$15`, `lambda$discardReceive$35`, `lambda$extractVideoAudio$17`, `lambda$extractVideoAudio$18`, `lambda$finishReceive$34`, `lambda$handleOnDestroy$45`, `lambda$handleOnStop$44`, `lambda$has$30`, `lambda$loadVideo$19`, `lambda$loadVideo$20`, `lambda$loadVideo$21`, `lambda$loadVideo$22`, `lambda$pasteImage$3`, `lambda$pasteImage$4`, `lambda$pauseVideo$24`, `lambda$pickAlbum$1`, `lambda$picked$7`, `lambda$playVideo$23`, `lambda$prepare$10`, `lambda$prepare$8`, `lambda$prepare$9`, `lambda$preview$40`, `lambda$readAppearanceChunk$13`, `lambda$readChunk$31`, `lambda$readFrames$41`, `lambda$releaseVideo$25`, `lambda$removeAppearance$16`, `lambda$removeCachedFile$39`, `lambda$run$0`, `lambda$writeAppearance$11`, `lambda$writeChunk$33`, `main`, `picked`, `reject`, `releaseAllSelections`, `releaseSelection`, `releaseVideo`, `requestAlbumAccess`, `run`, `showAlbum`, `store`, `videoEvent`, `handleOnDestroy`, `handleOnStop`

## EllenAudio — `dev.ellen.mobile.audio.EllenAudioPlugin`

| 方法 | 参数 | 返回注解 | options | events | resolve/reject |
|---|---|---|---|---|---|
| `appendCallPcm` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `cancelRecording` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:recordingId |  | reject:CANCELLED |
| `capabilities` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `close` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:CANCELLED |
| `finishCallPcm` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `loadAudio` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:purpose, getString:sessionId, getString:slotId, getString:\u5e94\u7528\u5df2\u8fdb\u5165\u540e\u53f0\u6216\u901a\u8bdd\u4f1a\u8bdd\u5df2\u7ed3\u675f\u3002 |  | reject:MODULE_CLOSED, reject:CANCELLED, reject:DUPLICATE_PLAYBACK, reject:AUDIO_OPERATION_FAILED |
| `loadCallSound` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `openCallPcm` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `pause` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `pauseCallPcm` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `play` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `playCallPcm` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `releaseAudio` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `releaseCallPcm` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:CANCELLED |
| `releaseRecording` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `setLoop` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `setVolume` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `startRecording` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:recordingId, getString:fileId |  | reject:LICENSE_REQUIRED, reject:MODULE_CLOSED, reject:CANCELLED, reject:VOICE_BUSY, resolve:fileId, reject:AUDIO_OPERATION_FAILED |
| `stopRecording` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `transcribe` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:LOCAL_ASR_UNAVAILABLE |
| `volumeCallPcm` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |

> 非 `@PluginMethod`：`$r8$lambda$0pyI0f5a5yWmo1HFNKXvgveuGFc`, `$r8$lambda$B5C8UWZQsaaEClYk9fbhf4ywnpg`, `$r8$lambda$ExgKzgIpHwhPnLwARIAocD2o2DI`, `$r8$lambda$FyKfOYljKga8BHL0_ovep3BW7tY`, `$r8$lambda$IKrxaZ6aR7aZMjUeoELcGczvjJ8`, `$r8$lambda$Kj5Jno9oBC1LLHIsGVs9EUbCnoE`, `$r8$lambda$OA8LSuxWKGEV6WJA40jmTECAz8Y`, `$r8$lambda$OcQRIG3e3xg0NDXRuLAUp7TBK44`, `$r8$lambda$TVaBKrIcG0IvfnV8EgT6R29Z1iU`, `$r8$lambda$_S3_kdY1UrXSbUe5vHlNyQ5DKdY`, `$r8$lambda$d4ExQAgghpv9mO9gsz3HiOBjTNU`, `$r8$lambda$f8cjvc8SfgIBIYTnsXiqVx1lQfU`, `$r8$lambda$iQfIDufPxs5T6IWHkysFg5mDAhg`, `$r8$lambda$jlCnpoHcb83ZO67gDl98fR8WU0k`, `$r8$lambda$oRBWAW_sWO_WCsImG0IO9LsTJ5s`, `$r8$lambda$wwI5F01xzGz1RzkRWjWa61JPAEc`, `<init>`, `abandonFocus`, `beginCapture`, `event`, `failure`, `focus`, `halt`, `lambda$abandonFocus$7`, `lambda$beginCapture$3`, `lambda$close$24`, `lambda$close$25`, `lambda$focus$6`, `lambda$handleOnStop$26`, `lambda$handleOnStop$27`, `lambda$load$0`, `lambda$load$1`, `lambda$loadAudio$10`, `lambda$loadAudio$11`, `lambda$loadAudio$12`, `lambda$loadAudio$13`, `lambda$loadAudio$8`, `lambda$loadAudio$9`, `lambda$loadCallSound$14`, `lambda$loadCallSound$15`, `lambda$loadCallSound$16`, `lambda$loadCallSound$17`, `lambda$loadCallSound$18`, `lambda$pause$20`, `lambda$play$19`, `lambda$recordingLevel$2`, `lambda$releaseAudio$23`, `lambda$releaseRecording$5`, `lambda$setLoop$22`, `lambda$setVolume$21`, `lambda$stopRecording$4`, `le`, `main`, `microphoneResult`, `playbackAllowed`, `playbackReceipt`, `recordingLevel`, `release`, `stopPlayback`, `store`, `wavHeader`, `handleOnDestroy`, `handleOnStart`, `handleOnStop`, `load`

## EllenArchive — `dev.ellen.mobile.platform.EllenArchivePlugin`

| 方法 | 参数 | 返回注解 | options | events | resolve/reject |
|---|---|---|---|---|---|
| `background` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `backupCall` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:ARCHIVE_CLOSED, reject:ARCHIVE_BUSY |
| `cancel` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:CANCELLED |
| `cancelBackup` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `chooseBackupDirectory` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:ARCHIVE_CLOSED, reject:ARCHIVE_BUSY |
| `createExport` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:ARCHIVE_CLOSED, reject:ARCHIVE_BUSY |
| `discard` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:ARCHIVE_CLOSED, reject:ARCHIVE_BUSY |
| `pickImport` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:ARCHIVE_CLOSED, reject:ARCHIVE_BUSY, reject:CANCELLED |
| `readImport` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:ARCHIVE_CLOSED, reject:ARCHIVE_BUSY |
| `saveExport` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:ARCHIVE_CLOSED, reject:ARCHIVE_BUSY |
| `writeExport` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:ARCHIVE_CLOSED, reject:ARCHIVE_BUSY |

> 非 `@PluginMethod`：`$r8$lambda$5wpQJ07BQbtzvNbQDZIboi_ffWQ`, `$r8$lambda$80r_83jErde9cH5_1n16abxK5Rw`, `$r8$lambda$DquFCi94jPjOMe1mQM8OufxGjMQ`, `$r8$lambda$DrkM_Ll0BvkZG8kz_XzqcagoLe0`, `$r8$lambda$TGXpx5rTz6ykBV1w0CxdrDDQKGw`, `$r8$lambda$UHF6fAP4PwrJXYGAzGmYcxDjlqc`, `$r8$lambda$Ypbwf54kChVjjwPpFNIoX_1B4Fw`, `$r8$lambda$dcYGv3lqoGAfZ8_oNeXs56P4Hiw`, `$r8$lambda$iKS4JdpKKEBUYwcdigskdZRFb_4`, `$r8$lambda$sVoxV7g8WWirYUGIaP3DiNUUIXw`, `$r8$lambda$yCPSrnPzQqqdsHmXqLwmpxf01Mo`, `<clinit>`, `<init>`, `backupDirectoryPicked`, `begin`, `cancelCurrent`, `check`, `cleanup`, `create`, `digest`, `displayName`, `entries`, `execute`, `finish`, `hex`, `integer`, `lambda$backupCall$10`, `lambda$backupCall$9`, `lambda$backupDirectoryPicked$11`, `lambda$cancel$12`, `lambda$createExport$1`, `lambda$discard$8`, `lambda$execute$0`, `lambda$handleOnDestroy$14`, `lambda$handleOnStop$13`, `lambda$picked$6`, `lambda$picker$3`, `lambda$readImport$7`, `lambda$saveExport$4`, `lambda$saved$5`, `lambda$writeExport$2`, `name`, `picked`, `picker`, `reject`, `require`, `saved`, `selected`, `submit`, `handleOnDestroy`, `handleOnStop`, `load`

## EllenBackground — `dev.ellen.mobile.platform.EllenBackgroundPlugin`

| 方法 | 参数 | 返回注解 | options | events | resolve/reject |
|---|---|---|---|---|---|
| `close` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `consumeMessageOpen` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `consumeOpen` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `messageArrived` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `messageContext` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `notificationSettings` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `requestInitialPermission` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `requestPermission` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:NOTIFICATION_STORAGE |
| `state` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `stop` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `update` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:sessionId, getString:threadId, getBoolean:replyActive, getBoolean:mediaActive, getBoolean:paused, getBoolean:organizationActive, getInt:organizationTotal, getInt:organizationDone, getString:organizationProfileId |  | reject:BACKGROUND_CLOSED, reject:INVALID_BACKGROUND_WORK |

> 非 `@PluginMethod`：`$r8$lambda$5tZAgq9yahFCkeVJRi_rq588U7M`, `$r8$lambda$QwNksHNzCuKUnq_14TZdTMdt83E`, `$r8$lambda$TZOsCMkVV3ypbzbkRG3xhXfBxzw`, `<init>`, `lambda$consumeMessageOpen$7`, `lambda$consumeOpen$8`, `lambda$load$0`, `lambda$messageArrived$5`, `lambda$messageContext$4`, `lambda$notificationSettings$6`, `lambda$state$1`, `lambda$stop$3`, `lambda$update$2`, `notificationResult`, `rememberOpen`, `stateValue`, `handleOnDestroy`, `handleOnNewIntent`, `load`

## EllenCallCapture — `dev.ellen.mobile.audio.EllenCallCapturePlugin`

静态常量：
- `MODEL` = `local-vad/silero_vad.onnx`
- `MODEL_SHA` = `9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6`

| 方法 | 参数 | 返回注解 | options | events | resolve/reject |
|---|---|---|---|---|---|
| `cancel` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId, getString:captureId |  | reject:CANCELLED |
| `close` | `(Lcom/getcapacitor/PluginCall;)V` |  |  | callCaptureEvent | reject:CANCELLED |
| `debugProcess` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:captureId, getString:fileRef, getString:sha256, getString:sessionId, getString:ownerId |  | reject:LOCAL_VAD_UNAVAILABLE |
| `prepare` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId, getString:ownerId |  | reject:LOCAL_VAD_UNAVAILABLE |
| `ready` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId, getString:ownerId |  | reject:LOCAL_VAD_UNAVAILABLE |
| `readyRecognizer` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId, getString:sessionId |  | reject:LOCAL_VAD_UNAVAILABLE |
| `release` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:captureId |  |  |
| `releasePreparation` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:ownerId |  | reject:LOCAL_VAD_UNAVAILABLE |
| `releaseRecognizer` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `start` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:captureId, getString:sessionId, getString:ownerId |  | reject:LOCAL_VAD_UNAVAILABLE |
| `transcribeRecognizer` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId, getString:sessionId |  | reject:LOCAL_VAD_UNAVAILABLE |

> 非 `@PluginMethod`：`$r8$lambda$0J4i_g1fJvK86DQkuYaNcNMzLPc`, `$r8$lambda$4dtaValdY3fyA93iJoJ14wR9HbY`, `$r8$lambda$8FkimftW2E1MCOXr4ZTV_UZLql8`, `$r8$lambda$ES18LHI8gkmi8yWjhcMKT4hA69o`, `$r8$lambda$F2pXkDTButXiSXFUQD3HOyRLewc`, `$r8$lambda$NmQAuc2zakP2jnFsEPF99dAgIjw`, `$r8$lambda$Y1JvTjoMJ43s47w_xg9KO07TNvU`, `$r8$lambda$a2o1kPOeHVFpq3DlfEldBnly1dc`, `$r8$lambda$f8cjvc8SfgIBIYTnsXiqVx1lQfU`, `$r8$lambda$qX302f2UoBK19nvdpdi7Rzwup00`, `$r8$lambda$t0hBsuchm9lFfTvofmA7iESOFOs`, `$r8$lambda$t67isXQQOJ2YicI1goZqId6CUws`, `$r8$lambda$zHdpPUDDvWz65yoGnhFmalljvwI`, `<clinit>`, `<init>`, `allowed`, `begin`, `blockedCode`, `cancelCapture`, `cancelled`, `check`, `checkOwner`, `cleanup`, `clearPrepared`, `event`, `interruptionCode`, `keys`, `lambda$begin$7`, `lambda$close$14`, `lambda$handleOnDestroy$16`, `lambda$handleOnDestroy$17`, `lambda$prepareReady$4`, `lambda$prepareReady$5`, `lambda$process$10`, `lambda$process$11`, `lambda$process$12`, `lambda$process$8`, `lambda$process$9`, `lambda$recognize$1`, `lambda$recognize$2`, `lambda$recognize$3`, `lambda$release$13`, `lambda$releasePreparation$6`, `lambda$releasePreparedWhenInactive$15`, `lambda$releaseRecognizer$0`, `microphoneResult`, `model`, `prepareCancelled`, `prepareReady`, `process`, `readyMicrophoneResult`, `recognition`, `recognitionReady`, `recognize`, `reject`, `releaseHardware`, `releasePreparedWhenInactive`, `requestReady`, `returnPrepared`, `stopForCallSession`, `stopNative`, `stopSessionCapture`, `store`, `takePrepared`, `handleOnDestroy`, `handleOnStart`, `handleOnStop`, `load`

## EllenMini — `dev.ellen.mobile.platform.EllenMiniPlugin`

| 方法 | 参数 | 返回注解 | options | events | resolve/reject |
|---|---|---|---|---|---|
| `cancelPermission` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `claim` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `close` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `consumeOpen` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `minimize` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `present` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `requestOverlayPermission` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:MINI_BUSY, reject:MINI_PERMISSION_UNAVAILABLE, reject:APP_BACKGROUND |
| `result` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `start` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:INVALID_MINI_ACTION, reject:APP_BACKGROUND |
| `state` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `stop` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |

> 非 `@PluginMethod`：`$r8$lambda$0g0tlavoe34r63cvfzZraJSIS04`, `$r8$lambda$8VhTFB3LEwyUi9B1rX9romJYYfA`, `$r8$lambda$QCUEzlGOWXfhWUbQ0Du15rTj7MI`, `$r8$lambda$SN8famrZ0jWx26RnBvxccEiW4Q8`, `$r8$lambda$V5BjjsK2J0jfmWCJsUj3wptVDfw`, `$r8$lambda$ftQazQRmVdpDWsQawYhz_Xkj0pQ`, `$r8$lambda$hmcFx4OISMx2Pn1G_ruO2nh8ZQQ`, `$r8$lambda$pHyY84TtzMdkgQ86l6gjEghFlD8`, `<init>`, `lambda$cancelPermission$8`, `lambda$claim$6`, `lambda$close$9`, `lambda$handleOnStart$10`, `lambda$load$0`, `lambda$minimize$4`, `lambda$present$5`, `lambda$result$7`, `lambda$start$1`, `lambda$start$2`, `lambda$stop$3`, `permissionResult`, `remember`, `handleOnDestroy`, `handleOnNewIntent`, `handleOnStart`, `handleOnStop`, `load`

## EllenMusic — `dev.ellen.mobile.audio.EllenMusicPlugin`

静态常量：
- `DEFAULT_ID` = `ellen-music-default-v1`
- `DEFAULT_SHA` = `6de411076df38c518178f7dcc215342e77d8736f2a8804fc621ec5c9ef00f174`

| 方法 | 参数 | 返回注解 | options | events | resolve/reject |
|---|---|---|---|---|---|
| `cancelImport` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId |  | reject:CANCELLED |
| `cancelPick` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId |  | reject:CANCELLED |
| `close` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:CANCELLED |
| `commit` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `describe` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId |  | reject:MODULE_CLOSED, reject:DUPLICATE_REQUEST, reject:MUSIC_OPERATION_FAILED |
| `discard` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `ensureDefault` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId |  | reject:MODULE_CLOSED, reject:DUPLICATE_REQUEST, reject:MUSIC_OPERATION_FAILED |
| `importSelection` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:selectionToken, getString:requestId |  | reject:INVALID_SELECTION, reject:MODULE_CLOSED, reject:DUPLICATE_REQUEST, reject:MUSIC_OPERATION_FAILED |
| `pick` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId |  | reject:MODULE_CLOSED, reject:MUSIC_BUSY, reject:MUSIC_OPERATION_FAILED |

> 非 `@PluginMethod`：`$r8$lambda$2OwTlKCw0gi66d3vAeH3GVw5yQs`, `$r8$lambda$ULIDYmnBPSvPUjkQSKqpiebjkEc`, `$r8$lambda$f8cjvc8SfgIBIYTnsXiqVx1lQfU`, `$r8$lambda$fx0IIXbA4QFnLfL24Jl_Urj2T6k`, `<init>`, `cancel`, `cancelAll`, `check`, `cleanup`, `duration`, `lambda$cleanup$1`, `lambda$close$8`, `lambda$commit$6`, `lambda$describe$5`, `lambda$discard$7`, `lambda$ensureDefault$2`, `lambda$importSelection$3`, `lambda$importSelection$4`, `lambda$run$0`, `picked`, `reject`, `run`, `store`, `track`, `handleOnDestroy`

## EllenAutonomy — `dev.ellen.mobile.platform.EllenAutonomyPlugin`

| 方法 | 参数 | 返回注解 | options | events | resolve/reject |
|---|---|---|---|---|---|
| `configure` | `(Lcom/getcapacitor/PluginCall;)V` |  | getBoolean:enabled, getString:profileId |  | reject:INVALID_AUTONOMY_SETTINGS |
| `consumeOpen` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `foreground` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `organizationComplete` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:profileId, getString:jobId, getInt:done, getInt:review |  | reject:INVALID_ORGANIZATION_NOTICE |
| `release` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:INVALID_UI_LEASE |
| `requestBackgroundPermission` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `requestInitialBackgroundPermission` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `state` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |

> 非 `@PluginMethod`：`$r8$lambda$4Wdbwxw43oqQ1N_tV7RUY0gXOpk`, `$r8$lambda$4zBRiQnYtxOQvIS4w8GXnYu5tg0`, `$r8$lambda$YEEldYMcHSaA0A61AUuMgt1cT1U`, `$r8$lambda$l_d9Oqi6NFhN9YXArU8crObobZg`, `$r8$lambda$zG_hJ8Wx0RuKBuE9blYR8U5Kpak`, `<init>`, `lambda$configure$5`, `lambda$consumeOpen$9`, `lambda$foreground$6`, `lambda$foreground$7`, `lambda$organizationComplete$4`, `lambda$release$8`, `lambda$requestBackgroundPermission$2`, `lambda$requestInitialBackgroundPermission$1`, `lambda$state$0`, `lambda$systemPowerTarget$3`, `openPowerSettings`, `powerResult`, `rememberOpen`, `systemPowerTarget`, `handleOnNewIntent`, `load`

## EllenLocalSync — `dev.ellen.mobile.platform.EllenLocalSyncPlugin`

静态常量：
- `RECORD_PROTOCOL` = `ellen-record-stream-v1`

| 方法 | 参数 | 返回注解 | options | events | resolve/reject |
|---|---|---|---|---|---|
| `cancel` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `capabilities` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:SYNC_BUSY |
| `exchange` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:SYNC_BUSY |
| `media` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:SYNC_BUSY |
| `pair` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:SYNC_BUSY |
| `records` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:SYNC_BUSY |
| `state` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:PAIR_STORAGE_FAILED |
| `unpair` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:SYNC_BUSY |

> 非 `@PluginMethod`：`$r8$lambda$ibpWbfLBUSWToiF_9q_shOs9bfw`, `<init>`, `applyCapabilities`, `communicate`, `lambda$run$0`, `run`, `validate`, `vault`, `versionOne`, `view`, `handleOnDestroy`

## App — `com.capacitorjs.plugins.app.AppPlugin`

静态常量：
- `EVENT_BACK_BUTTON` = `backButton`
- `EVENT_PAUSE` = `pause`
- `EVENT_RESTORED_RESULT` = `appRestoredResult`
- `EVENT_RESUME` = `resume`
- `EVENT_STATE_CHANGE` = `appStateChange`
- `EVENT_URL_OPEN` = `appUrlOpen`

| 方法 | 参数 | 返回注解 | options | events | resolve/reject |
|---|---|---|---|---|---|
| `exitApp` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `getAppLanguage` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `getInfo` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:Unable to get App Info |
| `getLaunchUrl` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `getState` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `minimizeApp` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `toggleBackButtonHandler` | `(Lcom/getcapacitor/PluginCall;)V` |  | getBoolean:enabled |  | reject:onBackPressedCallback is not set |

> 非 `@PluginMethod`：`<init>`, `access$000`, `access$100`, `access$200`, `access$300`, `access$400`, `access$500`, `lambda$load$0`, `lambda$load$1`, `unsetAppListeners`, `handleOnDestroy`, `handleOnNewIntent`, `handleOnPause`, `handleOnResume`, `load`

## CapacitorHttp — `com.getcapacitor.plugin.CapacitorHttp`

| 方法 | 参数 | 返回注解 | options | events | resolve/reject |
|---|---|---|---|---|---|
| `delete` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:Failed to execute request - Http Plugin was shutdown |
| `get` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:Failed to execute request - Http Plugin was shutdown |
| `patch` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:Failed to execute request - Http Plugin was shutdown |
| `post` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:Failed to execute request - Http Plugin was shutdown |
| `put` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:Failed to execute request - Http Plugin was shutdown |
| `request` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:Failed to execute request - Http Plugin was shutdown |

> 非 `@PluginMethod`：`<init>`, `http`, `handleOnDestroy`, `isEnabled`, `load`

## EllenVoiceHttp — `dev.ellen.mobile.platform.EllenVoiceHttpPlugin`

| 方法 | 参数 | 返回注解 | options | events | resolve/reject |
|---|---|---|---|---|---|
| `ackStream` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId, getInt:sequence |  | reject:INVALID_VOICE_REQUEST |
| `cancel` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId, getBoolean:waitForRelease |  | reject:VOICE_CLEANUP_FAILED |
| `request` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId, getString:body, getString:apiKey, getString:url, getString:sessionId |  | reject:LICENSE_REQUIRED, reject:CALL_SESSION_ENDED, reject:VOICE_HTTP_BUSY, reject:INVALID_VOICE_REQUEST |
| `requestStream` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId, getString:body, getString:apiKey, getString:url, getString:sessionId |  | reject:LICENSE_REQUIRED, reject:CALL_SESSION_ENDED, reject:CANCELLED, reject:VOICE_HTTP_BUSY, reject:INVALID_VOICE_REQUEST |
| `sourceInfo` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId |  | reject:INVALID_VOICE_REQUEST, reject:VOICE_HTTP_BUSY |
| `upload` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId, getString:kind, getString:apiKey |  | reject:LICENSE_REQUIRED, reject:INVALID_VOICE_REQUEST, reject:VOICE_HTTP_BUSY |

> 非 `@PluginMethod`：`$r8$lambda$Us6x_U_sBizhAJdjR24a0weS4ds`, `$r8$lambda$WYFW59vtpzt2s8p1WMRFutmtrr4`, `$r8$lambda$gauhQu8Iy7h2CQY4BlATxdElXiY`, `$r8$lambda$vx3NSmPzhzjAIQuW1DTPWpHISzA`, `$r8$lambda$zIct8wpJjdV79dlmGSpnk8GFceQ`, `<clinit>`, `<init>`, `begin`, `canBegin`, `check`, `checkedSources`, `endpoint`, `fail`, `failureCode`, `lambda$begin$0`, `lambda$checkedSources$2`, `lambda$request$5`, `lambda$requestStream$6`, `lambda$requestStream$7`, `lambda$sourceInfo$3`, `lambda$upload$4`, `lambda$watchLicense$1`, `perform`, `performStream`, `performUpload`, `release`, `response`, `stopForCallSession`, `streamEvent`, `validId`, `validKey`, `watchLicense`, `handleOnDestroy`, `handleOnStop`, `load`, `openConnection`

## CapacitorCookies — `com.getcapacitor.plugin.CapacitorCookies`

| 方法 | 参数 | 返回注解 | options | events | resolve/reject |
|---|---|---|---|---|---|
| `clearAllCookies` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `clearCookies` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:url, getString:key, getString:value, getString:expires, getString:/ |  | reject:Must provide key, reject:Must provide value |
| `deleteCookie` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:key, getString:url, getString:value, getString:expires, getString:/ |  | reject:Must provide key, reject:Must provide value |
| `getCookies` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `setCookie` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:key, getString:value, getString:url, getString:expires, getString:/ |  | reject:Must provide key, reject:Must provide value |

> 非 `@PluginMethod`：`<init>`, `lambda$getCookies$0`, `handleOnDestroy`, `isEnabled`, `load`, `setCookie`

## EllenCallProbe — `dev.ellen.mobile.audio.EllenCallProbePlugin`

静态常量：
- `HASH` = `9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6`
- `MODEL` = `local-vad/silero_vad.onnx`

| 方法 | 参数 | 返回注解 | options | events | resolve/reject |
|---|---|---|---|---|---|
| `cancelProbe` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:probeId, getString:sessionId, getString:replyId |  | reject:CALL_PROBE_FAILED |
| `close` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `probeCapabilities` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId |  | resolve:unknown, reject:CALL_PROBE_FAILED |
| `releaseProbe` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:probeId, getString:sessionId, getString:replyId |  | reject:CALL_PROBE_FAILED |
| `startProbe` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:CALL_PROBE_FAILED |

> 非 `@PluginMethod`：`$r8$lambda$98OweZQ1EF6rPQNkdVpSTDd4mQ8`, `$r8$lambda$Hmd1aYhQ7FAToIUl9c51x0rf9SY`, `$r8$lambda$J5Zd0wYDn44XvveWfbTLaxrb2Qc`, `$r8$lambda$URb7Uq40oRTm3v13ixYBIuuXVQw`, `$r8$lambda$f8cjvc8SfgIBIYTnsXiqVx1lQfU`, `<clinit>`, `<init>`, `cancel`, `check`, `cleanup`, `controlReceipt`, `emit`, `fresh`, `hardware`, `id`, `identity`, `integer`, `keys`, `lambda$close$4`, `lambda$handleOnDestroy$5`, `lambda$model$1`, `lambda$process$2`, `lambda$releaseProbe$3`, `lambda$startProbe$0`, `matching`, `model`, `pairedInput`, `process`, `publishFrame`, `read`, `reject`, `sessionAllowed`, `stopForCallSession`, `store`, `handleOnDestroy`, `load`

## EllenCallSession — `dev.ellen.mobile.platform.EllenCallSessionPlugin`

| 方法 | 参数 | 返回注解 | options | events | resolve/reject |
|---|---|---|---|---|---|
| `close` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `start` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `state` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `stop` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `update` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |

> 非 `@PluginMethod`：`$r8$lambda$IBXvCVgiqvq6N9Yq1wlbVglDrrc`, `$r8$lambda$IohfXP6HXtOKP5PaeQy87xQwuS0`, `$r8$lambda$SYCVPLuLchplrCmcKeGpy3hu2Es`, `$r8$lambda$oBlFr50FrCPdtjsmRUogKV8PR60`, `$r8$lambda$ofENTGK1J6QJsjREIurnFAFkUYE`, `<init>`, `id`, `lambda$close$6`, `lambda$load$0`, `lambda$start$1`, `lambda$start$2`, `lambda$state$5`, `lambda$stop$4`, `lambda$update$3`, `microphoneResult`, `resolve`, `withPermission`, `handleOnDestroy`, `handleOnNewIntent`, `handleOnPause`, `handleOnResume`, `load`

## EllenUpdates — `dev.ellen.mobile.platform.EllenUpdatesPlugin`

| 方法 | 参数 | 返回注解 | options | events | resolve/reject |
|---|---|---|---|---|---|
| `cancel` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:UPDATE_UNAVAILABLE |
| `check` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:UPDATE_BUSY, reject:UPDATE_UNAVAILABLE |
| `download` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:UPDATE_BUSY, reject:UPDATE_UNAVAILABLE |
| `install` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:UPDATE_BUSY, reject:UPDATE_UNAVAILABLE |
| `state` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:UPDATE_UNAVAILABLE |

> 非 `@PluginMethod`：`$r8$lambda$BHoess5eYg0ymIT_s5SNamk6zWU`, `$r8$lambda$GsOogOi7oZyYu86gOXIgc5giiwM`, `$r8$lambda$Z3BGTZh_syToK5FVN8vMHkppBfA`, `$r8$lambda$qAIdxO_okejFr20GSnfYO95xZgg`, `$r8$lambda$rz3m5ttRwISvOn3e6ewOaQuUzrY`, `<init>`, `lambda$check$2`, `lambda$download$3`, `lambda$install$4`, `lambda$install$5`, `lambda$load$0`, `lambda$run$1`, `run`, `handleOnDestroy`, `handleOnResume`, `load`

## EllenDiagnostics — `dev.ellen.mobile.platform.EllenDiagnosticsPlugin`

| 方法 | 参数 | 返回注解 | options | events | resolve/reject |
|---|---|---|---|---|---|
| `append` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `clear` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `read` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `share` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:text |  | reject:DIAGNOSTIC_FORMAT |

> 非 `@PluginMethod`：`$r8$lambda$SQvvEHxrLYkV5rELKxaL05qrlxM`, `$r8$lambda$hYZfRFLWJX_J258KOCSqxBua2jc`, `$r8$lambda$wtcfJ0kRlHKJ2Sjal6jdsYrKhTg`, `<init>`, `lambda$append$0`, `lambda$clear$2`, `lambda$read$1`, `lambda$share$3`, `lambda$share$4`, `lambda$share$5`, `handleOnDestroy`

## EllenLocalSpeech — `dev.ellen.mobile.platform.EllenLocalSpeechPlugin`

静态常量：
- `MODEL_ID` = `sense-voice-zh-int8-2024-07-17`

| 方法 | 参数 | 返回注解 | options | events | resolve/reject |
|---|---|---|---|---|---|
| `cancel` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId |  |  |
| `close` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `ready` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:sessionId, getString:requestId |  | reject:LOCAL_ASR_UNAVAILABLE |
| `transcribe` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:sessionId, getString:requestId |  | reject:LOCAL_ASR_UNAVAILABLE |

> 非 `@PluginMethod`：`$r8$lambda$C0zhKgVyG0QO6WIWhfTVAaQzMWA`, `$r8$lambda$GBK48iz9tsRJ6cf4zfLDJ4_hVM0`, `$r8$lambda$w4bruGvH6lN5nz1yBlfHllccxe0`, `<init>`, `begin`, `cancelled`, `capability`, `check`, `hasSpeech`, `lambda$close$2`, `lambda$perform$0`, `lambda$perform$1`, `perform`, `readyModel`, `reject`, `releaseModel`, `verifyAsset`, `verifyBundledVad`, `handleOnDestroy`, `handleOnStart`, `handleOnStop`

## SystemBars — `com.getcapacitor.plugin.SystemBars`

静态常量：
- `BAR_GESTURE_BAR` = `NavigationBar`
- `BAR_STATUS_BAR` = `StatusBar`
- `INSETS_HANDLING_CSS` = `css`
- `INSETS_HANDLING_DISABLE` = `disable`
- `INSETS_HANDLING_NATIVE` = `native`
- `STYLE_DARK` = `DARK`
- `STYLE_DEFAULT` = `DEFAULT`
- `STYLE_LIGHT` = `LIGHT`
- `viewportMetaJSFunction` = `function capacitorSystemBarsCheckMetaViewport() {\n    const meta = document.querySelectorAll(\"m...`

| 方法 | 参数 | 返回注解 | options | events | resolve/reject |
|---|---|---|---|---|---|
| `hide` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:bar |  |  |
| `setAnimation` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `setStyle` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:bar, getString:DEFAULT |  |  |
| `show` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:bar |  |  |

> 非 `@PluginMethod`：`$r8$lambda$9nLiK2MWiiaeRVmLIwzvApTlfsQ`, `$r8$lambda$EvylPBzZjLdoAOeHbCFhbstdvp8`, `$r8$lambda$MxcIqheKqAh0CeZVgL9o8jfnslI`, `$r8$lambda$QMjT0isIammsCKWnfmRyRvdoGco`, `$r8$lambda$TNHKhinwCcf5MkP4ahZdrUqtU1k`, `<init>`, `access$000`, `access$100`, `getBottomInset`, `getStyleForTheme`, `getWebViewMajorVersion`, `initSystemBars`, `initWindowInsetsListener`, `injectSafeAreaCSS`, `lambda$hide$3`, `lambda$initSystemBars$0`, `lambda$initWindowInsetsListener$4`, `lambda$injectSafeAreaCSS$5`, `lambda$setStyle$1`, `lambda$show$2`, `setHidden`, `setStyle`, `warnAboutUnsupportedConfigurationValues`, `getThemeColor`, `handleOnConfigurationChanged`, `handleOnStart`, `load`

## WebView — `com.getcapacitor.plugin.WebView`

静态常量：
- `CAP_SERVER_PATH` = `serverBasePath`
- `WEBVIEW_PREFS_NAME` = `CapWebViewSettings`

| 方法 | 参数 | 返回注解 | options | events | resolve/reject |
|---|---|---|---|---|---|
| `getServerBasePath` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `persistServerBasePath` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |
| `setServerAssetPath` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:path |  |  |
| `setServerBasePath` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:path |  |  |

> 非 `@PluginMethod`：`<init>`

## EllenDocuments — `dev.ellen.mobile.platform.EllenDocumentsPlugin`

| 方法 | 参数 | 返回注解 | options | events | resolve/reject |
|---|---|---|---|---|---|
| `cancel` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId |  |  |
| `pickCharacter` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId |  | reject:DOCUMENTS_CLOSED, reject:DOCUMENTS_BUSY, reject:INVALID_REQUEST |
| `pickText` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId |  | reject:DOCUMENTS_CLOSED, reject:DOCUMENTS_BUSY, reject:INVALID_REQUEST |

> 非 `@PluginMethod`：`$r8$lambda$qp0CRZyDlEBLLBluDMi6cUzxIOg`, `<init>`, `cancelPending`, `clear`, `lambda$picked$0`, `pick`, `picked`, `read`, `reject`, `handleOnDestroy`

## EllenModelHttp — `dev.ellen.mobile.platform.EllenModelHttpPlugin`

| 方法 | 参数 | 返回注解 | options | events | resolve/reject |
|---|---|---|---|---|---|
| `cancel` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId |  |  |
| `open` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId, getString:url, getString:apiKey, getString:body |  |  |
| `read` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId, getInt:sequence |  |  |

> 非 `@PluginMethod`：`$r8$lambda$RWY4xYL3UaDlJBwMDHhObYpYwrU`, `<init>`, `lambda$load$0`, `lambda$reply$1`, `reply`, `handleOnDestroy`, `load`

## EllenSecureConfig — `dev.ellen.mobile.platform.EllenSecureConfigPlugin`

| 方法 | 参数 | 返回注解 | options | events | resolve/reject |
|---|---|---|---|---|---|
| `read` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:model |  | reject:SECURE_STORAGE_FAILED |
| `remove` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:model |  | reject:SECURE_STORAGE_FAILED |
| `write` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:value, getString:model |  | reject:INVALID_CONFIG, reject:SECURE_STORAGE_FAILED |

> 非 `@PluginMethod`：`<init>`, `alias`, `file`, `key`, `scope`

## EllenFeedbackHttp — `dev.ellen.mobile.platform.EllenFeedbackHttpPlugin`

静态常量：
- `ENDPOINT` = `https://formsubmit.co/ajax/1520208183@qq.com`
- `SOURCE` = `https://formsubmit.co/el/xutine`

| 方法 | 参数 | 返回注解 | options | events | resolve/reject |
|---|---|---|---|---|---|
| `cancel` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId |  |  |
| `request` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId, getString:body |  | reject:FEEDBACK_BUSY, reject:INVALID_FEEDBACK |

> 非 `@PluginMethod`：`$r8$lambda$a_xkOF0VICipeDxHWH7YyC2a7pw`, `<init>`, `lambda$request$0`, `perform`, `validate`, `handleOnDestroy`, `handleOnStop`

## EllenLicense — `dev.ellen.mobile.platform.EllenLicensePlugin`

| 方法 | 参数 | 返回注解 | options | events | resolve/reject |
|---|---|---|---|---|---|
| `activate` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:token |  | reject:LICENSE_STORAGE_FAILED, reject:\u6388\u6743\u4fdd\u5b58\u6216\u6838\u5bf9\u5c1a\u672a\u786e\u8ba4\uff0c\u8bf7\u91cd\u65b0\u8bfb\u53d6\uff0c\u539f\u8d44\u6599\u4fdd\u7559\u3002 |
| `state` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  |  |

> 非 `@PluginMethod`：`<init>`

## EllenModelCatalogHttp — `dev.ellen.mobile.platform.EllenModelCatalogHttpPlugin`

| 方法 | 参数 | 返回注解 | options | events | resolve/reject |
|---|---|---|---|---|---|
| `cancel` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId |  |  |
| `request` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:requestId, getString:apiKey, getString:url |  | reject:MODEL_HTTP_BUSY, reject:INVALID_MODEL_CATALOG_REQUEST |

> 非 `@PluginMethod`：`$r8$lambda$PNfwMMVm3mqCTl8pLcTgI_dzfRM`, `<init>`, `lambda$request$0`, `perform`, `handleOnDestroy`, `handleOnStop`

## EllenReleaseInfo — `dev.ellen.mobile.platform.EllenReleaseInfoPlugin`

| 方法 | 参数 | 返回注解 | options | events | resolve/reject |
|---|---|---|---|---|---|
| `state` | `(Lcom/getcapacitor/PluginCall;)V` |  |  |  | reject:VERSION_UNAVAILABLE |

> 非 `@PluginMethod`：`<init>`

## EllenScreenShell — `dev.ellen.mobile.platform.EllenScreenShellPlugin`

| 方法 | 参数 | 返回注解 | options | events | resolve/reject |
|---|---|---|---|---|---|
| `setAppearance` | `(Lcom/getcapacitor/PluginCall;)V` |  | getString:theme |  | reject:Unsupported screen appearance |

> 非 `@PluginMethod`：`$r8$lambda$YSFM3O5ZuvDu4i__jyDIZrR1pE4`, `$r8$lambda$jMUWcAvFCoLgDTseJKbja9HKQ64`, `<init>`, `applyAppearance`, `installImeBoundary`, `lambda$installImeBoundary$0`, `lambda$setAppearance$1`, `prepareWindow`, `reapplyAfterCore`, `handleOnConfigurationChanged`, `handleOnResume`, `load`
