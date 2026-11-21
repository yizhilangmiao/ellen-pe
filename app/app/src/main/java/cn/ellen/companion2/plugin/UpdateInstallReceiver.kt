package cn.ellen.companion2.plugin

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Log

/**
 * 收 PackageInstaller 的会话结果。
 *
 * 为什么不用 FileProvider + ACTION_VIEW：小米（MIUI/HyperOS）的安装器会把「安装包扫描」
 * 交给另一个进程去做，临时 URI 授权只在 startActivity 的目标 Activity 上生效，
 * 扫描进程拿不到 → `Permission Denial: opening provider FileProvider ... not exported`，
 * 用户看到「解析软件包时出现问题。(11)」。
 * PackageInstaller 由我们直接把字节写进安装会话，全程不经过 FileProvider，
 * 也不跨进程传 URI，各家 ROM 都一样。
 *
 * 两条容易踩的：
 *  1. STATUS_PENDING_USER_ACTION 不是失败 —— 系统给了个确认页的 Intent，必须自己
 *     startActivity 起来，否则用户什么也看不到，会话就那么挂着。
 *  2. 结果要经 SharedPreferences 交回插件：BroadcastReceiver 和 Capacitor 插件不是
 *     同一个对象，静态变量在进程被回收后也会丢。
 */
class UpdateInstallReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: ""
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            val confirm = confirmIntent(intent)
            if (confirm == null) {
                prefs.edit()
                    .putString(KEY_RESULT, "fail")
                    .putString(KEY_MESSAGE, "系统没给安装确认页。")
                    .apply()
                return
            }
            confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            try {
                context.startActivity(confirm)
            } catch (e: Exception) {
                Log.w("EllenUpdates", "安装确认页没弹出来", e)
                prefs.edit()
                    .putString(KEY_RESULT, "fail")
                    .putString(KEY_MESSAGE, "安装确认页没弹出来。")
                    .apply()
            }
            return
        }

        val ok = status == PackageInstaller.STATUS_SUCCESS
        prefs.edit()
            .putString(KEY_RESULT, if (ok) "ok" else "fail")
            .putString(KEY_MESSAGE, if (ok) "装好了。" else describe(status, message))
            .apply()
    }

    @Suppress("DEPRECATION")
    private fun confirmIntent(intent: Intent): Intent? =
        if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
        else intent.getParcelableExtra(Intent.EXTRA_INTENT)

    /**
     * 把系统码翻成人话。原文里常带包名与堆栈，直接给用户看没意义，
     * 所以只在最后兜底时才把原文附上。
     */
    private fun describe(status: Int, message: String): String = when (status) {
        PackageInstaller.STATUS_FAILURE_ABORTED -> "安装被取消了。"
        PackageInstaller.STATUS_FAILURE_BLOCKED -> "系统拦下了这次安装（可能是不允许未知来源，或者安全软件拦了）。"
        PackageInstaller.STATUS_FAILURE_CONFLICT -> "装不上：这个包和已装的版本冲突，签名或包名对不上。"
        PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> "装不上：系统版本或 CPU 架构跟这个包不匹配。"
        PackageInstaller.STATUS_FAILURE_INVALID -> "装不上：安装包损坏了，重新下载一次试试。"
        PackageInstaller.STATUS_FAILURE_STORAGE -> "装不上：存储空间不够。"
        else -> if (message.isBlank()) "系统没装成。" else "系统没装成：$message"
    }

    companion object {
        const val PREFS = "ellen-updates-v1"
        const val KEY_RESULT = "installResult"
        const val KEY_MESSAGE = "installMessage"
    }
}
