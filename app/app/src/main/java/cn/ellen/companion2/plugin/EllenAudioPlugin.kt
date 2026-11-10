package cn.ellen.companion2.plugin

import android.Manifest
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.annotation.Permission
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.PermissionCallback
import java.io.File
import java.io.RandomAccessFile
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 录音：AudioRecord 直接出 16 kHz 单声道 s16le，自己补 44 字节 WAV 头。
 *
 * 为什么不用 MediaRecorder：转写要的是裸 PCM，MediaRecorder 只肯给 AAC/AMR，
 * 录完还得解一遍。这里边录边写，先占位 44 字节，结束（或异常）时 seek(0) 回填头，
 * 所以录到一半被杀也不会留下一个打不开的文件。
 */
@CapacitorPlugin(
    name = "EllenAudio",
    permissions = [Permission(alias = "microphone", strings = [Manifest.permission.RECORD_AUDIO])],
)
class EllenAudioPlugin : Plugin() {

    private val fileIdPattern = Regex("[A-Za-z0-9._:-]{1,120}")
    private val stopFlag = AtomicBoolean(false)

    private var thread: Thread? = null
    private var currentFileId = ""
    private var currentFile: File? = null
    private var startedAt = 0L
    private var bytesWritten = 0L
    private var lastError = ""
    private var pendingCall: PluginCall? = null
    private var maxDurationMs = DEFAULT_MS

    private fun dir(): File = File(context.filesDir, "recordings").apply { mkdirs() }

    private fun fileOf(fileId: String): File = File(dir(), "$fileId.wav")

    @PluginMethod
    fun capabilities(call: PluginCall) {
        val out = JSObject()
        out.put("record", true)
        out.put("play", false)
        out.put("callPcm", false)
        out.put("transcribe", true)
        out.put("sampleRate", SAMPLE_RATE)
        out.put("channels", CHANNELS)
        out.put("maxDurationMs", MAX_MS)
        call.resolve(out)
    }

    @PluginMethod
    fun state(call: PluginCall) {
        val out = JSObject()
        out.put("recording", thread != null)
        out.put("fileId", currentFileId)
        out.put("elapsedMs", if (startedAt > 0) System.currentTimeMillis() - startedAt else 0L)
        out.put("bytes", bytesWritten)
        out.put("lastError", lastError)
        call.resolve(out)
    }

    @PluginMethod
    fun startRecording(call: PluginCall) {
        if (thread != null) {
            call.reject("还在录着上一段。", "AUDIO_BUSY")
            return
        }
        val raw = call.getString("fileId").orEmpty()
        val fileId = if (raw.isNotEmpty() && fileIdPattern.matches(raw)) raw else newId()
        maxDurationMs = (call.getLong("maxDurationMs") ?: DEFAULT_MS).coerceIn(MIN_MS, MAX_MS)

        if (getPermissionState("microphone") != com.getcapacitor.PermissionState.GRANTED) {
            pendingCall = call
            requestPermissionForAlias("microphone", call, "microphoneResult")
            return
        }
        begin(call, fileId)
    }

    @PermissionCallback
    private fun microphoneResult(call: PluginCall) {
        val queued = pendingCall
        pendingCall = null
        if (getPermissionState("microphone") != com.getcapacitor.PermissionState.GRANTED) {
            call.reject("没有麦克风权限。", "AUDIO_PERMISSION")
            return
        }
        val raw = call.getString("fileId").orEmpty()
        val fileId = if (raw.isNotEmpty() && fileIdPattern.matches(raw)) raw else newId()
        begin(call, fileId)
        queued?.let { /* 兼容重复回调 */ }
    }

    private fun begin(call: PluginCall, fileId: String) {
        val file = fileOf(fileId)
        val minBuf = AudioRecord.getMinBufferSize(
            SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minBuf <= 0) {
            call.reject("这台机器录不了音。", "AUDIO_UNAVAILABLE")
            return
        }
        val recorder = try {
            AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                minBuf * 2,
            )
        } catch (e: Exception) {
            call.reject("录音初始化失败：${e.javaClass.simpleName}", "AUDIO_FAILED")
            return
        }

        if (recorder.state != AudioRecord.STATE_INITIALIZED) {
            recorder.release()
            call.reject("这台机器录不了音。", "AUDIO_UNAVAILABLE")
            return
        }

        stopFlag.set(false)
        currentFileId = fileId
        currentFile = file
        startedAt = System.currentTimeMillis()
        bytesWritten = 0
        lastError = ""

        thread = Thread {
            var raf: RandomAccessFile? = null
            try {
                raf = RandomAccessFile(file, "rw")
                raf.setLength(0)
                raf.write(ByteArray(WAV_HEADER)) // 先占位，结束时回填
                recorder.startRecording()
                val buffer = ByteArray(minBuf)
                while (!stopFlag.get()) {
                    val read = recorder.read(buffer, 0, buffer.size)
                    if (read <= 0) continue
                    raf.write(buffer, 0, read)
                    bytesWritten += read
                    if (System.currentTimeMillis() - startedAt >= maxDurationMs) break
                }
            } catch (e: Exception) {
                lastError = "${e.javaClass.simpleName}: ${e.message.orEmpty()}".take(160)
            } finally {
                try {
                    recorder.stop()
                } catch (_: Exception) {
                    /* 没起来就停不了 */
                }
                recorder.release()
                try {
                    raf?.let {
                        it.seek(0)
                        it.write(wavHeader(bytesWritten))
                        it.close()
                    }
                } catch (_: Exception) {
                    /* 回填失败就留个纯 PCM，readRecording 仍能读 */
                }
            }
        }.apply { isDaemon = true; start() }

