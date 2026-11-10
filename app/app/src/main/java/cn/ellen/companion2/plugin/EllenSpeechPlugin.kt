package cn.ellen.companion2.plugin

import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Base64
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.util.Locale
import java.util.concurrent.Executors

/**
 * 朗读：两条路。
 *   system  —— Android 自带 TTS（离线、零配置；机器没有中文引擎时会 available=false）
 *   minimax —— 云端合成 mp3，把字节交回 web 用 <audio> 播（见 core/speech.js 的取舍说明）
 */
@CapacitorPlugin(name = "EllenSpeech")
class EllenSpeechPlugin : Plugin() {

    private var engine: TextToSpeech? = null
    private var ready = false
    private var speaking = false
    private var currentUtterance = ""
    private var lastError = ""
    private var pending: PluginCall? = null
    private var counter = 0

    private val synthWorker = Executors.newSingleThreadExecutor()

    override fun load() {
        engine = TextToSpeech(context) { status ->
            if (status == TextToSpeech.SUCCESS) {
                val tts = engine
                val lang = tts?.setLanguage(Locale.SIMPLIFIED_CHINESE)
                if (lang == TextToSpeech.LANG_MISSING_DATA || lang == TextToSpeech.LANG_NOT_SUPPORTED) {
                    lastError = "TTS_LANG_UNAVAILABLE"
                } else {
                    ready = true
                    tts?.setOnUtteranceProgressListener(listener)
                    val queued = pending
                    pending = null
                    if (queued != null) {
                        try {
                            speakNow(queued, queued.getString("text").orEmpty())
                        } catch (e: Exception) {
                            queued.reject("朗读没起来。", "TTS_FAILED")
                        }
                    }
                }
            } else {
                lastError = "TTS_INIT_FAILED"
            }
        }
    }

