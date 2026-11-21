package cn.ellen.companion2.proactive

import android.content.Context
import android.content.SharedPreferences
import com.getcapacitor.JSObject
import org.json.JSONArray
import org.json.JSONObject

/**
 * 主动消息的本地仓库：素材、开关、待读消息、运行状态，全放 SharedPreferences。
 *
 * 为什么不用 Room：要存的东西一共就十来个字段 + 两小段 JSON 数组，
 * 后台任务被系统叫起来时越快读完越好（Room 要先开会话、查表、关会话）。
 */
object EllenProactiveStore {

    /** 刚聊完这段时间内不主动开口。Runner（发之前）和 Scheduler（排下一次）共用。 */
    const val RECENT_CHAT_MS = 15L * 60L * 1000L

    /**
     * 他抛下一句话就没下文时，等这么久就能接一句（要��� 2.2「聊天结束五分钟」）。
     *
     * 为什么比 RECENT_CHAT_MS 短：15 分钟那条是「别在人家刚聊完就插嘴」，
     * 这条是「他说了半句就停了，接一下」。两种情况方向相反，不能共用一个数。
     */
    const val FOLLOW_UP_MS = 5L * 60L * 1000L

    /** 收尾语。最后一句带这些词就当他这轮聊完了，别硬接。 */
    private val CLOSERS = listOf(
        "晚安", "拜拜", "睡了", "先这样", "去忙", "我忙", "回头聊",
        "明天见", "先不聊", "下线", "拜~", "bye",
    )

    /**
     * 最后一句是不是「他抛下没接的话」——决定要不要 5 分钟后续一句。
     *
     * 只看最后一条：是他说、够长、不像收尾语。不判断语义是否闭环（那要模型，
     * 后台跑一次判断的成本比这条消息本身还高）。
     */
    fun isOpenTopic(material: Material?): Boolean {
        val last = material?.recent?.lastOrNull() ?: return false
        if (last.first != "user") return false
        val text = last.second.trim()
        if (text.length < 4) return false
        if (text.endsWith("？") || text.endsWith("?")) return false
        return CLOSERS.none { text.contains(it, ignoreCase = true) }
    }

    private const val PREFS = "ellen-proactive-v1"
    private const val KEY_MATERIAL = "material"
    private const val KEY_ENABLED = "enabled"
    private const val KEY_PROFILE = "profileId"
    private const val KEY_NEXT = "nextAt"
    private const val KEY_LAST_AT = "lastAt"
    // 用户最后一次在 App 里活动（目前就是「把 App 切到后台」那一刻）。
    // 主动消息要避开「刚聊完」，靠这个判。
    private const val KEY_LAST_USER_AT = "lastUserAt"
    // App 此刻是不是在前台。前台一律不发 —— 用户就坐在聊天界面里。
    private const val KEY_FOREGROUND = "foreground"
    private const val KEY_LAST_STATUS = "lastStatus"
    private const val KEY_LAST_ERROR = "lastError"
    // 「今天已经发了几条」——下限 dailyMin 靠它判定，只有 native 数得准
    //（后台发送时 web 不在场，它那份 localStorage 计数会偏低）。
    private const val KEY_SENT_DAY = "sentDay"
    private const val KEY_SENT_COUNT = "sentCount"
    private const val KEY_PENDING_TEXT = "pendingText"
    private const val KEY_PENDING_TYPE = "pendingType"
    private const val KEY_PENDING_AT = "pendingAt"
    // 最近主动说出去的几句话。存在的唯一理由：不许反复问同一件事
    // （老大反馈「胃有点痛」之后连着四天每条都是「醒了没，胃还痛不痛」）。
    private const val KEY_RECENT_SENT = "recentSent"
    // 只留最近 8 条，够覆盖「这几天都在问什么」，又不至于把 SharedPreferences 撑大。
    private const val RECENT_SENT_MAX = 8

