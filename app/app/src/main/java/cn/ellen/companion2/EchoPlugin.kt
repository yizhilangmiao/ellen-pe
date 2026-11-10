package cn.ellen.companion2

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/** 探针插件：只回一句，用来确认 web 与原生这条桥是通的。 */
@CapacitorPlugin(name = "Echo")
class EchoPlugin : Plugin() {
    @PluginMethod
    fun echo(call: PluginCall) {
        val out = JSObject()
        out.put("value", call.getString("value") ?: "")
        call.resolve(out)
    }
}