    private val listener = object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) {
            if (utteranceId != currentUtterance) return
            speaking = true
            emit("start", utteranceId)
        }

        override fun onDone(utteranceId: String?) {
            if (utteranceId != currentUtterance) return
            speaking = false
            emit("done", utteranceId)
        }

        @Deprecated("旧签名，低版本仍会回调这个")
        override fun onError(utteranceId: String?) {
            if (utteranceId != currentUtterance) return
            speaking = false
            emit("error", utteranceId, "TTS_FAILED")
        }

        override fun onError(utteranceId: String?, errorCode: Int) {
            if (utteranceId != currentUtterance) return
            speaking = false
            emit("error", utteranceId, "TTS_ERROR_$errorCode")
        }
    }

    private fun emit(type: String, utteranceId: String, code: String = "") {
        val payload = JSObject()
        payload.put("type", type)
        payload.put("utteranceId", utteranceId)
        if (code.isNotEmpty()) payload.put("code", code)
        notifyListeners("speechEvent", payload)
    }

    @PluginMethod
    fun state(call: PluginCall) {
        val out = JSObject()
        out.put("available", ready)
        out.put("speaking", speaking)
        out.put("engine", engine?.engines?.firstOrNull() ?: "")
        out.put("language", if (ready) "zh-CN" else "")
        out.put("lastError", lastError)

        val voices = JSArray()
        try {
            engine?.voices.orEmpty()
                .filter { it.locale?.language == "zh" }
                .forEach { v ->
                    voices.put(JSObject().apply {
                        put("name", v.name)
                        put("locale", v.locale?.toLanguageTag() ?: "")
                        put("quality", v.quality)
                        put("latency", v.latency)
                        put("network", v.isNetworkConnectionRequired)
                    })
                }
        } catch (_: Exception) {
            /* 个别引擎 voices 会抛 */
        }
        out.put("voices", voices)
        call.resolve(out)
    }

    @PluginMethod
    fun speak(call: PluginCall) {
        val text = call.getString("text").orEmpty().trim()
        if (text.isEmpty()) {
            call.reject("没有要念的内容。", "INVALID_SPEECH_TEXT")
            return
        }
        if (text.length > MAX_CHARS) {
            call.reject("一次最多念 $MAX_CHARS 个字。", "SPEECH_TOO_LONG")
            return
        }
        if (!ready) {
            pending = call
            val out = JSObject()
            out.put("queued", true)
            call.resolve(out)
            return
        }
        speakNow(call, text)
    }

    private fun speakNow(call: PluginCall, text: String) {
        val tts = engine ?: throw IllegalStateException("no engine")
        val rate = (call.getFloat("rate") ?: 1.0f).coerceIn(0.5f, 2.0f)
        val pitch = (call.getFloat("pitch") ?: 1.0f).coerceIn(0.5f, 2.0f)
        counter += 1
        currentUtterance = "utt-$counter-${System.currentTimeMillis()}"
        tts.setSpeechRate(rate)
        tts.setPitch(pitch)

        val result = tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, currentUtterance)
        if (result != TextToSpeech.SUCCESS) {
            lastError = "TTS_SPEAK_FAILED"
            call.reject("念不出来：引擎拒绝了这段文字。", "TTS_SPEAK_FAILED")
            return
        }
        speaking = true
        val out = JSObject()
        out.put("utteranceId", currentUtterance)
        out.put("speaking", true)
        call.resolve(out)
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        engine?.stop()
        speaking = false
        val out = JSObject()
        out.put("speaking", false)
        call.resolve(out)
    }

    /**
     * minimax 语音合成。返回 mp3 的 base64 交给 web 播。
     *
     * `output_format: "hex"` 必须给：不给的时候服务端可能回 url 或 base64，
     * 解析路径对不上（旧包 main bundle 里也是这么写的）。
     */
    @PluginMethod
    fun synthesize(call: PluginCall) {
        val text = call.getString("text").orEmpty().trim()
        if (text.isEmpty()) {
            call.reject("没有要念的内容。", "INVALID_SPEECH_TEXT")
            return
        }
        if (text.length > SYNTH_MAX_CHARS) {
            call.reject("一次最多念 $SYNTH_MAX_CHARS 个字。", "SPEECH_TOO_LONG")
            return
        }
        val apiKey = call.getString("apiKey").orEmpty().trim()
        if (apiKey.isEmpty()) {
            call.reject("还没填朗读服务的 key。", "NO_API_KEY")
            return
        }

        val endpoint = call.getString("endpoint")?.takeIf { it.isNotBlank() } ?: DEFAULT_ENDPOINT
        val model = call.getString("model")?.takeIf { it.isNotBlank() } ?: DEFAULT_MODEL
        val voiceId = call.getString("voiceId")?.takeIf { it.isNotBlank() } ?: DEFAULT_VOICE
        val speed = (call.getFloat("speed") ?: 1.0f).coerceIn(0.5f, 2.0f)

        synthWorker.execute {
            try {
                val body = JSONObject().apply {
                    put("model", model)
                    put("text", text)
                    put("stream", false)
                    put("output_format", "hex")
                    put("language_boost", "Chinese")
                    put("voice_setting", JSONObject().apply {
                        put("voice_id", voiceId)
                        put("speed", speed.toDouble())
                        put("vol", 1.0)
                        put("pitch", 0)
                    })
                    put("audio_setting", JSONObject().apply {
                        put("sample_rate", 32000)
                        put("bitrate", 128000)
                        put("format", "mp3")
                        put("channel", 1)
                    })
                }

                val conn = (java.net.URL(endpoint).openConnection() as java.net.HttpURLConnection).apply {
                    requestMethod = "POST"
                    connectTimeout = 20_000
                    readTimeout = 60_000
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json")
                    setRequestProperty("Authorization", "Bearer $apiKey")
                }
                conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
                val status = conn.responseCode
                val stream = if (status >= 400) conn.errorStream else conn.inputStream
                val raw = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
                conn.disconnect()

                if (status >= 400) {
                    call.reject("朗读失败：${raw.take(160)}", "TTS_HTTP_$status")
                    return@execute
                }

                val json = JSONObject(raw)
                val base = json.optJSONObject("base_resp")
                val code = base?.optInt("status_code", 0) ?: 0
                if (code != 0) {
                    val msg = base?.optString("status_msg").orEmpty()
                    call.reject("朗读失败：$msg", "TTS_FAILED")
                    return@execute
                }

                val hex = json.optJSONObject("data")?.optString("audio").orEmpty()
                if (hex.isEmpty()) {
                    call.reject("朗读服务没返回音频。", "TTS_EMPTY")
                    return@execute
                }
                val bytes = hexToBytes(hex)
                if (bytes.isEmpty()) {
                    call.reject("朗读服务返回的音频读不出来。", "TTS_EMPTY")
                    return@execute
                }

                val out = JSObject()
                out.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
                out.put("format", "mp3")
                out.put("bytes", bytes.size)
                out.put("model", model)
                out.put("voiceId", voiceId)
                call.resolve(out)
            } catch (e: Exception) {
                val detail = "${e.javaClass.simpleName}: ${e.message.orEmpty()}".take(160)
                call.reject("连不上朗读服务：$detail", "TTS_NETWORK")
            }
        }
    }

    private fun hexToBytes(hex: String): ByteArray {
        val clean = hex.trim()
        if (clean.length % 2 != 0) return ByteArray(0)
        val out = ByteArray(clean.length / 2)
        var i = 0
        while (i < clean.length) {
            val hi = Character.digit(clean[i], 16)
            val lo = Character.digit(clean[i + 1], 16)
            if (hi < 0 || lo < 0) return ByteArray(0)
            out[i / 2] = ((hi shl 4) or lo).toByte()
            i += 2
        }
        return out
    }

    override fun handleOnDestroy() {
        try {
            engine?.stop()
            engine?.shutdown()
        } catch (_: Exception) {
            /* 关不掉也无所谓 */
        }
        engine = null
        ready = false
        speaking = false
        pending = null
        synthWorker.shutdownNow()
        super.handleOnDestroy()
    }

    private companion object {
        const val MAX_CHARS = 4000
        const val SYNTH_MAX_CHARS = 1200
        const val DEFAULT_ENDPOINT = "https://api.minimax.cn/v1/t2a_v2"
        const val DEFAULT_MODEL = "speech-2.8-hd"
        const val DEFAULT_VOICE = "female-shaonv"
    }
}
