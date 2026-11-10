package cn.ellen.companion2.plugin

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
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
 *  5. 清单地址留空即可（老大要求发布通道先留空），此时 phase = unpublished。
 */
@CapacitorPlugin(name = "EllenUpdates")
class EllenUpdatesPlugin : Plugin() {

    private val worker = Executors.newSingleThreadExecutor()
    private val busy = AtomicBoolean(false)
    private val cancelled = AtomicBoolean(false)

    private fun prefs() = context.getSharedPreferences("ellen-updates-v1", android.content.Context.MODE_PRIVATE)

    private fun apkFile(): File = File(context.cacheDir, "update.apk")
    private fun partFile(): File = File(context.cacheDir, "update.part")

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

    private fun publish(phase: String, message: String, extra: JSObject? = null): JSObject {
        val (version, code) = currentVersion()
        val raw = JSONObject()
        raw.put("phase", phase)
        raw.put("message", message)
        raw.put("sequence", prefs().getLong("sequence", 0L) + 1)
        raw.put("canInstall", context.packageManager.canRequestPackageInstalls())
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
        val state = sanitize(raw)
        persist(state)
        notifyListeners("updateState", state)
        return state
    }

    @PluginMethod
    fun state(call: PluginCall) {
        val saved = readState()
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
            if (kept.optString("phase") == "unpublished") kept.put("phase", "idle")
            call.resolve(publish("idle", ""))
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
                val apk = json.optJSONObject("apk") ?: throw IllegalStateException("清单里没有 apk")
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
                        put("url", apk.optString("url"))
                        put("sizeBytes", apk.optLong("sizeBytes", 0L))
                    })
                }

                if (versionCode <= currentCode) {
                    publish("current", "已经是最新的（$currentName）。", JSObject().apply { put("latest", latest) })
                } else {
                    publish("available", "有新版本：$version", JSObject().apply { put("latest", latest) })
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
        val url = apk?.optString("url").orEmpty()
        val sha = apk?.optString("sha256").orEmpty()
        val total = apk?.optLong("sizeBytes", 0L) ?: 0L
        if (url.isEmpty() || sha.isEmpty()) {
            busy.set(false)
            call.reject("清单里缺少下载地址。", "UPDATE_UNAVAILABLE")
            return
        }

        // 换版本先清掉旧包，否则会拿半截旧文件续传，永远校验不过
        val target = apkFile()
        if (target.exists() && readState().optString("downloadingSha") != sha) {
            target.delete()
        }
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

        val conn = (java.net.URL(url).openConnection() as java.net.HttpURLConnection).apply {
            connectTimeout = 20_000
            readTimeout = 60_000
            if (offset > 0) setRequestProperty("Range", "bytes=$offset-")
        }
        val status = conn.responseCode
        if (offset > 0 && status == 200) {
            // 服务端不认 Range，只能从头来
            part.delete()
            offset = 0
        } else if (status >= 400) {
            conn.disconnect()
            throw IllegalStateException("HTTP $status")
        }

        val expected = if (conn.contentLengthLong > 0) conn.contentLengthLong + offset else total
        conn.inputStream.use { input ->
            java.io.FileOutputStream(part, offset > 0).use { out ->
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
        conn.disconnect()

        publish("verifying", "")
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
        if (!context.packageManager.canRequestPackageInstalls()) {
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
        try {
            val uri: Uri = FileProvider.getUriForFile(context, "${context.packageName}.updates", apk)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            publish("installing", "去安装页点一下就好。")
            context.startActivity(intent)
            val out = JSObject()
            out.put("started", true)
            call.resolve(out)
        } catch (e: Exception) {
            publish("error", "系统安装页面没能打开。（${e.javaClass.simpleName}）")
            call.reject("系统安装页面未能打开，请重试。", "INSTALL_UNAVAILABLE")
        }
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        cancelled.set(true)
        val out = JSObject()
        out.put("cancelled", true)
        call.resolve(out)
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
        worker.shutdownNow()
        super.handleOnDestroy()
    }

    private companion object {
        const val DAY = 24L * 60 * 60 * 1000
    }
}
