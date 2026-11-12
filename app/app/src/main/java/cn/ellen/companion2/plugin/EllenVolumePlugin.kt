package cn.ellen.companion2.plugin

import android.content.Context
import android.media.AudioManager
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * 媒体音量：get / set 两件事，走 STREAM_MUSIC。
 *
 * 为什么不用 VolumeControlStream / 系统音量面板：音量台要显示「现在多少」，
 * 面板只有用户手动拖的时候才知道值；这里直接读 AudioManager 才是真值。
 *
 * 对外一律用 0~100 的百分比：系统音量档位各家不同（15 档、25 档、100 档都有），
 * 把档位直接给 web，滑杆长度每次都要按机型和系统版本重算。
 *
 * set 只改流音量、不带 FLAG_SHOW_UI：界面自己画了音量台，再弹系统面板会叠两层。
 */
@CapacitorPlugin(name = "EllenVolume")
class EllenVolumePlugin : Plugin() {

    private fun audioManager(): AudioManager? = try {
        context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
    } catch (e: Exception) {
        null
    }

    /** AudioManager 在某些精简 ROM 上会返回 0 档，那等于「读得到但没意义」，按不可用处理。 */
    private fun maxVolume(manager: AudioManager): Int = try {
        manager.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
    } catch (e: Exception) {
        0
    }

    /** get({}) → {volume: 0-100, max: 档位上限} */
    @PluginMethod
    fun get(call: PluginCall) {
        val manager = audioManager()
        if (manager == null) {
            call.reject("这台机器读不到音量。", "VOLUME_UNAVAILABLE")
            return
        }
        val max = maxVolume(manager)
        if (max <= 0) {
            call.reject("这台机器读不到音量。", "VOLUME_UNAVAILABLE")
            return
        }
        val level = try {
            manager.getStreamVolume(AudioManager.STREAM_MUSIC)
        } catch (e: Exception) {
            call.reject("读音量失败：${e.javaClass.simpleName}", "VOLUME_UNAVAILABLE")
            return
        }
        val out = JSObject()
        out.put("volume", percentOf(level, max))
        out.put("max", max)
        call.resolve(out)
    }

    /**
     * set({volume: 0-100}) → {volume: 实际生效的百分比}
     *
     * 回的是**换算回档位后再算出来的百分比**，不是传入值：系统会把 37% 落到最近的一档，
     * web 拿这个值回填滑杆，才不会出现「松开手又跳一下」。
     */
    @PluginMethod
    fun set(call: PluginCall) {
        val manager = audioManager()
        if (manager == null) {
            call.reject("这台机器改不了音量。", "VOLUME_UNAVAILABLE")
            return
        }
        val max = maxVolume(manager)
        if (max <= 0) {
            call.reject("这台机器改不了音量。", "VOLUME_UNAVAILABLE")
            return
        }
        // JS 数字过桥是 Double；缺参按 0 处理（滑到最左）而不是报错
        val wanted = (call.getDouble("volume") ?: call.getInt("volume")?.toDouble() ?: 0.0)
            .coerceIn(0.0, 100.0)
        val target = Math.round(wanted * max / 100.0).toInt().coerceIn(0, max)
        try {
            manager.setStreamVolume(AudioManager.STREAM_MUSIC, target, 0)
        } catch (e: SecurityException) {
            call.reject("系统不让改音量。", "VOLUME_PERMISSION")
            return
        } catch (e: Exception) {
            call.reject("改音量失败：${e.javaClass.simpleName}", "VOLUME_SET_FAILED")
            return
        }
        val out = JSObject()
        out.put("volume", percentOf(target, max))
        call.resolve(out)
    }

    private fun percentOf(level: Int, max: Int): Int {
        if (max <= 0) return 0
        return Math.round(level * 100.0 / max).toInt().coerceIn(0, 100)
    }
}
