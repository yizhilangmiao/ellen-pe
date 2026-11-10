package cn.ellen.companion2.proactive

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import cn.ellen.companion2.MainActivity
import cn.ellen.companion2.R
import cn.ellen.companion2.vault.EllenVault
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * 真正去「说一句」的那一段：读素材 → 组 prompt → 直连模型（非流式）→ 存待读槽 + 发通知。
 *
 * 为什么不用 WebView：旧包就是在 JobService 里起 WebView 跑整条链，后台起不来 WebView，
 * 所以用户看到的永远是「只有在前台才主动发消息」。这里只依赖 HttpURLConnection。
 */
object EllenProactiveRunner {

    private const val CHANNEL_ID = "ellen-proactive-v1"
    private const val NOTIFICATION_ID = 0x4b32
    private const val TIMEOUT_MS = 30_000
    private const val MAX_CHARS = 200

    data class Result(
        val ok: Boolean,
        val text: String,
        val code: String,
        val detail: String,
        val ms: Long,
    )

    /** apiKey 存加密库（scope=model，值是 JSON），这里只取需要的两个字段。 */
    private fun modelConfig(context: Context): Pair<String, String> {
        val raw = EllenVault.read(context, "model")
        if (raw.isBlank()) return "" to ""
        return try {
            val json = JSONObject(raw)
            json.optString("apiKey") to json.optString("endpoint")
        } catch (e: Exception) {
            if (raw.trim().startsWith("sk-")) raw.trim() to "" else "" to ""
        }
    }

    private fun buildMessages(material: EllenProactiveStore.Material): JSONArray {
        val sys = StringBuilder(material.persona.ifBlank {
            "你是艾莲，一个会主动惦记他的女孩。说话口语、短、不客套。"
        })
        if (material.memories.isNotEmpty()) {
            sys.append("\n\n你记得这些事：")
            material.memories.take(8).forEach { (title, body) ->
                sys.append("\n- ")
                if (title.isNotBlank()) sys.append(title).append("：")
                sys.append(body)
            }
        }
        if (material.recent.isNotEmpty()) {
            sys.append("\n\n你们最近聊过：")
            material.recent.takeLast(6).forEach { (role, text) ->
                sys.append("\n")
                sys.append(if (role == "user") "他：" else "你：")
                sys.append(text)
            }
        }
        sys.append("\n\n现在你自己想找他说话。只输出这一句话，不要引号、不要解释、不要超过 40 字。")

        val messages = JSONArray()
        messages.put(JSONObject().apply { put("role", "system"); put("content", sys.toString()) })
        messages.put(JSONObject().apply {
            put("role", "user")
            put("content", "（现在轮到你主动开口，跟我说一句。）")
        })
        return messages
    }

    fun run(context: Context, dryRun: Boolean): Result {
        val started = System.currentTimeMillis()
        val material = EllenProactiveStore.readMaterial(context)
            ?: return finish(context, Result(false, "", "MATERIAL_MISSING", "没有缓存服务地址或模型名", 0), dryRun)

        val (vaultKey, vaultEndpoint) = modelConfig(context)
        val endpoint = material.endpoint.ifBlank { vaultEndpoint }
        if (endpoint.isBlank() || material.model.isBlank()) {
            return finish(context, Result(false, "", "MATERIAL_MISSING", "没有缓存服务地址或模型名", 0), dryRun)
        }
        if (vaultKey.isBlank()) {
            return finish(context, Result(false, "", "NO_API_KEY", "还没填模型服务的 key。", 0), dryRun)
        }

        val body = JSONObject().apply {
            put("model", material.model)
            put("stream", false)
            put("messages", buildMessages(material))
            put("thinking", JSONObject().apply { put("type", "disabled") })
            put("max_tokens", 300)
        }

        var text = ""
        try {
            val conn = (URL(endpoint).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = TIMEOUT_MS
                readTimeout = TIMEOUT_MS
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("Authorization", "Bearer $vaultKey")
            }
            conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val status = conn.responseCode
            val stream = if (status >= 400) conn.errorStream else conn.inputStream
            val raw = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            conn.disconnect()

            if (status >= 400) {
                val ms = System.currentTimeMillis() - started
                return finish(context, Result(false, "", "HTTP_$status", raw.take(160), ms), dryRun)
            }

            text = JSONObject(raw)
                .optJSONArray("choices")
                ?.optJSONObject(0)
                ?.optJSONObject("message")
                ?.optString("content")
                .orEmpty()
                .trim()
        } catch (e: Exception) {
            val ms = System.currentTimeMillis() - started
            val detail = "${e.javaClass.simpleName}: ${e.message.orEmpty()}".take(160)
            return finish(context, Result(false, "", "PROACTIVE_NETWORK", detail, ms), dryRun)
        }

        text = text.trim().trim('"', '「', '」', '\'', '“', '”')
        if (text.isBlank()) {
            val ms = System.currentTimeMillis() - started
            return finish(context, Result(false, "", "EMPTY_REPLY", "模型没给出内容", ms), dryRun)
        }
        if (text.length > MAX_CHARS) text = text.take(MAX_CHARS)

        val ms = System.currentTimeMillis() - started
        return finish(context, Result(true, text, "", "", ms), dryRun)
    }

    private fun finish(context: Context, result: Result, dryRun: Boolean): Result {
        if (!result.ok) {
            EllenProactiveStore.markRun(context, "failed", "${result.code} · ${result.detail}".trim())
            return result
        }
        EllenProactiveStore.markRun(context, "ok", "")
        if (!dryRun) {
            EllenProactiveStore.putPending(context, result.text, "proactive")
            showNotification(context, result.text)
        }
        return result
    }

    // —— 通知 ——

    private fun channel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "她来找你", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "艾莲主动发来的消息"
                setSound(null, null)
                enableVibration(true)
            }
        )
    }

    /** 后台保活服务也用这个发「在想这句话」，所以是 public。 */
    fun showNotification(context: Context, text: String) {
        channel(context)
        val open = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("ellen.proactive", text)
        }
        val pi = PendingIntent.getActivity(
            context,
            NOTIFICATION_ID,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_ellen_notify)
            .setColor(0xFFE4B8CD.toInt())
            .setContentTitle("艾莲")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification)
        } catch (e: SecurityException) {
            /* 没给通知权限：消息已经在待读槽里，下次开 App 还能看到 */
        }
    }
}
