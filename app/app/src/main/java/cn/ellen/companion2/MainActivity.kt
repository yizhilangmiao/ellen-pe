package cn.ellen.companion2

import android.content.Intent
import android.os.Bundle
import com.getcapacitor.BridgeActivity
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

/**
 * 唯一 Activity。插件必须在 super.onCreate() 之前注册 —— Capacitor 8 会在 super.onCreate
 * 里读注册表去生成 PluginHeaders，晚一步注册的插件在 JS 侧就是 undefined（没有任何报错）。
 */
class MainActivity : BridgeActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
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
        super.onCreate(savedInstanceState)
    }

    /** 通知点回来时 Activity 已在栈里，intent 要重新交给 WebView 处理。 */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
    }
}