        val out = JSObject()
        out.put("fileId", fileId)
        out.put("sampleRate", SAMPLE_RATE)
        out.put("channels", CHANNELS)
        call.resolve(out)
    }

    @PluginMethod
    fun stopRecording(call: PluginCall) {
        val worker = thread
        if (worker == null) {
            call.reject("现在没有在录音。", "NOT_RECORDING")
            return
        }
        stopFlag.set(true)
        try {
            worker.join(1500)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
        thread = null
        val durationMs = if (startedAt > 0) System.currentTimeMillis() - startedAt else 0L
        startedAt = 0L

        if (bytesWritten <= 0) {
            lastError = "AUDIO_EMPTY"
            call.reject("这一段没录到声音。", "AUDIO_EMPTY")
            return
        }

        val out = JSObject()
        out.put("fileId", currentFileId)
        out.put("bytes", bytesWritten + WAV_HEADER)
        out.put("durationMs", durationMs)
        call.resolve(out)
    }

    @PluginMethod
    fun cancelRecording(call: PluginCall) {
        val worker = thread
        stopFlag.set(true)
        worker?.let {
            try {
                it.join(1200)
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
            }
        }
        thread = null
        startedAt = 0L
        val file = currentFile
        if (file != null && file.exists()) file.delete()
        bytesWritten = 0
        val out = JSObject()
        out.put("cancelled", true)
        call.resolve(out)
    }

    @PluginMethod
    fun releaseRecording(call: PluginCall) {
        val fileId = call.getString("fileId").orEmpty()
        if (!fileIdPattern.matches(fileId)) {
            call.reject("录音编号不对。", "INVALID_RECORDING")
            return
        }
        val file = fileOf(fileId)
        val existed = file.exists()
        if (existed) file.delete()
        val out = JSObject()
        out.put("released", existed)
        call.resolve(out)
    }

    @PluginMethod
    fun readRecording(call: PluginCall) {
        val fileId = call.getString("fileId").orEmpty()
        if (!fileIdPattern.matches(fileId)) {
            call.reject("录音编号不对。", "INVALID_RECORDING")
            return
        }
        val file = fileOf(fileId)
        if (!file.exists()) {
            call.reject("这段录音找不到了。", "RECORDING_MISSING")
            return
        }
        if (file.length() > MAX_READ_BYTES) {
            call.reject("这段录音太长了。", "RECORDING_TOO_LARGE")
            return
        }
        val bytes = file.readBytes()
        val out = JSObject()
        out.put("fileId", fileId)
        out.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
        out.put("bytes", bytes.size)
        out.put("sampleRate", SAMPLE_RATE)
        out.put("channels", CHANNELS)
        call.resolve(out)
    }

    private fun newId(): String {
        val rand = (Math.random() * 0x7fffffff).toLong().toString(36)
        return "rec-${System.currentTimeMillis().toString(36)}-$rand"
    }

    /** 44 字节 RIFF/WAVE 头；pcmBytes 是不含头的字节数。 */
    private fun wavHeader(pcmBytes: Long): ByteArray {
        val total = (pcmBytes + 36).toInt()
        val byteRate = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE
        val header = ByteArray(WAV_HEADER)
        fun putAscii(offset: Int, text: String) {
            text.toByteArray(Charsets.US_ASCII).copyInto(header, offset)
        }
        fun putInt(offset: Int, value: Int) {
            header[offset] = (value and 0xff).toByte()
            header[offset + 1] = ((value shr 8) and 0xff).toByte()
            header[offset + 2] = ((value shr 16) and 0xff).toByte()
            header[offset + 3] = ((value shr 24) and 0xff).toByte()
        }
        fun putShort(offset: Int, value: Int) {
            header[offset] = (value and 0xff).toByte()
            header[offset + 1] = ((value shr 8) and 0xff).toByte()
        }

        putAscii(0, "RIFF")
        putInt(4, total)
        putAscii(8, "WAVE")
        putAscii(12, "fmt ")
        putInt(16, 16)
        putShort(20, 1) // PCM
        putShort(22, CHANNELS)
        putInt(24, SAMPLE_RATE)
        putInt(28, byteRate)
        putShort(32, (CHANNELS * BYTES_PER_SAMPLE).toShort().toInt())
        putShort(34, 16)
        putAscii(36, "data")
        putInt(40, pcmBytes.toInt())
        return header
    }

    override fun handleOnDestroy() {
        stopFlag.set(true)
        try {
            thread?.join(800)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
        thread = null
        super.handleOnDestroy()
    }

    private companion object {
        const val SAMPLE_RATE = 16000
        const val CHANNELS = 1
        const val BYTES_PER_SAMPLE = 2
        const val WAV_HEADER = 44
        const val MIN_MS = 1_000L
        const val MAX_MS = 600_000L
        const val DEFAULT_MS = 120_000L
        const val MAX_READ_BYTES = 32L * 1024 * 1024
    }
}
