package cn.ellen.companion2.plugin

import cn.ellen.companion2.vault.EllenVault
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * 密钥读写（旧包同名插件）。
 *
 * scope 是白名单：一个 scope 存一个字符串。model 那桶放的是整段配置 JSON
 * （endpoint / model / apiKey / platform），asr / tts / voice 各放一枚裸 key。
 * 早期版本只认 model 和 voice，导致 asr/tts 一写就报 "Invalid scope"，
 * 界面只显示一句「没存上」，很不好查。
 */
@CapacitorPlugin(name = "EllenSecureConfig")
class EllenSecureConfigPlugin : Plugin() {

    private val allowed = setOf("model", "voice", "asr", "tts")

    private fun scopeOf(call: PluginCall): String {
        val scope = call.getString("scope")?.trim().orEmpty()
        if (scope !in allowed) throw IllegalArgumentException("Invalid scope")
        return scope
    }

    @PluginMethod
    fun read(call: PluginCall) {
        val scope = try {
            scopeOf(call)
        } catch (e: IllegalArgumentException) {
            call.reject("不认识的配置项。", "INVALID_SCOPE")
            return
        }
        val out = JSObject()
        out.put("value", EllenVault.read(context, scope))
        out.put("scope", scope)
        call.resolve(out)
    }

    @PluginMethod
    fun write(call: PluginCall) {
        val scope = try {
            scopeOf(call)
        } catch (e: IllegalArgumentException) {
            call.reject("不认识的配置项。", "INVALID_SCOPE")
            return
        }
        val value = call.getString("value") ?: ""
        EllenVault.write(context, scope, value)
        val out = JSObject()
        out.put("ok", true)
        out.put("scope", scope)
        out.put("bytes", value.toByteArray(Charsets.UTF_8).size)
        call.resolve(out)
    }

    @PluginMethod
    fun remove(call: PluginCall) {
        val scope = try {
            scopeOf(call)
        } catch (e: IllegalArgumentException) {
            call.reject("不认识的配置项。", "INVALID_SCOPE")
            return
        }
        val out = JSObject()
        out.put("ok", true)
        out.put("had", EllenVault.remove(context, scope))
        call.resolve(out)
    }
}
