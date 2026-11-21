package cn.ellen.companion2.plugin

import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 应用内更新：检查清单 → 下载（Range 续传 + SHA-256 校验）→ 交给系统安装器。
 *
 * 五项取舍（都踩过）：
 *  1. 换版本先删旧包，否则拿半截旧文件做 Range 续传，校验永远不过；
 *  2. cancel 不删 part，续传要用；
 *  3. 校验失败才删；
 *  4. install 先看 canRequestPackageInstalls()，不能装就跳「未知来源」设置页，绝不代点；
 *  4b.  真正装的动作走 PackageInstaller 会话，不走 FileProvider —— 小米的安装器会把
 *        「安装包扫描」丢给另一个进程，临时 URI 授权到不了那里，用户看到的是
 *        「解析软件包时出现问题。(11) Permission Denial: opening provider FileProvider」；
 *  5. 清单地址留空即可（老大要求发布通道先留空），此时 phase = unpublished。
 */
@CapacitorPlugin(name = "EllenUpdates")
class EllenUpdatesPlugin : Plugin() {

    private val worker = Executors.newSingleThreadExecutor()
    private val busy = AtomicBoolean(false)
    private val cancelled = AtomicBoolean(false)

    /**
     * 正在下的连接与输出流。
     *
     * `worker.shutdownNow()` 只发中断，**打断不了阻塞在 socket read 上的线程** ——
     * 必须把连接/流关掉，read 才会抛出来。cancel 与 handleOnDestroy 都走 closeActive()。
     */
    @Volatile
    private var activeConn: java.net.HttpURLConnection? = null

    @Volatile
    private var activeOut: java.io.OutputStream? = null

    private fun prefs() = context.getSharedPreferences("ellen-updates-v1", android.content.Context.MODE_PRIVATE)

    /**
     * 包放 filesDir，不放 cacheDir。
     *
     * cacheDir 是「系统随时可以清」的目录：存储紧张时 Android 会主动删它，
     * 100 MB 的安装包被顺手清掉之后，用户装失败再点就只剩「重新下载」一条路（老大 2026-11-14 报的现象）。
     * filesDir 归应用自己管，不会被系统清理，装十次失败也能再点十次。
     */
    private fun updatesDir(): File =
        File(context.filesDir, "updates").apply { if (!exists()) mkdirs() }

    private fun apkFile(): File = File(updatesDir(), "update.apk")
    private fun partFile(): File = File(updatesDir(), "update.part")

    private fun currentVersion(): Pair<String, Long> = try {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        val code = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
        (info.versionName ?: "") to code
    } catch (e: Exception) {
        "" to 0L
    }

    private fun readState(): JSONObject {
        val raw = prefs().getString("state", "") ?: ""
        return try {
            if (raw.isBlank()) JSONObject() else JSONObject(raw)
        } catch (e: Exception) {
            JSONObject()
        }
    }

    private fun manifestUrl(): String = prefs().getString("manifest", "") ?: ""

    /**
     * 只有这三个相位才允许带 received/total。
     *
     * 别把上一轮的进度跟着状态一起吐出去：实测 phase 已经是 unpublished，
     * received/total 还停在 100123802，界面会拿它画一条「满格」的假进度条。
     */
    private val progressPhases = setOf("downloading", "verifying", "ready")

    /** 白名单式输出：状态里能出现的字段由相位决定，磁盘上残留的脏字段一律丢掉。 */
    private fun sanitize(raw: JSONObject): JSObject {
        val phase = raw.optString("phase").ifBlank { "idle" }
        val out = JSObject()
        out.put("supported", true)
        out.put("phase", phase)
        out.put("message", raw.optString("message"))
        out.put("sequence", raw.optLong("sequence", 0L))
        out.put("canInstall", raw.optBoolean("canInstall", false))
        out.put("current", raw.optJSONObject("current") ?: JSObject())
        if (phase in progressPhases) {
            out.put("received", raw.optLong("received", 0L))
            out.put("total", raw.optLong("total", 0L))
        }
        // lastError 只属于 error：旧版本把它写进 state 后一直挂在 unpublished 上
        if (phase == "error") {
            val err = raw.optString("lastError").ifBlank { raw.optString("message") }
            out.put("lastError", err)
        }
        val latest = raw.optJSONObject("latest")
        // 没有清单地址就没有「最新版本」这回事
        if (latest != null && phase != "unpublished") out.put("latest", latest)
        return out
    }

