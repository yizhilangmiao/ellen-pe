package cn.ellen.companion2.plugin

import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OnlineModelConfig
import com.k2fsa.sherpa.onnx.OnlineRecognizer
import com.k2fsa.sherpa.onnx.OnlineRecognizerConfig
import com.k2fsa.sherpa.onnx.OnlineTransducerModelConfig

/**
 * 离线识别：sherpa-onnx + streaming zipformer 中文 14M（int8）。
 *
 * 为什么自己带模型：这台机器（以及绝大多数国产 ROM）都没有系统 RecognitionService，
 * `cmd package query-services -a android.speech.RecognitionService` 返回 No services found，
 * 键盘上的语音键是输入法私有链路，没有对外 API。所以只能把模型装进 App 里自己跑。
 *
 * 模型必须 `noCompress`（build.gradle.kts 里 androidResources），否则 aapt 压过之后
 * AAssetManager 拿不到文件描述符，加载会失败。
 */
@CapacitorPlugin(name = "EllenLocalSpeech")
class EllenLocalSpeechPlugin : Plugin() {

    private var recognizer: OnlineRecognizer? = null
    private var loading = false
    private var lastError = ""
    private var modelId = MODEL_ID

    private fun ensure(): OnlineRecognizer? {
        recognizer?.let { return it }
        if (loading) return null
        loading = true
        return try {
            val transducer = OnlineTransducerModelConfig(
                encoder = "$ASSET_DIR/encoder-epoch-99-avg-1.int8.onnx",
                decoder = "$ASSET_DIR/decoder-epoch-99-avg-1.int8.onnx",
                joiner = "$ASSET_DIR/joiner-epoch-99-avg-1.int8.onnx",
            )
            val model = OnlineModelConfig(
                transducer = transducer,
                tokens = "$ASSET_DIR/tokens.txt",
                numThreads = 2,
                modelType = "zipformer",
            )
            val config = OnlineRecognizerConfig(
                featConfig = FeatureConfig(sampleRate = SAMPLE_RATE, featureDim = 80),
                modelConfig = model,
                decodingMethod = "greedy_search",
            )
            val created = OnlineRecognizer(context.assets, config)
            recognizer = created
            lastError = ""
            created
        } catch (e: Throwable) {
            lastError = "ASR_INIT_FAILED · ${e.javaClass.simpleName}: ${e.message.orEmpty()}".take(180)
            null
        } finally {
            loading = false
        }
    }

    @PluginMethod
    fun state(call: PluginCall) {
        val out = JSObject()
        out.put("available", recognizer != null || lastError.isEmpty())
        out.put("loading", loading)
        out.put("model", modelId)
        out.put("sampleRate", SAMPLE_RATE)
        out.put("lastError", lastError)
        call.resolve(out)
    }

    @PluginMethod
    fun ready(call: PluginCall) {
        val started = System.currentTimeMillis()
        val engine = ensure()
        val out = JSObject()
        out.put("ready", engine != null)
        out.put("model", modelId)
        out.put("ms", System.currentTimeMillis() - started)
        out.put("lastError", lastError)
        call.resolve(out)
    }

    @PluginMethod
    fun transcribe(call: PluginCall) {
        val b64 = call.getString("base64").orEmpty()
        if (b64.isEmpty()) {
            call.reject("没有音频。", "ASR_EMPTY_AUDIO")
            return
        }
        val engine = ensure()
        if (engine == null) {
            call.reject(lastError.ifBlank { "离线模型没装好。" }, "ASR_UNAVAILABLE")
            return
        }

        val started = System.currentTimeMillis()
        try {
            val bytes = Base64.decode(b64, Base64.DEFAULT)
            val samples = decodeWav(bytes)
            if (samples.isEmpty()) {
                call.reject("这段音频读不出来。", "ASR_EMPTY_AUDIO")
                return
            }
            if (samples.size > MAX_SAMPLES) {
                call.reject("这段太长了，说短一点。", "ASR_TOO_LONG")
                return
            }

            val engineStarted = System.currentTimeMillis()
            val stream = engine.createStream("")
            try {
                stream.acceptWaveform(samples, SAMPLE_RATE)
                // 尾巴补 0.3 s 静音：不加的话最后一个字经常吃不到（chunk 边界）
                stream.acceptWaveform(FloatArray((SAMPLE_RATE * 0.3f).toInt()), SAMPLE_RATE)
                stream.inputFinished()
                while (engine.isReady(stream)) engine.decode(stream)
                val text = engine.getResult(stream).text.trim()

                val out = JSObject()
                out.put("text", text)
                out.put("ms", System.currentTimeMillis() - engineStarted)
                out.put("samples", samples.size)
                out.put("model", modelId)
                out.put("totalMs", System.currentTimeMillis() - started)
                call.resolve(out)
            } finally {
                stream.release()
            }
        } catch (e: Throwable) {
            call.reject("识别失败：${e.javaClass.simpleName}: ${e.message.orEmpty()}".take(180), "ASR_FAILED")
        }
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        val out = JSObject()
        out.put("cancelled", true)
        call.resolve(out)
    }

    @PluginMethod
    fun close(call: PluginCall) {
        try {
            recognizer?.release()
        } catch (_: Throwable) {
            /* 已经释放 */
        }
        recognizer = null
        val out = JSObject()
        out.put("closed", true)
        call.resolve(out)
    }

    /** 44 字节 WAV 头 + 16 bit 小端 PCM → FloatArray（[-1,1]）。 */
    private fun decodeWav(bytes: ByteArray): FloatArray {
        var offset = 0
        if (bytes.size > 44 && String(bytes, 0, 4, Charsets.US_ASCII) == "RIFF") {
            offset = 44
            // 找 data 块，别硬按 44 跳（有的编码器会在头里塞额外块）
            var i = 12
            while (i + 8 <= bytes.size) {
                val id = String(bytes, i, 4, Charsets.US_ASCII)
                val size = (bytes[i + 4].toInt() and 0xff) or
                    ((bytes[i + 5].toInt() and 0xff) shl 8) or
                    ((bytes[i + 6].toInt() and 0xff) shl 16) or
                    ((bytes[i + 7].toInt() and 0xff) shl 24)
                if (id == "data") {
                    offset = i + 8
                    break
                }
                i += 8 + size
            }
        }
        val count = (bytes.size - offset) / 2
        if (count <= 0) return FloatArray(0)
        val out = FloatArray(count)
        for (i in 0 until count) {
            val lo = bytes[offset + i * 2].toInt() and 0xff
            val hi = bytes[offset + i * 2 + 1].toInt()
            val value = ((hi shl 8) or lo).toShort().toInt()
            out[i] = value / 32768.0f
        }
        return out
    }

    override fun handleOnDestroy() {
        try {
            recognizer?.release()
        } catch (_: Throwable) {
            /* 已经释放 */
        }
        recognizer = null
        super.handleOnDestroy()
    }

    private companion object {
        const val MODEL_ID = "streaming-zipformer-zh-14m-int8"
        const val ASSET_DIR = "asr/streaming-zipformer-zh-14m"
        const val SAMPLE_RATE = 16000
        const val MAX_SAMPLES = SAMPLE_RATE * 300
    }
}
