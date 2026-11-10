package cn.ellen.companion2.plugin

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import cn.ellen.companion2.background.EllenBackgroundService
import cn.ellen.companion2.background.EllenBackgroundState
import cn.ellen.companion2.proactive.EllenProactiveRunner
import cn.ellen.companion2.proactive.EllenProactiveStore

/**
 * 前台保活 + 后台到齐的消息收件箱。
 *
 * web 侧（core/background.js）只调 update / state / stop / consumeMessageOpen，
 * 其余几个方法是旧包契约里的，保留实现以免将来接通知跳转时缺件。
 */
@CapacitorPlugin(name = "EllenBackground")
class EllenBackgroundPlugin : Plugin() {

    private val sessionPattern = Regex("[A-Za-z0-9._:-]{1,160}")
    private val threadPattern = Regex("[A-Za-z0-9._:-]{1,200}")
    private val profilePattern = Regex("[A-Za-z0-9_.:-]{1,180}")

    private fun wording(reply: Boolean, media: Boolean, organize: Boolean, done: Int, total: Int): String = when {
        organize -> if (total > 0) "在整理手记（$done/$total）" else "在整理手记"
        media -> "在念给你听"
        reply -> "在想这句话"
        else -> "在这里"
    }

    @PluginMethod
    fun update(call: PluginCall) {
        val sessionId = call.getString("sessionId").orEmpty()
        if (sessionId.isNotEmpty() && !sessionPattern.matches(sessionId)) {
            call.reject("后台任务编号不对。", "INVALID_BACKGROUND_WORK")
            return
        }
        val threadId = call.getString("threadId").orEmpty()
        if (threadId.isNotEmpty() && !threadPattern.matches(threadId)) {
            call.reject("后台任务归属无效。", "INVALID_BACKGROUND_WORK")
            return
        }
        val profileId = call.getString("organizationProfileId").orEmpty()
        if (profileId.isNotEmpty() && !profilePattern.matches(profileId)) {
            call.reject("后台任务归属无效。", "INVALID_BACKGROUND_WORK")
            return
        }

        val reply = call.getBoolean("replyActive") ?: false
        val media = call.getBoolean("mediaActive") ?: false
        val paused = call.getBoolean("paused") ?: false
        val organize = call.getBoolean("organizationActive") ?: false
        val total = call.getInt("organizationTotal") ?: 0
        val done = call.getInt("organizationDone") ?: 0

        val wantRunning = !paused && (reply || media || organize)
        val text = wording(reply, media, organize, done, total)
        var started = false
        var error = ""

        if (wantRunning) {
            started = EllenBackgroundService.start(context, text)
            if (!started) error = "系统没让在后台起服务（可能刚切到后台）。"
        } else {
            EllenBackgroundService.stop(context)
        }

        val state = EllenBackgroundState.updateState(context) {
            it.put("sessionId", sessionId)
            it.put("threadId", threadId)
            it.put("replyActive", reply)
            it.put("mediaActive", media)
            it.put("paused", paused)
            it.put("organizationActive", organize)
            it.put("organizationTotal", total)
            it.put("organizationDone", done)
            it.put("text", text)
            it.put("running", if (wantRunning) started else false)
            it.put("lastError", error)
            it.put("at", System.currentTimeMillis())
        }

        val out = EllenBackgroundState.toJs(context)
        out.put("ok", true)
        out.put("running", state.optBoolean("running", false))
        out.put("lastError", error)
        call.resolve(out)
    }

    @PluginMethod
    fun state(call: PluginCall) {
        call.resolve(EllenBackgroundState.toJs(context))
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        EllenBackgroundService.stop(context)
        EllenBackgroundState.updateState(context) {
            it.put("running", false)
            it.put("replyActive", false)
            it.put("mediaActive", false)
            it.put("organizationActive", false)
        }
        val out = JSObject()
        out.put("ok", true)
        call.resolve(out)
    }

    @PluginMethod
    fun close(call: PluginCall) {
        stop(call)
    }

    // —— 收件箱 ——

    @PluginMethod
    fun messageArrived(call: PluginCall) {
        val text = call.getString("text").orEmpty().trim()
        if (text.isEmpty()) {
            call.reject("没有消息内容。", "INVALID_BACKGROUND_WORK")
            return
        }
        val threadId = call.getString("threadId").orEmpty()
        EllenProactiveStore.putPending(context, text, "chat")
        EllenProactiveRunner.showNotification(context, text)
        EllenBackgroundState.updateState(context) {
            it.put("threadId", threadId)
            it.put("pendingAt", System.currentTimeMillis())
        }
        val out = JSObject()
        out.put("ok", true)
        call.resolve(out)
    }

    @PluginMethod
    fun consumeMessageOpen(call: PluginCall) {
        consumeOf(call, "chat")
    }

    @PluginMethod
    fun consumeOpen(call: PluginCall) {
        consumeOf(call, "proactive")
    }

    private fun consumeOf(call: PluginCall, type: String) {
        val text = EllenProactiveStore.takePending(context, type)
        val out = JSObject()
        if (text.isNullOrBlank()) {
            out.put("type", "")
            out.put("text", "")
        } else {
            out.put("type", type)
            out.put("text", text)
        }
        call.resolve(out)
    }

    @PluginMethod
    fun messageContext(call: PluginCall) {
        val state = EllenBackgroundState.read(context)
        val out = JSObject()
        out.put("threadId", state.optString("threadId"))
        out.put("at", state.optLong("pendingAt", 0L))
        call.resolve(out)
    }

    // —— 通知设置 ——

    @PluginMethod
    fun notificationSettings(call: PluginCall) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
        val out = JSObject()
        out.put("enabled", manager?.areNotificationsEnabled() ?: true)
        out.put("channel", EllenBackgroundService.CHANNEL_ID)
        call.resolve(out)
    }

    @PluginMethod
    fun requestPermission(call: PluginCall) {
        openNotificationSettings()
        val out = JSObject()
        out.put("ok", true)
        call.resolve(out)
    }

    @PluginMethod
    fun requestInitialPermission(call: PluginCall) {
        openNotificationSettings()
        val out = JSObject()
        out.put("ok", true)
        call.resolve(out)
    }

    private fun openNotificationSettings() {
        try {
            val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                    putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                }
            } else {
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = android.net.Uri.parse("package:${context.packageName}")
                }
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
        } catch (_: Exception) {
            /* 有些 ROM 没有这个页面 */
        }
    }
}