    private fun persist(state: JSObject) {
        prefs().edit()
            .putString("state", state.toString())
            .putLong("sequence", state.optLong("sequence", 0L))
            .apply()
    }

    /**
     * 本包的清单里有没有声明 REQUEST_INSTALL_PACKAGES。
     * 必须读 requestedPermissions，不能读 checkSelfPermission：Android 15 上该权限不自动授予，
     * checkSelfPermission 恒 DENIED，会把「能正常跳设置页」的包误判成「只能手动装」。
     * 读不到（异常）按「有」处理，别把正常路径挡死。
     * 失效后果：如果反过来按 false，任何一次 PackageManager 读失败都会把正常升级路径
     * 挡成「去设置里开权限」，用户会以为包坏了。
     */
    private fun declaresInstallPermission(): Boolean = try {
        val pm = context.packageManager
        val names = if (Build.VERSION.SDK_INT >= 33) {
            pm.getPackageInfo(context.packageName, android.content.pm.PackageManager.PackageInfoFlags.of(android.content.pm.PackageManager.GET_PERMISSIONS.toLong())).requestedPermissions
        } else {
            @Suppress("DEPRECATION")
            pm.getPackageInfo(context.packageName, android.content.pm.PackageManager.GET_PERMISSIONS).requestedPermissions
        }
        names?.contains(android.Manifest.permission.REQUEST_INSTALL_PACKAGES) == true
    } catch (e: Exception) {
        Log.w("EllenUpdates", "读 requestedPermissions 失败，按「已声明」处理", e)
        true
    }

    /**
     * canRequestPackageInstalls() 在「包本身没申请 REQUEST_INSTALL_PACKAGES」时会抛 SecurityException
     * （Android 15 实测栈顶 ComputerEngine.canRequestPackageInstalls:4009），不包住会把整进程带走：
     * state() 与 install() 都在调用路径上。异常路径一律当 false，并留一条 W 日志记账（唯一允许的日志）。
     */
    private fun canInstallSafely(): Boolean = try {
        context.packageManager.canRequestPackageInstalls()
    } catch (e: SecurityException) {
        Log.w("EllenUpdates", "canRequestPackageInstalls 抛 SecurityException（包未申请 REQUEST_INSTALL_PACKAGES），按 false 处理", e)
        false
    }

    private fun publish(phase: String, message: String, extra: JSObject? = null): JSObject {
        val (version, code) = currentVersion()
        val raw = JSONObject()
        raw.put("phase", phase)
        raw.put("message", message)
        raw.put("sequence", prefs().getLong("sequence", 0L) + 1)
        raw.put("canInstall", canInstallSafely())
        raw.put("current", JSObject().apply {
            put("version", version)
            put("versionCode", code)
        })
        extra?.let { e ->
            val keys = e.keys()
            while (keys.hasNext()) {
                val k = keys.next()
                raw.put(k, e.opt(k))
            }
        }
        // latest 是粘的：cancelled / error 这类相位也要留住它，否则 cancel 完再 download
        // 会因为「还没有检查到新版本」被挡回去（实测踩过）
        if (!raw.has("latest")) {
            val previous = readState().optJSONObject("latest")
            if (previous != null) raw.put("latest", previous)
        }
        val state = sanitize(raw)
        persist(state)
        notifyListeners("updateState", state)
        return state
    }