    data class Material(
        val persona: String,
        val endpoint: String,
        val model: String,
        val minGapMs: Long,
        val maxGapMs: Long,
        val quietStart: Int,
        val quietEnd: Int,
        val dailyMin: Int,
        val dailyMax: Int,
        val memories: List<Pair<String, String>>,
        val recent: List<Pair<String, String>>,
        val at: Long,
    )

    private fun prefs(context: Context): SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    // —— 最近说过的话（防复读） ——

    /** 一条已经发出去的主动消息。at 用来在 prompt 里写成「昨天 / 前天」。 */
    data class Sent(val text: String, val at: Long)

    /**
     * 两句是不是在说同一件事。
     *
     * 两个口径取大的那个，缺一个都会漏：
     *   1. **字符 2-gram 重合率**（分母取短句）——抓逐字重复和改几个字的重复，
     *      「在干嘛呢」对「在干嘛」是 1.0。
     *   2. **主题字重合率**——去掉虚词和时间词，只看实字的重合。
     *      「醒了没，胃还痛不痛」对「醒了没，今天胃好点没」，2-gram 只有 0.29，
     *      但主题字都是 {醒,胃,痛} 对 {醒,胃,好,点}，重合 0.5 —— **这才是同一件事**。
     *      老大抱怨的四天复读，每天的措辞正好都只有这种程度的差别。
     *
     * 分母取 min 而不是并集：一句话多加半句寒暄（「外面下雨了，你带伞没」）时，
     * 并集会把重合率稀释到看不出是同一件事。
     */
    fun similarity(a: String, b: String): Double = maxOf(gramSimilarity(a, b), themeSimilarity(a, b))

    private fun gramSimilarity(a: String, b: String): Double {
        val ga = grams(a)
        val gb = grams(b)
        if (ga.isEmpty() || gb.isEmpty()) return 0.0
        var hit = 0
        ga.forEach { if (gb.contains(it)) hit += 1 }
        // 分母 +2 是惩罚：短句的 gram 少，一两个偶然相同的 gram（「昨天」「去了」）
        // 就能顶到 0.5，把「昨天下午去了海边」和「昨天你去哪儿了」判成同一件事。
        // 加个常数项后，只有真正大面积重合才会越过阈值。
        return hit.toDouble() / (minOf(ga.size, gb.size) + 2).toDouble()
    }

    /** 去掉标点空白和语气尾巴，只留字。 */
    private fun grams(text: String): Set<String> {
        val clean = text.lowercase().filter { it.isLetterOrDigit() }
        if (clean.length < 2) return if (clean.isEmpty()) emptySet() else setOf(clean)
        val out = HashSet<String>(clean.length)
        for (i in 0 until clean.length - 1) out.add(clean.substring(i, i + 2))
        return out
    }

    /**
     * 虚词/语气字。这些字在任何句子里都出现，拿它们算重合会把「今天中午吃了什么」
     * 和「醒了没，胃还痛不痛」也算成有关（都含「了」「没」）。
     */
    private const val STOP_CHARS = "的了是我你他她它吗呀呢吧啊嘛哦嗯么没不还就都也很在要有会能可这那哪什么怎" +
        "样得地过啦哈咱俺"

    /** 时间词整词剔。「今天胃好点没」和「今天中午吃了什么」共有的「今天」不构成同主题。 */
    private val TIME_WORDS = listOf(
        "今天", "明天", "昨天", "前天", "后天", "早上", "上午", "中午", "下午", "晚上",
        "夜里", "现在", "刚才", "刚刚", "最近", "这几天", "这会儿", "一早",
    )

    /**
     * 身体部位与症状字。两个句子只要共享其中任何一个，就当在说同一件事。
     *
     * 「醒了没，胃还痛不痛」和「记得吃早饭，别饿着胃」字面几乎不重合（theme 0、gram 0），
     * 但对他来说这就是同一件事问了第四遍。部位词是这一小类话题的共同锚点。
     */
    private const val SENSITIVE_CHARS = "胃头牙嗓腰肚腿眼背胸腹喉肩膝手"

