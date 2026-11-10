package cn.ellen.companion2.plugin

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * 反馈通道：直接开邮件 App 的草稿，不经过任何第三方转发。
 *
 * 旧包写死 formsubmit.co 的中转地址，信要先到别人服务器再转给开发者 —— 那条链随时能停、
 * 能被看，离线就直接断。现在的做法：有邮件 App 就打开草稿（用户自己点发送），
 * 没有就把整封信放进剪贴板，怎么发由用户决定。
 */
@CapacitorPlugin(name = "EllenFeedback")
class EllenFeedbackPlugin : Plugin() {

    private val to = "1520208183@qq.com"
    private val maxSubject = 120
    private val maxBody = 20_000

    private fun version(): String = try {
        context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: ""
    } catch (e: Exception) {
        ""
    }

    @PluginMethod
    fun info(call: PluginCall) {
        val out = JSObject()
        out.put("to", to)
        out.put("subject", "艾莲手机版 ${version()} · 反馈")
        out.put("version", version())
        out.put("hasMailApp", hasMailApp())
        call.resolve(out)
    }

    private fun hasMailApp(): Boolean = try {
        val intent = Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:")).apply {
            addCategory(Intent.CATEGORY_DEFAULT)
        }
        context.packageManager.resolveActivity(intent, 0) != null
    } catch (e: Exception) {
        false
    }

    @PluginMethod
    fun send(call: PluginCall) {
        val subject = (call.getString("subject") ?: "艾莲手机版反馈").trim().take(maxSubject)
        val body = (call.getString("body") ?: "").trim()
        if (body.isEmpty()) {
            call.reject("信里还没有内容。", "FEEDBACK_EMPTY")
            return
        }
        if (body.length > maxBody) {
            call.reject("这封信太长了，拆成两封吧。", "FEEDBACK_TOO_LONG")
            return
        }

        val out = JSObject()
        if (hasMailApp()) {
            try {
                // mailto 的参数必须走 Uri.Builder，直接拼字符串会把中文吃掉
                val uri = Uri.Builder()
                    .scheme("mailto")
                    .opaquePart(to)
                    .appendQueryParameter("subject", subject)
                    .appendQueryParameter("body", body)
                    .build()
                val intent = Intent(Intent.ACTION_SENDTO, uri).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(intent)
                out.put("ok", true)
                out.put("via", "mail")
                call.resolve(out)
                return
            } catch (e: Exception) {
                /* 落到剪贴板 */
            }
        }

        if (copyText("$subject\n\n$body")) {
            out.put("ok", true)
            out.put("via", "clipboard")
            call.resolve(out)
        } else {
            call.reject("这台机器没有邮件 App，剪贴板也写不进去。", "FEEDBACK_UNAVAILABLE")
        }
    }

    @PluginMethod
    fun copy(call: PluginCall) {
        val text = call.getString("text") ?: ""
        if (text.isEmpty()) {
            call.reject("没有要复制的内容。", "FEEDBACK_EMPTY")
            return
        }
        val ok = copyText(text)
        val out = JSObject()
        out.put("copied", ok)
        call.resolve(out)
    }

    private fun copyText(text: String): Boolean = try {
        val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        if (manager == null) false else {
            manager.setPrimaryClip(ClipData.newPlainText("艾莲反馈", text))
            true
        }
    } catch (e: Exception) {
        false
    }
}