    /**
     * 删掉已经装进系统的那个安装包。
     *
     * 只在「包里的 versionCode ≤ 当前装的 versionCode」时删 —— 这说明它已经生效了，
     * 留着只是一百多兆的垃圾。反过来（包里版本更高）说明还没装，不能动。
     *
     * 读 getPackageArchiveInfo 只解 manifest，不扫全包，开销可以接受；
     * 而且没有文件时直接返回，绝大多数调用是零成本的。
     */
    private fun pruneInstalledApk() {
        val apk = apkFile()
        if (!apk.exists()) return
        val packed = runCatching {
            context.packageManager.getPackageArchiveInfo(apk.absolutePath, 0)?.longVersionCode ?: 0L
        }.getOrDefault(0L)
        if (packed <= 0L) return
        val installed = currentVersion().second.toLong()
        if (packed > installed) return
        runCatching {
            if (apk.exists()) apk.delete()
            if (partFile().exists()) partFile().delete()
            prefs().edit().remove("pendingCode").apply()
        }
    }

    /**
     * 判定「这次安装到底成没成」。
     *
     * 两条证据按顺序用：
     *  1. 广播结果（receiver 写进 prefs）—— 快，但装成功那一刻应用正在被替换，
     *     STATUS_SUCCESS 常常投递不到，不能只靠它；
     *  2. 版本码兜底 —— install() 时记下目标 versionCode，现在装到没装到一比就知道。
     *     这条不看广播，所以一定有效。
     */
    private fun settleInstall(raw: JSONObject): JSONObject {
        val merged = mergeInstallResult(raw)
        if (merged.optString("phase") != "installing") return merged
        val pending = runCatching { prefs().getInt("pendingCode", 0) }.getOrDefault(0)
        if (pending <= 0) return merged
        val code = currentVersion().second
        if (code < pending) return merged
        prefs().edit().remove("pendingCode").apply()
        // 这个包已经装进系统了，留在私有目录只是一百多兆的垃圾
        pruneInstalledApk()
        val done = JSONObject(merged.toString())
        done.put("phase", "ready")
        done.put("message", "装好了，重新打开一下就是新版本。")
        return done
    }

    /**
     * 把 PackageInstaller 会话的结果并回状态。
     *
     * receiver 与 Capacitor 插件不是同一个对象，结果只能经 SharedPreferences 传；
     * 读到就清掉，否则每次 state() 都会重复播报同一条。
     *
     * 成功也不报「装完了」就完事：新版要等应用重启才生效，所以一律退回 ready，
     * 让人重新打开一次，而不是留一个骗人的成功态。
     */
    private fun mergeInstallResult(raw: JSONObject): JSONObject {
        val p = prefs()
        val result = p.getString(UpdateInstallReceiver.KEY_RESULT, "").orEmpty()
        if (result.isEmpty()) return raw
        val message = p.getString(UpdateInstallReceiver.KEY_MESSAGE, "").orEmpty()
        p.edit()
            .remove(UpdateInstallReceiver.KEY_RESULT)
            .remove(UpdateInstallReceiver.KEY_MESSAGE)
            .apply()
        val phase = raw.optString("phase")
        if (phase != "installing" && phase != "ready") return raw
        val out = JSONObject(raw.toString())
        out.put("phase", "ready")
        out.put("message", if (result == "ok") "装好了，重新打开一下就是新版本。" else message)
        return out
    }

    @PluginMethod
    fun state(call: PluginCall) {
        pruneInstalledApk()
        val saved = settleInstall(readState())
        if (saved.length() == 0) {
            val empty = manifestUrl().isEmpty()
            call.resolve(
                publish(
                    if (empty) "unpublished" else "idle",
                    if (empty) "还没有配更新地址。" else "",
                )
            )
            return
        }
        val out = sanitize(saved)
        val (version, code) = currentVersion()
        out.put("current", JSObject().apply { put("version", version); put("versionCode", code) })
        // canInstall 是瞬时值（取决于系统「未知来源」开关），由 canInstallSafely() 现算；
        // 持久快照只留 phase / 进度，别把上一轮的开关状态当历史记录返回。
        out.put("canInstall", canInstallSafely())
        out.put("supported", true)
        // 顺手把脏字段落盘清掉，否则下次读出来还是那条假进度
        persist(out)
        call.resolve(out)
    }

