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

    private const val PREFS = "ellen-proactive-v1"
    private const val KEY_MATERIAL = "material"
    private const val KEY_ENABLED = "enabled"
    private const val KEY_PROFILE = "profileId"
    private const val KEY_NEXT = "nextAt"
    private const val KEY_LAST_AT = "lastAt"
    private const val KEY_LAST_STATUS = "lastStatus"
    private const val KEY_LAST_ERROR = "lastError"
    private const val KEY_PENDING_TEXT = "pendingText"
    private const val KEY_PENDING_TYPE = "pendingType"
    private const val KEY_PENDING_AT = "pendingAt"

    data class Material(
        val persona: String,
        val endpoint: String,
        val model: String,
        val minGapMs: Long,
        val maxGapMs: Long,
        val quietStart: Int,
        val quietEnd: Int,
        val memories: List<Pair<String, String>>,
        val recent: List<Pair<String, String>>,
        val at: Long,
    )

    private fun prefs(context: Context): SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

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

    fun lastStatus(context: Context): String = prefs(context).getString(KEY_LAST_STATUS, "") ?: ""

    fun lastError(context: Context): String = prefs(context).getString(KEY_LAST_ERROR, "") ?: ""

    fun markRun(context: Context, status: String, error: String) {
        prefs(context).edit()
            .putLong(KEY_LAST_AT, System.currentTimeMillis())
            .putString(KEY_LAST_STATUS, status)
            .putString(KEY_LAST_ERROR, error)
            .apply()
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
        out.put("memories", material?.memories?.size ?: 0)
        out.put("recent", material?.recent?.size ?: 0)
        out.put("model", material?.model.orEmpty())
        return out
    }
}
