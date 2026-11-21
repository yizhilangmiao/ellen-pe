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

    /**
     * 生成出来的句子跟最近说过的话像到这个程度，就算复读。
     *
     * 0.5 是量出来的：「醒了没，胃还痛不痛」对「今早醒了胃还疼吗」重合度 0.62，
     * 对「今天中午吃了什么」0.05 —— 中间那一大片空档，取中间偏保守的位置。
     */
    private const val REPEAT_THRESHOLD = 0.5

    data class Result(
        val ok: Boolean,
        val text: String,
        val code: String,
        val detail: String,
        val ms: Long,
    )

    /** 一次模型调用的原始结果，重试时复用。 */
    private data class Raw(
        val ok: Boolean,
        val text: String,
        val code: String,
        val detail: String,
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

    /** 「3 天前」这种。写给模型看的时间，不用精确到分。 */
    private fun agoText(at: Long, now: Long): String {
        if (at <= 0L) return "之前"
        val min = ((now - at) / 60_000L).toInt()
        return when {
            min < 30 -> "刚才"
            min < 60 -> "半小时前"
            min < 24 * 60 -> "${min / 60} 小时前"
            min < 48 * 60 -> "昨天"
            else -> "${min / (24 * 60)} 天前"
        }
    }

    /**
     * 组 prompt。
     *
     * **复读是这里治的，不是靠 native 记性好。** 老大反馈过：他说「我早上起来胃有点痛」之后，
     * 连着四天每一条主动消息都是「醒了没，胃还痛不痛」。原因有三个，缺一个都还会犯：
     *   1. 记忆池每轮都是同一批（取最近 12 条），胃痛那条一直在最前面；
     *   2. 最近聊天也是同一批，他这几天没聊别的；
     *   3. prompt 只说「挑一件你记得的事」，没说「挑过的别再挑」——模型每轮都从同一堆里挑最显眼的。
     * 所以这里做三件事：把已经问过的记忆从候选里剔掉、把它们单列成禁止清单、
     * 再把最近真发出去的几句话原样念给它听。
     */
    private fun buildMessages(
        context: Context,
        material: EllenProactiveStore.Material,
        recentSent: List<EllenProactiveStore.Sent>,
        retryFrom: String?,
    ): JSONArray {
        val now = System.currentTimeMillis()
        val sys = StringBuilder(material.persona.ifBlank {
            "你是艾莲，一个会主动惦记他的女孩。说话口语、短、不客套。"
        })

        // 记忆分成「还没问过」和「问过了」两堆。问过的不进候选池——
        // 光在 prompt 里写「别提」没用，模型还是会挑它，因为它是唯一具体的。
        val fresh = ArrayList<Pair<String, String>>()
        val used = ArrayList<Pair<String, String>>()
        material.memories.forEach { m ->
            if (EllenProactiveStore.memoryCovered(m, recentSent) != null) used.add(m) else fresh.add(m)
        }

        if (fresh.isNotEmpty()) {
            sys.append("\n\n你记得这些事：")
            fresh.take(8).forEach { (title, body) ->
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

        // 已问过的事：单列 + 点名次数。只写「不许提」它还是会绕回来问「胃好点没」，
        // 所以直接把原话摆出来，并说明这件事已经翻过几遍。
        if (used.isNotEmpty()) {
            sys.append("\n\n下面这些**已经问过、他已经答过了**，这次一个字都不许再提——别再问「好点没」「还疼吗」，")
            sys.append("也别换个说法问同一件事：")
            used.take(6).forEach { (title, body) ->
                val label = title.ifBlank { body }
                val hits = recentSent.count { EllenProactiveStore.similarity(label + " " + body, it.text) >= 0.45 }
                sys.append("\n- ").append(label.take(30))
                if (hits >= 2) sys.append("（这件事你已经问过 ").append(hits).append(" 次了）")
            }
        }

        // 最近真发出去的话。这是最硬的一道：模型看得见自己上一条说了什么，就不会接着复读。
        if (recentSent.isNotEmpty()) {
            sys.append("\n\n你最近主动找他说过这几句（同样的话、同一件事，都不许再出现）：")
            recentSent.takeLast(6).forEach { s ->
                sys.append("\n- ").append(agoText(s.at, now)).append("：").append(s.text.take(60))
            }
        }

        // —— 隔了多久：这一段决定了「接着聊」还是「起新话头」——
        // 用户的要求是「半小时没聊天就照聊天记录或自己的作息找个话题」，
        // 光把最近几条消息塞进去，模型只会顺着最后一句说「嗯嗯」，所以要把时间差说出来。
        val gapMin = run {
            val left = EllenProactiveStore.lastUserAt(context)
            if (left <= 0) -1 else ((now - left) / 60_000L).toInt()
        }
        if (gapMin >= 0) {
            val human = when {
                gapMin < 60 -> "大约 $gapMin 分钟"
                gapMin < 24 * 60 -> "大约 ${gapMin / 60} 个小时"
                else -> "一天以上"
            }
            sys.append("\n\n他上一次说话是$human 之前。")
        }
        // 「接着聊」还是「起个新话头」：既要看隔了多久，也要看他最后那句
        // 是不是真的停在半路（说了「晚安」就不该硬接）。
        val followUp = EllenProactiveStore.isOpenTopic(material) && gapMin in 5..45 && recentSent.isEmpty()
        sys.append(
            if (followUp) {
                "\n你们刚聊到一半就停了。接着刚才那件事往下说一句——不要问他「在干嘛」，" +
                    "也不要重新打招呼，直接说那件事的下一句。"
            } else {
                "\n已经隔了一段时间。挑一件你记得的事、或者你这时候本来会做的事起个头，" +
                    "不要复述上面聊过的内容，也不要问「在干嘛」。"
            }
        )

        // 换话题的硬要求：不留这句，模型会默认「关心他的身体」是最安全的选择，
        // 于是每一天都回到同一个话题上。
        sys.append(
            "\n换话题：这次说的事必须跟上面「问过的」「说过的」都不一样。" +
                "如果你手上只剩那几件已经说过的事，就写你此刻在做什么、看见了什么、忽然想起什么，" +
                "或者问他一件全新的、具体的小事（具体到一样东西、一个地方、一件刚发生的事）。"
        )
        if (recentSent.size >= 3) {
            sys.append("\n你最近说得太像了。这次哪怕是件很小的、无关紧要的事，也要换个完全不同的开头。")
        }
        if (!retryFrom.isNullOrBlank()) {
            sys.append("\n\n你刚才说的「").append(retryFrom.take(40))
                .append("」跟之前说过的几乎一样，被退回来了。换一件完全不同的事，别改几个字交差。")
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

    /** 发一次请求。重试时只是换一份 messages，其余完全一样。 */
    private fun askOnce(
        endpoint: String,
        key: String,
        model: String,
        messages: JSONArray,
    ): Raw {
        val body = JSONObject().apply {
            put("model", model)
            put("stream", false)
            put("messages", messages)
            put("thinking", JSONObject().apply { put("type", "disabled") })
            put("max_tokens", 300)
        }
        try {
            val conn = (URL(endpoint).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = TIMEOUT_MS
                readTimeout = TIMEOUT_MS
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("Authorization", "Bearer $key")
            }
            conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val status = conn.responseCode
            val stream = if (status >= 400) conn.errorStream else conn.inputStream
            val raw = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            conn.disconnect()

            if (status >= 400) return Raw(false, "", "HTTP_$status", raw.take(160))

            val text = JSONObject(raw)
                .optJSONArray("choices")
                ?.optJSONObject(0)
                ?.optJSONObject("message")
                ?.optString("content")
                .orEmpty()
                .trim()
                .trim('"', '「', '」', '\'', '“', '”')
            if (text.isBlank()) return Raw(false, "", "EMPTY_REPLY", "模型没给出内容")
            return Raw(true, if (text.length > MAX_CHARS) text.take(MAX_CHARS) else text, "", "")
        } catch (e: Exception) {
            return Raw(false, "", "PROACTIVE_NETWORK", "${e.javaClass.simpleName}: ${e.message.orEmpty()}".take(160))
        }
    }

    fun run(context: Context, dryRun: Boolean): Result {
        val started = System.currentTimeMillis()

        // 「他停在哪」两个闸门都要用，先算一次。一次 JSON parse，可接受。
        val cached = if (dryRun) null else EllenProactiveStore.readMaterial(context)
        val sinceUser = run {
            val left = EllenProactiveStore.lastUserAt(context)
            if (left <= 0) Long.MAX_VALUE else started - left
        }
        // 话题停在一半（他最后那句不像收尾）+ 已经静了 5 分钟 = 该接一句了。
        // 这个场景里 App 就算还开着，也不该拦——老大要的就是「聊着聊着没声了，
        // 五分钟后她再问一句」。
        val openTopic = !dryRun && EllenProactiveStore.isOpenTopic(cached) &&
            sinceUser >= EllenProactiveStore.FOLLOW_UP_MS

        // 闸门一：App 在前台就别开口。用户就坐在聊天界面里，这时候插一句
        // 「在吗」只会显得她没在看场合。闹钟到点了也顺延，别硬发。
        if (!dryRun && !openTopic && EllenProactiveStore.isForeground(context)) {
            EllenProactiveScheduler.scheduleNext(context)
            return finish(context, Result(false, "", "APP_FOREGROUND", "正在用 App，这次不发", 0), dryRun)
        }

        // 闸门二：刚聊完（App 退到后台还不到 RECENT_CHAT_MS）也不发。
        // 前台闸门管的是「此刻」，这个管的是「刚刚」——用户退回桌面十分钟，
        // 那时候不该马上收到一条消息。
        //
        // 例外：他说了半句就停了（isOpenTopic），这时按 5 分钟算就行——
        // 老的要的是「话题没聊完，五分钟后再接一句」，等满 15 分钟那句早就凉了。
        if (!dryRun && !openTopic && sinceUser < EllenProactiveStore.RECENT_CHAT_MS) {
            EllenProactiveScheduler.scheduleNext(context)
            return finish(context, Result(false, "", "RECENT_CHAT", "刚聊过，这次不发", 0), dryRun)
        }

        val material = cached ?: EllenProactiveStore.readMaterial(context)
            ?: return finish(context, Result(false, "", "MATERIAL_MISSING", "没有缓存服务地址或模型名", 0), dryRun)

        val (vaultKey, vaultEndpoint) = modelConfig(context)
        val endpoint = material.endpoint.ifBlank { vaultEndpoint }
        if (endpoint.isBlank() || material.model.isBlank()) {
            return finish(context, Result(false, "", "MATERIAL_MISSING", "没有缓存服务地址或模型名", 0), dryRun)
        }
        if (vaultKey.isBlank()) {
            return finish(context, Result(false, "", "NO_API_KEY", "还没填模型服务的 key。", 0), dryRun)
        }

        // 试跑（设置页「现在说一句」）也读这份历史：老大点两下试跑，
        // 第二句就不该跟第一句一样。
        val recentSent = EllenProactiveStore.recentSent(context)

        val first = askOnce(endpoint, vaultKey, material.model, buildMessages(context, material, recentSent, null))
        if (!first.ok) {
            val ms = System.currentTimeMillis() - started
            return finish(context, Result(false, "", first.code, first.detail, ms), dryRun)
        }

        var text = first.text
        var repeat = EllenProactiveStore.repeatedOf(text, recentSent, REPEAT_THRESHOLD)

        // 复读就重来一次，并把「你刚说了 X」写进 prompt 点名。
        // 一道 prompt 挡不住的，就用第二道；两道都挡不住宁可不发——
        // 连发四天同一个问句，比今天少一条严重得多。
        if (repeat != null) {
            val retry = askOnce(
                endpoint,
                vaultKey,
                material.model,
                buildMessages(context, material, recentSent, repeat.text),
            )
            if (retry.ok) {
                text = retry.text
                repeat = EllenProactiveStore.repeatedOf(text, recentSent, REPEAT_THRESHOLD)
            }
        }
        if (repeat != null) {
            val ms = System.currentTimeMillis() - started
            // 这个不算失败重试用光额度，但要顺延，不然下个闹钟还是它
            EllenProactiveScheduler.scheduleNext(context)
            return finish(
                context,
                Result(false, "", "REPEATED", "跟之前说过的一样：${repeat.text.take(40)}", ms),
                dryRun,
            )
        }

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
            // 只有真发出的这一条才算进「今天几条」——下限 dailyMin 靠它判定。
            // dryRun（设置页的「现在说一句」试跑）不计数，否则点两下试跑就把下限填满了。
            EllenProactiveStore.noteSent(context, result.text)
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