    @PluginMethod
    fun configure(call: PluginCall) {
        val manifest = call.getString("manifest").orEmpty().trim()
        prefs().edit().putString("manifest", manifest).apply()
        if (manifest.isEmpty()) {
            // 地址撤掉时，上一轮的最新版本/进度/错误一起清空
            prefs().edit().putString("state", JSONObject().toString()).apply()
            call.resolve(publish("unpublished", "还没有配更新地址。"))
        } else {
            val kept = readState()
            kept.remove("received")
            kept.remove("total")
            kept.remove("lastError")
            // 只在「还没有状态」时给 idle。启动时无条件 publish("idle") 会把
            // 「刚交给系统安装、等版本码兜底」的 installing 抹掉 —— 前端重启后就看不到结果了。
            val phase = kept.optString("phase")
            if (phase.isEmpty() || phase == "unpublished") {
                call.resolve(publish("idle", ""))
            } else {
                call.resolve(publish(phase, kept.optString("message")))
            }
        }
    }

    @PluginMethod
    fun check(call: PluginCall) {
        val url = manifestUrl()
        if (url.isEmpty()) {
            call.resolve(publish("unpublished", "还没有配更新地址。"))
            return
        }
        if (!busy.compareAndSet(false, true)) {
            call.reject("更新正在进行，请稍后操作。", "UPDATE_BUSY")
            return
        }
        publish("checking", "")
        worker.execute {
            try {
                val raw = httpGet(url)
                val json = JSONObject(raw)
                if (json.optString("packageName") != context.packageName) {
                    publish("current", "这个清单不是给这个包的。")
                    return@execute
                }
                val version = json.optString("version")
                val versionCode = json.optLong("versionCode", 0L)
                val (currentName, currentCode) = currentVersion()
                if (!json.has("apks") && !json.has("apk")) {
                    throw IllegalStateException("清单里没有 apk")
                }
                // 按本机 ABI 挑包。清单里没有本机架构那一条，就是「这个架构还没发」，
                // 不是「有新版本」—— 否则 x86_64 模拟器天天提示更新，点下去下的是 arm 包，装不上。
                val abi = deviceAbi()
                val picked = pickApk(json, abi)
                if (picked == null) {
                    publish("current", "这个架构（$abi）还没有新包。")
                    return@execute
                }
                val apk = picked.first
                val apkAbi = picked.second
                val sha = apk.optString("sha256").lowercase()
                if (!Regex("[a-f0-9]{64}").matches(sha)) {
                    throw IllegalStateException("清单里的 sha256 不合法")
                }

                val latest = JSObject().apply {
                    put("version", version)
                    put("versionCode", versionCode)
                    put("notes", json.optString("notes"))
                    put("publishedAt", json.optString("publishedAt"))
                    put("apk", JSObject().apply {
                        put("sha256", sha)
                        put("url", absoluteUrl(url, apk.optString("url")))
                        put("sizeBytes", apk.optLong("sizeBytes", 0L))
                        put("abi", apkAbi)
                    })
                }

                // 同版本重发（versionCode 一样但包换了）也算有更新：
                // 只比 versionCode 的话，改了个字重发一版就永远推不下去。
                //
                // 但只在「清单这条和本机架构对得上」时才判：老清单那条是 arm64 包，
                // x86_64 模拟器上装的是全 ABI 包，sha 必然不同 —— 按原来写法它每次都报
                // 「有同版本的新包」，这就是那条误报的来源。
                val installedSha = installedApkSha()
                val abiFits = apkAbi.isEmpty() || apkAbi.equals(abi, ignoreCase = true)
                val republished = versionCode == currentCode &&
                    installedSha.isNotEmpty() &&
                    abiFits &&
                    !installedSha.equals(sha, ignoreCase = true)
                // 包要是已经下好并校验过了，就别再让用户点一次「下载」：
                // 之前 check 完一律回 available，界面按钮就变成「下载」，看起来像 100 MB 要重下一遍。
                val staged = stagedPackageReady(sha, apk.optLong("sizeBytes", 0L))
                if (versionCode > currentCode || republished) {
                    val note = if (versionCode > currentCode) "有新版本：$version" else "有同版本的新包：$version"
                    publish(
                        if (staged) "ready" else "available",
                        if (staged) "安装包已经下好了，直接点安装。" else note,
                        JSObject().apply { put("latest", latest) },
                    )
                } else {
                    publish("current", "已经是最新的（$currentName）。", JSObject().apply { put("latest", latest) })
                }
            } catch (e: Exception) {
                publish("error", describe(e))
            } finally {
                busy.set(false)
            }
        }
        val out = JSObject()
        out.put("started", true)
        call.resolve(out)
    }