    private fun themeSimilarity(a: String, b: String): Double {
        val ca = themeChars(a)
        val cb = themeChars(b)
        if (ca.isEmpty() || cb.isEmpty()) return 0.0
        var hit = 0
        ca.forEach { if (cb.contains(it)) hit += 1 }
        // 只重合一个字不算同主题 —— 「昨天你去哪儿了」的主题字只剩 {去,儿}，
        // 跟「海边捡石头……」共用一个「去」就 0.5，会把问行踪误判成问石头。
        // 两个以上的实字重合才说明真在说同一件事；一字主题的短句交给 gram 那条口径兜。
        if (hit < 2) {
            var shared = false
            ca.forEach { c -> if (SENSITIVE_CHARS.contains(c) && cb.contains(c)) shared = true }
            if (!shared) return 0.0
            hit = 2
        }
        return hit.toDouble() / maxOf(2, minOf(ca.size, cb.size)).toDouble()
    }

    /** 主题字 = 去掉时间词与虚词之后剩下的汉字。「疼」归一成「痛」，同一个意思换字要能认出来。 */
    private fun themeChars(text: String): Set<Char> {
        var s = text.lowercase()
        TIME_WORDS.forEach { w -> s = s.replace(w, "") }
        val out = HashSet<Char>(s.length)
        s.forEach { c ->
            if (c in '\u4e00'..'\u9fff' && !STOP_CHARS.contains(c)) out.add(if (c == '疼') '痛' else c)
        }
        return out
    }

    /** 这句话是不是最近说过的某一句（有则返回那一条）。 */
    fun repeatedOf(text: String, recent: List<Sent>, threshold: Double = 0.5): Sent? =
        recent.firstOrNull { similarity(text, it.text) >= threshold }

    /**
     * 记忆这条是不是「上次已经问过了」。title+body 一起比，命中就说明这句话就是从它来的。
     *
     * 阈值比复读判定松（0.45 对 0.5）：记忆是长句、发出去的是短句，长句对短句的重合率天然低；
     * 而这里判错的代价是「这条记忆被剔掉」，比反过来让模型反复看见它要好。
     */
    fun memoryCovered(memory: Pair<String, String>, recent: List<Sent>, threshold: Double = 0.45): Sent? {
        val body = (memory.first + " " + memory.second).trim()
        if (body.isBlank()) return null
        return recent.firstOrNull { similarity(body, it.text) >= threshold }
    }

