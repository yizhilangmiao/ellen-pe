package cn.ellen.companion2.plugin

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.PermissionCallback
import cn.ellen.companion2.proactive.EllenProactiveRunner
import cn.ellen.companion2.proactive.EllenProactiveScheduler
import cn.ellen.companion2.proactive.EllenProactiveStore

/**
 * 主动消息的对外接口。web 侧只做「配置与取回」，执行全在 native。
 *
 * 七个方法对应 core/proactive.js：state / setContext / configure / consumeOpen /
 * runNow / scheduleIn / requestBackgroundPermission。
 */
@CapacitorPlugin(
    name = "EllenAutonomy",
    permissions = [Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS])],
)
class EllenAutonomyPlugin : Plugin() {

    @PluginMethod
    fun state(call: PluginCall) {
        call.resolve(EllenProactiveStore.state(context))
    }

    @PluginMethod
    fun setContext(call: PluginCall) {
        val memories = mutableListOf<Pair<String, String>>()
        call.getArray("memories")?.let { arr ->
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                memories.add(o.optString("title") to o.optString("body"))
            }
        }
        val recent = mutableListOf<Pair<String, String>>()
        call.getArray("recent")?.let { arr ->
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                recent.add(o.optString("role") to o.optString("text"))
            }
        }

        EllenProactiveStore.writeMaterial(
            context = context,
            persona = call.getString("persona").orEmpty(),
            endpoint = call.getString("endpoint").orEmpty(),
            model = call.getString("model").orEmpty(),
            minGapMs = call.getLong("minGapMs") ?: (60L * 60 * 1000),
            maxGapMs = call.getLong("maxGapMs") ?: (3L * 60 * 60 * 1000),
            quietStart = call.getInt("quietStart") ?: 23,
            quietEnd = call.getInt("quietEnd") ?: 8,
            memories = memories,
            recent = recent,
        )

        // 素材变了就重排：不然刚改成「常来找我」还要等上一轮的老闹钟
        val nextAt = if (EllenProactiveStore.enabled(context)) EllenProactiveScheduler.scheduleNext(context) else 0L
        val out = EllenProactiveStore.state(context)
        out.put("nextAt", nextAt)
        call.resolve(out)
    }

    @PluginMethod
    fun configure(call: PluginCall) {
        val enabled = call.getBoolean("enabled") ?: false
        EllenProactiveStore.setEnabled(context, enabled)
        EllenProactiveStore.setProfileId(context, call.getString("profileId").orEmpty())

        val nextAt = if (enabled) EllenProactiveScheduler.scheduleNext(context) else {
            EllenProactiveScheduler.cancel(context)
            0L
        }
        val out = EllenProactiveStore.state(context)
        out.put("nextAt", nextAt)
        call.resolve(out)
    }

    @PluginMethod
    fun consumeOpen(call: PluginCall) {
        val text = EllenProactiveStore.takePending(context, "proactive")
        val out = JSObject()
        if (text.isNullOrBlank()) {
            out.put("type", "")
            out.put("text", "")
        } else {
            out.put("type", "proactive")
            out.put("text", text)
            out.put("at", EllenProactiveStore.pendingAt(context))
        }
        call.resolve(out)
    }

    @PluginMethod
    fun runNow(call: PluginCall) {
        val dryRun = call.getBoolean("dryRun") ?: false
        val result = EllenProactiveRunner.run(context, dryRun)
        val out = JSObject()
        out.put("ok", result.ok)
        out.put("text", result.text)
        out.put("code", result.code)
        out.put("detail", result.detail)
        out.put("ms", result.ms)
        call.resolve(out)
    }

    @PluginMethod
    fun scheduleIn(call: PluginCall) {
        val delayMs = call.getLong("delayMs") ?: 30_000L
        val at = EllenProactiveScheduler.scheduleIn(context, delayMs)
        val out = JSObject()
        out.put("nextAt", at)
        out.put("grantedExact", EllenProactiveScheduler.permissionState(context))
        call.resolve(out)
    }

    @PluginMethod
    fun requestBackgroundPermission(call: PluginCall) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            getPermissionState("notifications") != com.getcapacitor.PermissionState.GRANTED
        ) {
            requestPermissionForAlias("notifications", call, "notificationsCallback")
            return
        }
        // 通知有了，再顺手看一眼精确闹钟（Android 12+ 可能被用户关掉）
        openExactAlarmSettingsIfNeeded()
        call.resolve(permissionPayload())
    }

    @PermissionCallback
    private fun notificationsCallback(call: PluginCall) {
        openExactAlarmSettingsIfNeeded()
        call.resolve(permissionPayload())
    }

    private fun permissionPayload(): JSObject = JSObject().apply {
        put("permission", EllenProactiveScheduler.permissionState(context))
    }

    private fun openExactAlarmSettingsIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        val manager = context.getSystemService(android.app.AlarmManager::class.java) ?: return
        if (manager.canScheduleExactAlarms()) return
        try {
            activity.startActivity(
                Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM).apply {
                    data = Uri.parse("package:${context.packageName}")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
            )
        } catch (_: Exception) {
            /* 有些 ROM 没这个页面，忽略即可：闹钟会自动退到非精确模式 */
        }
    }

    override fun handleOnDestroy() {
        super.handleOnDestroy()
    }
}