    /**
     * 这台机器实际在跑哪个 ABI。
     *
     * SUPPORTED_ABIS[0] 是首选架构，也就是系统优先加载的那一套 so —— 对
     * 「我这个包装的是哪个 ABI」这个判断够用了（真机 arm64-v8a、MuMu 模拟器 x86_64）。
     * 没用 ApplicationInfo.primaryCpuAbi：那个字段在当前 compileSdk 下编译不过。
     */
    private fun deviceAbi(): String {
        return Build.SUPPORTED_ABIS?.firstOrNull().orEmpty()
    }

    /**
     * 从清单里挑出属于本机 ABI 的那一条，找不到回 null。
     *
     * 清单两种形态：
     *   新：`apks: [{abi, url, sha256, sizeBytes}]` —— 按 ABI 挑
     *   老：`apk: {url, sha256, sizeBytes}` —— 历史上一律是 arm64-v8a 的包
     *
     * 老格式在非 arm64 机器上一律当「没有本机架构的包」。不这么判，x86_64 模拟器
     * 拿全 ABI 包的 sha 去比 arm64 包的 sha，永远不同，就一直提示「有同版本的新包」。
     */
    private fun pickApk(json: JSONObject, abi: String): Pair<JSONObject, String>? {
        val list = json.optJSONArray("apks")
        if (list != null && list.length() > 0) {
            for (i in 0 until list.length()) {
                val item = list.optJSONObject(i) ?: continue
                if (item.optString("abi").equals(abi, ignoreCase = true)) return item to abi
            }
            return null
        }
        val legacy = json.optJSONObject("apk") ?: return null
        if (!abi.equals(LEGACY_ABI, ignoreCase = true)) return null
        return legacy to LEGACY_ABI
    }

    /**
     * 本地是否已经躺着一个和清单 sha 对得上的完整包。
     *
     * 判据故意只看「长度 + 下载时记下的 sha」，不算一遍 sha256：100 MB 的包在 check 里现算要几秒，
     * 而这份文件的 sha 早在 finish() 里校验通过过，长度对得上就不会是半截文件。
     */
    private fun stagedPackageReady(sha: String, sizeBytes: Long): Boolean {
        val apk = apkFile()
        if (!apk.exists() || apk.length() == 0L) return false
        if (sizeBytes > 0 && apk.length() != sizeBytes) return false
        val savedSha = prefs().getString("downloadingSha", "") ?: ""
        return savedSha.equals(sha, ignoreCase = true)
    }

    /** 已装包自己的 sha256（同版本重发靠它判断）。按 versionCode 缓存，别每次 check 都读 100 MB。 */
    private fun installedApkSha(): String {
        val (_, code) = currentVersion()
        val cached = prefs().getString("installedSha", "") ?: ""
        if (cached.isNotEmpty() && prefs().getLong("installedShaCode", -1L) == code) return cached
        val src = try {
            context.packageManager.getApplicationInfo(context.packageName, 0).sourceDir
        } catch (e: Exception) {
            ""
        }
        if (src.isNullOrEmpty()) return ""
        val sha = try {
            sha256(File(src))
        } catch (e: Exception) {
            ""
        }
        if (sha.isNotEmpty()) {
            prefs().edit().putString("installedSha", sha).putLong("installedShaCode", code).apply()
        }
        return sha
    }

    /**
     * 清单里的 apk.url 可能是相对文件名（release.ps1 默认这么写，对应「发布通道先留空」）。
     * 直接丢给 java.net.URL 会 MalformedURLException: no protocol，所以以清单地址为基准解析。
     */
    private fun absoluteUrl(base: String, raw: String): String {
        if (raw.isEmpty() || raw.contains("://")) return raw
        return try {
            java.net.URL(java.net.URL(base), raw).toString()
        } catch (e: Exception) {
            Log.w("EllenUpdates", "相对地址解析失败：$raw", e)
            raw
        }
    }

