package cn.ellen.companion2.background

import android.content.Context
import com.getcapacitor.JSObject
import org.json.JSONObject

/**
 * 保活服务的状态仓库（SharedPreferences 键值，一个 JSON 字符串）。
 *
 * 为什么要落盘：`update()` 与 `state()` 在插件进程里跑，服务本身在另一个组件里；
 * 进程被杀一次之后 web 再问 state，若只留内存变量就永远是「没在跑」。
 */
object EllenBackgroundState {

    private const val PREFS = "ellen-background-v1"
    private const val KEY_STATE = "state"

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun read(context: Context): JSONObject {
        val raw = prefs(context).getString(KEY_STATE, "") ?: ""
        if (raw.isBlank()) return JSONObject()
        return try {
            JSONObject(raw)
        } catch (e: Exception) {
            JSONObject()
        }
    }

    fun write(context: Context, json: JSONObject) {
        prefs(context).edit().putString(KEY_STATE, json.toString()).apply()
    }

    fun updateState(context: Context, block: (JSONObject) -> Unit): JSONObject {
        val json = read(context)
        block(json)
        write(context, json)
        return json
    }

    fun toJs(context: Context): JSObject {
        val json = read(context)
        val out = JSObject()
        val keys = json.keys()
        while (keys.hasNext()) {
            val k = keys.next()
            out.put(k, json.opt(k))
        }
        out.put("available", true)
        out.put("running", json.optBoolean("running", false))
        return out
    }
}
