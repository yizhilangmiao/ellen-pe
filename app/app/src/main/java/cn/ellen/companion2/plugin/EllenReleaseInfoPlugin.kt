package cn.ellen.companion2.plugin

import android.content.pm.ApplicationInfo
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/** 版本信息。`debuggable` 用来决定设置页要不要露出「更新地址」这种调试入口。 */
@CapacitorPlugin(name = "EllenReleaseInfo")
class EllenReleaseInfoPlugin : Plugin() {

    @PluginMethod
    fun state(call: PluginCall) {
        val info = context.applicationInfo
        val pm = context.packageManager
        val pkgInfo = pm.getPackageInfo(context.packageName, 0)

        val out = JSObject()
        out.put("packageName", context.packageName)
        out.put("versionName", pkgInfo.versionName ?: "")
        out.put("versionCode", if (android.os.Build.VERSION.SDK_INT >= 28) pkgInfo.longVersionCode else pkgInfo.versionCode.toLong())
        out.put("debuggable", (info.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0)
        out.put("sdkInt", android.os.Build.VERSION.SDK_INT)
        out.put("device", android.os.Build.MODEL ?: "")
        call.resolve(out)
    }
}