    private fun describe(e: Exception): String {
        val detail = "${e.javaClass.simpleName}: ${e.message.orEmpty()}".take(160)
        return "更新未完成，请检查网络后重试。（$detail）"
    }

    @PluginMethod
    fun download(call: PluginCall) {
        if (!busy.compareAndSet(false, true)) {
            call.reject("更新正在进行，请稍后操作。", "UPDATE_BUSY")
            return
        }
        val saved = readState()
        val latest = saved.optJSONObject("latest")
        if (latest == null) {
            busy.set(false)
            call.reject("还没有检查到新版本。", "UPDATE_UNAVAILABLE")
            return
        }
        val apk = latest.optJSONObject("apk")
        val url = absoluteUrl(manifestUrl(), apk?.optString("url").orEmpty())
        val sha = apk?.optString("sha256").orEmpty()
        val total = apk?.optLong("sizeBytes", 0L) ?: 0L
        if (url.isEmpty() || sha.isEmpty()) {
            busy.set(false)
            call.reject("清单里缺少下载地址。", "UPDATE_UNAVAILABLE")
            return
        }

        // 换版本先清掉旧包，否则会拿半截旧文件续传，永远校验不过
        val target = apkFile()
        val savedSha = prefs().getString("downloadingSha", "") ?: ""
        if (target.exists() && savedSha != sha) target.delete()
        // part 也必须跟着版本走：不同 sha 的残片续上去，校验必错
        if (partFile().exists() && savedSha.isNotEmpty() && savedSha != sha) partFile().delete()
        prefs().edit().putString("downloadingSha", sha).apply()
        cancelled.set(false)
        publish("downloading", "", JSObject().apply {
            put("received", 0L)
            put("total", total)
        })

        worker.execute {
            try {
                downloadAndVerify(url, sha, total)
            } catch (e: Exception) {
                if (cancelled.get()) {
                    publish("cancelled", "已经停下。")
                } else {
                    publish("error", describe(e))
                }
            } finally {
                busy.set(false)
            }
        }
        val out = JSObject()
        out.put("started", true)
        call.resolve(out)
    }

    private fun downloadAndVerify(url: String, sha: String, total: Long) {
        val part = partFile()
        var offset = if (part.exists()) part.length() else 0L
        if (offset > 0 && total > 0 && offset > total) {
            part.delete()
            offset = 0
        }
        if (offset > 0 && total > 0 && offset == total) {
            // 上次其实已经下完、只差校验：直接进校验，别再发一次请求
            publish("verifying", "")
            finish(part, sha)
            return
        }

        val conn = (java.net.URL(url).openConnection() as java.net.HttpURLConnection).apply {
            connectTimeout = 20_000
            readTimeout = 60_000
            if (offset > 0) setRequestProperty("Range", "bytes=$offset-")
        }
        activeConn = conn
        val status = conn.responseCode
        if (offset > 0 && status == 200) {
            // 服务端不认 Range，只能从头来
            part.delete()
            offset = 0
        } else if (offset > 0 && status == 416) {
            // 续传点越界：残片作废，从头下
            part.delete()
            offset = 0
        } else if (status >= 400) {
            conn.disconnect()
            activeConn = null
            throw IllegalStateException("HTTP $status")
        }
        if (status == 206 && offset == 0L) {
            // 206 但我们是头一次请求 —— 说明上次 part 没了、offset 被清零，正常往下走
        }

        val expected = if (conn.contentLengthLong > 0) conn.contentLengthLong + offset else total
        try {
            conn.inputStream.use { input ->
                java.io.FileOutputStream(part, offset > 0).use { out ->
                    activeOut = out
                    val buffer = ByteArray(64 * 1024)
                    var written = offset
                    while (true) {
                        if (cancelled.get()) throw InterruptedException("cancelled")
                        val n = input.read(buffer)
                        if (n < 0) break
                        out.write(buffer, 0, n)
                        written += n
                        publish("downloading", "", JSObject().apply {
                            put("received", written)
                            put("total", expected)
                        })
                    }
                }
            }
        } finally {
            activeOut = null
            activeConn = null
            try {
                conn.disconnect()
            } catch (_: Exception) {
                /* ignore */
            }
        }

        publish("verifying", "")
        finish(part, sha)
    }

