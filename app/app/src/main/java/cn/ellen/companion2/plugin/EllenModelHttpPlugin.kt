package cn.ellen.companion2.plugin

import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * 模型服务的流式 HTTP 通道。
 *
 * 契约（web 侧 core/chat/session.js、core/chat/oneshot.js 都按这个写）：
 *   open({requestId, url, apiKey, body}) → {status}
 *   read({requestId, sequence})          → {data: base64, done: bool}   sequence 从 1 开始
 *   cancel({requestId})
 *
 * body 必须是字符串。web 那边如果忘了 JSON.stringify，`call` 层会把对象原样塞过来，
 * 这里拿到就不是合法 JSON，直接报错比让服务端返回 400 更好查。
 */
@CapacitorPlugin(name = "EllenModelHttp")
class EllenModelHttpPlugin : Plugin() {

    private val requestIdPattern = Regex("[A-Za-z0-9._:-]{1,120}")

    private fun checkId(call: PluginCall): String? {
        val raw = call.getString("requestId")?.trim().orEmpty()
        if (raw.isEmpty()) {
            call.reject("请求编号不能为空。", "INVALID_MODEL_HTTP_REQUEST")
            return null
        }
        if (!requestIdPattern.matches(raw)) {
            call.reject("请求编号里有不认识的字符。", "INVALID_MODEL_HTTP_REQUEST")
            return null
        }
        return raw
    }

    @PluginMethod
    fun open(call: PluginCall) {
        val requestId = checkId(call) ?: return
        val url = call.getString("url")?.trim().orEmpty()
        val body = call.getString("body").orEmpty()
        val apiKey = call.getString("apiKey").orEmpty()

        if (url.isEmpty()) {
            call.reject("还没有配模型服务地址。", "INVALID_MODEL_HTTP_REQUEST")
            return
        }
        if (body.isBlank()) {
            call.reject("请求内容是空的。", "INVALID_MODEL_HTTP_REQUEST")
            return
        }

        try {
            val opened = ModelHttpTransport.open(requestId, url, apiKey, body)
            val out = JSObject()
            out.put("status", opened.status)
            opened.contentType?.let { out.put("contentType", it) }
            call.resolve(out)
        } catch (e: TransportError) {
            call.reject(e.message, e.code)
        } catch (e: Exception) {
            // 顶层兜底：宁可给一句带类名的实话，也不要泛化的「操作未完成」
            call.reject("聊天连接操作未完成。${e.javaClass.simpleName}: ${e.message.orEmpty().take(160)}", "MODEL_HTTP_FAILED")
        }
    }

    @PluginMethod
    fun read(call: PluginCall) {
        val requestId = checkId(call) ?: return
        val sequence = (call.getInt("sequence") ?: 1).coerceAtLeast(1)

        try {
            val chunk = ModelHttpTransport.read(requestId, sequence)
            val out = JSObject()
            out.put("data", Base64.encodeToString(chunk.data, Base64.NO_WRAP))
            out.put("done", chunk.done)
            out.put("seq", sequence)
            call.resolve(out)
        } catch (e: TransportError) {
            call.reject(e.message, e.code)
        } catch (e: Exception) {
            call.reject("读模型回应时出了点问题。${e.javaClass.simpleName}: ${e.message.orEmpty().take(160)}", "MODEL_HTTP_FAILED")
        }
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        val requestId = checkId(call) ?: return
        ModelHttpTransport.cancel(requestId)
        val out = JSObject()
        out.put("ok", true)
        call.resolve(out)
    }

    override fun handleOnDestroy() {
        ModelHttpTransport.closeAll()
        super.handleOnDestroy()
    }
}
