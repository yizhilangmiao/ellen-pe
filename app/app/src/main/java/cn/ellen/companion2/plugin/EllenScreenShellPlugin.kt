package cn.ellen.companion2.plugin

import android.graphics.Color
import android.os.Build
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * 把 web 的主题同步到系统栏：状态栏/导航栏图标明暗 + 窗口底色。
 *
 * 不做这一步的症状：暗色主题下状态栏时间是黑的，看不见；切到浅色主题又反过来。
 */
@CapacitorPlugin(name = "EllenScreenShell")
class EllenScreenShellPlugin : Plugin() {

    @PluginMethod
    fun setAppearance(call: PluginCall) {
        val theme = (call.getString("theme") ?: "dark").lowercase()
        val light = theme == "light"
        val background = if (light) Color.parseColor("#F8F7F5") else Color.parseColor("#17191F")

        activity.runOnUiThread {
            try {
                val window = activity.window
                window.statusBarColor = background
                window.navigationBarColor = background

                val controller = androidx.core.view.WindowCompat.getInsetsController(window, window.decorView)
                // 浅底要深色图标（isAppearanceLightStatusBars = true）
                controller.isAppearanceLightStatusBars = light
                controller.isAppearanceLightNavigationBars = light

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    window.isStatusBarContrastEnforced = false
                    window.isNavigationBarContrastEnforced = false
                }
            } catch (e: Exception) {
                /* 个别 ROM 改了系统栏就崩，别为了配色把界面带走 */
            }
        }

        val out = JSObject()
        out.put("theme", theme)
        out.put("background", if (light) "#F8F7F5" else "#17191F")
        call.resolve(out)
    }
}