    /** 校验 + 改名 + 收尾；校验不过就删残片（续传不能用坏字节）。 */
    private fun finish(part: File, sha: String) {
        val actual = sha256(part)
        if (!actual.equals(sha, ignoreCase = true)) {
            part.delete()
            throw IllegalStateException("校验失败：期望 ${sha.take(12)}…，实际 ${actual.take(12)}…")
        }
        if (apkFile().exists()) apkFile().delete()
        if (!part.renameTo(apkFile())) throw IllegalStateException("没法把临时文件改名")
        publish("ready", "下载好了。", JSObject().apply {
            put("received", apkFile().length())
            put("total", apkFile().length())
        })
    }

    @PluginMethod
    fun install(call: PluginCall) {
        val apk = apkFile()
        if (!apk.exists() || apk.length() == 0L) {
            call.reject("还没有下载好的安装包。", "UPDATE_UNAVAILABLE")
            return
        }
        // 两种「装不了」要分开说：
        //  a) 包本身没申请 REQUEST_INSTALL_PACKAGES —— 跳设置页没用，只能手动装；
        //  b) 申请了，但用户没开「允许安装未知来源」—— 跳设置页让他开。
        // 注意：这里判的是「清单里声明了没有」，不能用 checkSelfPermission ——
        // Android 15 实测该权限不会自动授予，checkSelfPermission 恒回 DENIED，
        // 而 canRequestPackageInstalls() 回 true（见 _verify\plugins\EllenUpdates.md 〇 节）。
        if (Build.VERSION.SDK_INT >= 26 && !declaresInstallPermission()) {
            publish("permission", "这个安装包没有申请安装应用的权限，更新只能手动装。")
            val out = JSObject()
            out.put("started", false)
            out.put("reason", "no_permission")
            call.resolve(out)
            return
        }
        if (!canInstallSafely()) {
            publish("permission", "需要在系统设置里允许安装未知来源。")
            try {
                val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
                    .setData(Uri.parse("package:${context.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(intent)
            } catch (_: Exception) {
                /* 打不开设置页也不该崩 */
            }
            val out = JSObject()
            out.put("started", false)
            out.put("reason", "permission")
            call.resolve(out)
            return
        }
        // 先把上一次的安装结果清掉，否则 state() 会把旧结果当成这一次的
        runCatching {
            prefs().edit()
                .remove(UpdateInstallReceiver.KEY_RESULT)
                .remove(UpdateInstallReceiver.KEY_MESSAGE)
                .apply()
        }
        // 广播不一定收得到：装成功那一刻本应用正在被替换，STATUS_SUCCESS 可能投递失败。
        // 所以记下目标版本码，state() 里用「当前版本已经到了没」兜底判成功。
        // 版本码直接从 apk 文件里读，不依赖 check() 留下的 latest —— 用户可能没点过检查就装。
        runCatching {
            val info = context.packageManager.getPackageArchiveInfo(apk.absolutePath, 0)
            val code = info?.longVersionCode?.toInt() ?: 0
            if (code > 0) prefs().edit().putInt("pendingCode", code).apply()
        }
        publish("installing", "正在交给系统安装…")
        val out = JSObject()
        out.put("started", true)
        call.resolve(out)
        // 写会话要拷上百兆，绝不能占主线程：resolve 之后丢给 worker
        worker.execute {
            try {
                commitSession(apk)
            } catch (e: Exception) {
                // 会话没建起来 ≠ 包有问题：文件还在，状态退回 ready，用户可以再点一次「安装」
                publish("ready", "没能交给系统安装，再点一次「安装」就行。（${e.javaClass.simpleName}）")
            }
        }
    }

    /**
     * 把 apk 字节写进 PackageInstaller 会话并提交。
     *
     * 为什么不用 FileProvider + ACTION_VIEW（改过的原因）：
     * 小米的安装器在「安装包扫描」阶段会把 URI 交给另一个进程，而
     * FLAG_GRANT_READ_URI_PERMISSION 只授予 startActivity 的目标 Activity，
     * 扫描进程拿不到 → Permission Denial ... not exported from UID，用户看到
     * 「解析软件包时出现问题。(11)」。会话安装由系统直接读我们写进去的字节，
     * 不跨进程传 URI，各家 ROM 一致。
     *
     * 坑：commit 之后必须等 receiver 收到 STATUS_PENDING_USER_ACTION 再自己
     * startActivity 弹确认页，否则用户什么都看不到。
     */
    private fun commitSession(apk: File) {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        if (Build.VERSION.SDK_INT >= 31) {
            // 明确要求用户确认：静默装会跳过确认页，这里不是那个场景
            params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
        }
        val sessionId = installer.createSession(params)
        try {
            installer.openSession(sessionId).use { session ->
                apk.inputStream().use { input ->
                    session.openWrite("base.apk", 0L, apk.length()).use { sink ->
                        input.copyTo(sink, 256 * 1024)
                        session.fsync(sink)
                    }
                }
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                    (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
                val resultIntent = PendingIntent.getBroadcast(
                    context,
                    sessionId,
                    Intent(context, UpdateInstallReceiver::class.java).setAction(ACTION_INSTALL),
                    flags
                )
                session.commit(resultIntent.intentSender)
            }
        } catch (e: Exception) {
            runCatching { installer.abandonSession(sessionId) }
            throw e
        }
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        val wasBusy = busy.get()
        cancelled.set(true)
        // 光置标志位不够：read 阻塞在 socket 上时循环体根本跑不到，得把流关掉
        closeActive()
        if (wasBusy) awaitIdle()
        val out = JSObject()
        out.put("cancelled", true)
        out.put("stopped", wasBusy && !busy.get())
        out.put("keptBytes", if (partFile().exists()) partFile().length() else 0L)
        call.resolve(out)
    }

    /** 关掉正在下的流：让阻塞中的 read 立刻抛异常，而不是等 60 s 读超时。 */
    private fun closeActive() {
        try {
            activeOut?.flush()
        } catch (_: Exception) {
            /* 已经坏了就算了 */
        }
        try {
            activeOut?.close()
        } catch (_: Exception) {
            /* ignore */
        }
        try {
            activeConn?.disconnect()
        } catch (_: Exception) {
            /* ignore */
        }
        activeOut = null
        activeConn = null
    }

    /** cancel 之后立刻 download 要能接上：等 worker 真正把 busy 放掉（最多 1.5 s）。 */
    private fun awaitIdle(timeoutMs: Long = 1500L) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (busy.get() && System.currentTimeMillis() < deadline) {
            try {
                Thread.sleep(20)
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                return
            }
        }
    }

    private fun httpGet(url: String): String {
        val conn = (java.net.URL(url).openConnection() as java.net.HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = 30_000
        }
        try {
            val status = conn.responseCode
            if (status >= 400) throw IllegalStateException("HTTP $status")
            return conn.inputStream.bufferedReader().use { it.readText() }
        } finally {
            conn.disconnect()
        }
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                digest.update(buffer, 0, n)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    override fun handleOnDestroy() {
        cancelled.set(true)
        // 顺序不能反：先关流把阻塞的 read 打醒，再 shutdownNow
        closeActive()
        worker.shutdownNow()
        try {
            worker.awaitTermination(1, java.util.concurrent.TimeUnit.SECONDS)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
        super.handleOnDestroy()
    }

    private companion object {
        const val DAY = 24L * 60 * 60 * 1000

        /** 老清单里那条 `apk` 一直是这个架构（0.5.x 的包名都带 `-arm64-v8a`）。 */
        const val LEGACY_ABI = "arm64-v8a"

        /** 安装会话结果广播的 action（receiver 按类找，action 只用于日志辨识） */
        const val ACTION_INSTALL = "cn.ellen.companion2.INSTALL_RESULT"
    }
}
