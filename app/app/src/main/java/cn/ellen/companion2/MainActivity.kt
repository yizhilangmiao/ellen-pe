package cn.ellen.companion2

import android.content.Intent
import android.os.Bundle
import android.webkit.WebView
import com.getcapacitor.BridgeActivity
// App 插件管两件事：backButton 事件（我们的返回键裁决全靠它）与 minimizeApp()。
// 少了它，web 侧 App.addListener('backButton') 会抛「not implemented on android」，
// 结果是按一次返回键直接回桌面 —— 真机实测踩过，模拟器不炸只是运气。
import com.capacitorjs.plugins.app.AppPlugin
import cn.ellen.companion2.plugin.EllenAutonomyPlugin
import cn.ellen.companion2.plugin.EllenBackgroundPlugin
import cn.ellen.companion2.plugin.EllenModelHttpPlugin
import cn.ellen.companion2.plugin.EllenSecureConfigPlugin
import cn.ellen.companion2.plugin.EllenReleaseInfoPlugin
import cn.ellen.companion2.plugin.EllenScreenShellPlugin
import cn.ellen.companion2.plugin.EllenArchivePlugin
import cn.ellen.companion2.plugin.EllenAudioPlugin
import cn.ellen.companion2.plugin.EllenLocalSpeechPlugin
import cn.ellen.companion2.plugin.EllenSpeechPlugin
import cn.ellen.companion2.plugin.EllenFeedbackPlugin
import cn.ellen.companion2.plugin.EllenUpdatesPlugin
import cn.ellen.companion2.plugin.EllenDocumentsPlugin
import cn.ellen.companion2.plugin.EllenMediaPlugin
import cn.ellen.companion2.plugin.EllenVolumePlugin
import cn.ellen.companion2.proactive.EllenProactiveStore

/**
 * 唯一 Activity。插件必须在 super.onCreate() 之前注册 —— Capacitor 8 会在 super.onCreate
 * 里读注册表去生成 PluginHeaders，晚一步注册的插件在 JS 侧就是 undefined（没有任何报错）。
 */
class MainActivity : BridgeActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        // 让 WebView 的 devtools 一直可用：正式包出问题时，只有这一条路能看库里的真东西
        // （2026-11-13 真机导入资料后聊天页空白，就是靠它才查出是 profile/线程没切）。
        // 影响面：只有连着 adb（USB 调试已开）的机器才能连上，不联网、不对外暴露。
        WebView.setWebContentsDebuggingEnabled(true)
        registerPlugin(AppPlugin::class.java)
        registerPlugin(EchoPlugin::class.java)
        registerPlugin(EllenReleaseInfoPlugin::class.java)
        registerPlugin(EllenSecureConfigPlugin::class.java)
        registerPlugin(EllenModelHttpPlugin::class.java)
        registerPlugin(EllenScreenShellPlugin::class.java)
        registerPlugin(EllenArchivePlugin::class.java)
        registerPlugin(EllenAutonomyPlugin::class.java)
        registerPlugin(EllenBackgroundPlugin::class.java)
        registerPlugin(EllenAudioPlugin::class.java)
        registerPlugin(EllenLocalSpeechPlugin::class.java)
        registerPlugin(EllenSpeechPlugin::class.java)
        registerPlugin(EllenFeedbackPlugin::class.java)
        registerPlugin(EllenUpdatesPlugin::class.java)
        registerPlugin(EllenDocumentsPlugin::class.java)
        registerPlugin(EllenMediaPlugin::class.java)
        registerPlugin(EllenVolumePlugin::class.java)
        super.onCreate(savedInstanceState)
    }

    /** 通知点回来时 Activity 已在栈里，intent 要重新交给 WebView 处理。 */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
    }

    /**
     * 前台/后台标记，给主动消息用。
     *
     * 用户正开着 App（多半就在聊天界面里）时不该收到「在吗」这种主动消息 ——
     * 之前没有这个标记，闹钟到点就发，于是聊天聊到一半会插一条进来。
     * 退到后台的那一刻顺手记个时间，Runner 靠它避开「刚聊完」的头几分钟。
     */
    override fun onResume() {
        super.onResume()
        try {
            EllenProactiveStore.setForeground(this, true)
        } catch (_: Exception) {
            /* 存不进去也不该拖垮启动 */
        }
    }

    override fun onPause() {
        super.onPause()
        try {
            EllenProactiveStore.setForeground(this, false)
            EllenProactiveStore.noteUserLeft(this)
        } catch (_: Exception) {
            /* 同上 */
        }
    }
}