    fun recentSent(context: Context): List<Sent> {
        val raw = prefs(context).getString(KEY_RECENT_SENT, "") ?: ""
        if (raw.isBlank()) return emptyList()
        return try {
            val arr = JSONArray(raw)
            val out = ArrayList<Sent>(arr.length())
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val text = o.optString("text").trim()
                if (text.isNotEmpty()) out.add(Sent(text, o.optLong("at", 0L)))
            }
            out
        } catch (e: Exception) {
            emptyList()
        }
    }

    private fun appendSent(context: Context, text: String, at: Long) {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return
        val list = ArrayList(recentSent(context))
        list.add(Sent(trimmed, at))
        while (list.size > RECENT_SENT_MAX) list.removeAt(0)
        val arr = JSONArray()
        list.forEach { s ->
            arr.put(JSONObject().apply { put("text", s.text); put("at", s.at) })
        }
        prefs(context).edit().putString(KEY_RECENT_SENT, arr.toString()).apply()
    }

    // —— 素材 ——

    fun writeMaterial(
        context: Context,
        persona: String,
        endpoint: String,
        model: String,
        minGapMs: Long,
        maxGapMs: Long,
        quietStart: Int,
        quietEnd: Int,
        dailyMin: Int = 0,
        dailyMax: Int = 3,
        memories: List<Pair<String, String>>,
        recent: List<Pair<String, String>>,
    ) {
        val json = JSONObject().apply {
            put("persona", persona)
            put("endpoint", endpoint)
            put("model", model)
            put("minGapMs", minGapMs)
            put("maxGapMs", maxGapMs)
            put("quietStart", quietStart)
            put("quietEnd", quietEnd)
            put("dailyMin", dailyMin)
            put("dailyMax", dailyMax)
            put("at", System.currentTimeMillis())
            put("memories", JSONArray().apply {
                memories.forEach { (title, body) ->
                    put(JSONObject().apply { put("title", title); put("body", body) })
                }
            })
            put("recent", JSONArray().apply {
                recent.forEach { (role, text) ->
                    put(JSONObject().apply { put("role", role); put("text", text) })
                }
            })
        }
        prefs(context).edit().putString(KEY_MATERIAL, json.toString()).apply()
    }

    fun readMaterial(context: Context): Material? {
        val raw = prefs(context).getString(KEY_MATERIAL, "") ?: ""
        if (raw.isBlank()) return null
        return try {
            val json = JSONObject(raw)
            val memories = mutableListOf<Pair<String, String>>()
            json.optJSONArray("memories")?.let { arr ->
                for (i in 0 until arr.length()) {
                    val o = arr.optJSONObject(i) ?: continue
                    memories.add(o.optString("title") to o.optString("body"))
                }
            }
            val recent = mutableListOf<Pair<String, String>>()
            json.optJSONArray("recent")?.let { arr ->
                for (i in 0 until arr.length()) {
                    val o = arr.optJSONObject(i) ?: continue
                    recent.add(o.optString("role") to o.optString("text"))
                }
            }
            Material(
                persona = json.optString("persona"),
                endpoint = json.optString("endpoint"),
                model = json.optString("model"),
                minGapMs = json.optLong("minGapMs", 60 * 60 * 1000L),
                maxGapMs = json.optLong("maxGapMs", 3 * 60 * 60 * 1000L),
                quietStart = json.optInt("quietStart", 23),
                quietEnd = json.optInt("quietEnd", 8),
                dailyMin = json.optInt("dailyMin", 0),
                dailyMax = json.optInt("dailyMax", 3),
                memories = memories,
                recent = recent,
                at = json.optLong("at", 0L),
            )
        } catch (e: Exception) {
            null
        }
    }

    // —— 开关 ——

    fun enabled(context: Context): Boolean = prefs(context).getBoolean(KEY_ENABLED, false)

    fun setEnabled(context: Context, on: Boolean) {
        prefs(context).edit().putBoolean(KEY_ENABLED, on).apply()
    }

    fun profileId(context: Context): String = prefs(context).getString(KEY_PROFILE, "") ?: ""

    fun setProfileId(context: Context, id: String) {
        prefs(context).edit().putString(KEY_PROFILE, id).apply()
    }

    // —— 排程与状态 ——

    fun nextAt(context: Context): Long = prefs(context).getLong(KEY_NEXT, 0L)

    fun setNextAt(context: Context, at: Long) {
        prefs(context).edit().putLong(KEY_NEXT, at).apply()
    }

    fun lastAt(context: Context): Long = prefs(context).getLong(KEY_LAST_AT, 0L)

    /** 用户最后一次离开 App 的时间。0 表示还没记录过（新装或刚清过数据）。 */
    fun lastUserAt(context: Context): Long = prefs(context).getLong(KEY_LAST_USER_AT, 0L)

    /** 记一笔「用户刚动过」——现在只在 App 退到后台时调，语义就是「刚聊完」。 */
    fun noteUserLeft(context: Context, at: Long = System.currentTimeMillis()) {
        prefs(context).edit().putLong(KEY_LAST_USER_AT, at).apply()
    }

    fun isForeground(context: Context): Boolean = prefs(context).getBoolean(KEY_FOREGROUND, false)

    fun setForeground(context: Context, on: Boolean) {
        prefs(context).edit().putBoolean(KEY_FOREGROUND, on).apply()
    }

    fun lastStatus(context: Context): String = prefs(context).getString(KEY_LAST_STATUS, "") ?: ""

    fun lastError(context: Context): String = prefs(context).getString(KEY_LAST_ERROR, "") ?: ""

    fun markRun(context: Context, status: String, error: String) {
        prefs(context).edit()
            .putLong(KEY_LAST_AT, System.currentTimeMillis())
            .putString(KEY_LAST_STATUS, status)
            .putString(KEY_LAST_ERROR, error)
            .apply()
    }

    // —— 今日条数（下限 dailyMin 的依据） ——

    /** 本地日期键。跨零点要能分清今天和昨天，所以不能用 UTC。 */
    private fun dayKey(at: Long = System.currentTimeMillis()): String {
        val cal = java.util.Calendar.getInstance().apply { timeInMillis = at }
        val y = cal.get(java.util.Calendar.YEAR)
        val m = cal.get(java.util.Calendar.MONTH) + 1
        val d = cal.get(java.util.Calendar.DAY_OF_MONTH)
        return "$y-$m-$d"
    }

    /** 今天真发出去几条（跨天自动归零）。 */
    fun sentToday(context: Context): Int {
        val p = prefs(context)
        val day = p.getString(KEY_SENT_DAY, "") ?: ""
        if (day != dayKey()) return 0
        return p.getInt(KEY_SENT_COUNT, 0)
    }

    /**
     * 记一条「真发出去了」。只有 Runner 在拿到模型回复、写完待读槽之后才调。
     *
     * text 传了就会同时进「最近说过的话」——下一次组 prompt 时拿它挡住复读。
     */
    fun noteSent(context: Context, text: String = "") {
        val p = prefs(context)
        val today = dayKey()
        val same = (p.getString(KEY_SENT_DAY, "") ?: "") == today
        p.edit()
            .putString(KEY_SENT_DAY, today)
            .putInt(KEY_SENT_COUNT, if (same) p.getInt(KEY_SENT_COUNT, 0) + 1 else 1)
            .apply()
        if (text.isNotBlank()) appendSent(context, text, System.currentTimeMillis())
    }

    // —— 待读消息（单槽） ——

    fun putPending(context: Context, text: String, type: String) {
        prefs(context).edit()
            .putString(KEY_PENDING_TEXT, text)
            .putString(KEY_PENDING_TYPE, type)
            .putLong(KEY_PENDING_AT, System.currentTimeMillis())
            .apply()
    }

    fun hasPending(context: Context): Boolean =
        (prefs(context).getString(KEY_PENDING_TEXT, "") ?: "").isNotBlank()

    fun pendingType(context: Context): String = prefs(context).getString(KEY_PENDING_TYPE, "") ?: ""

    fun pendingAt(context: Context): Long = prefs(context).getLong(KEY_PENDING_AT, 0L)

    /** 取走并清空；type 不匹配就不取（聊天回复与主动消息共用这一个槽）。 */
    fun takePending(context: Context, type: String): String? {
        val p = prefs(context)
        val text = p.getString(KEY_PENDING_TEXT, "") ?: ""
        val kind = p.getString(KEY_PENDING_TYPE, "") ?: ""
        if (text.isBlank()) return null
        if (type.isNotEmpty() && kind != type) return null
        p.edit()
            .remove(KEY_PENDING_TEXT)
            .remove(KEY_PENDING_TYPE)
            .remove(KEY_PENDING_AT)
            .apply()
        return text
    }

    fun state(context: Context): JSObject {
        val material = readMaterial(context)
        val out = JSObject()
        out.put("available", true)
        out.put("enabled", enabled(context))
        out.put("permission", EllenProactiveScheduler.permissionState(context))
        out.put("nextAt", nextAt(context))
        out.put("lastAt", lastAt(context))
        out.put("lastStatus", lastStatus(context))
        out.put("lastError", lastError(context))
        out.put("hasPending", hasPending(context))
        out.put("materialAt", material?.at ?: 0L)
        out.put("sentToday", sentToday(context))
        out.put("dailyMin", material?.dailyMin ?: 0)
        out.put("dailyMax", material?.dailyMax ?: 0)
        out.put("memories", material?.memories?.size ?: 0)
        out.put("recent", material?.recent?.size ?: 0)
        out.put("model", material?.model.orEmpty())
        return out
    }
}
