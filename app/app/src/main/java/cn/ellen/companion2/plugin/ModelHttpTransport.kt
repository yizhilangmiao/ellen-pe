package cn.ellen.companion2.plugin

import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import javax.net.ssl.HttpsURLConnection

/**
 * 只管「发一个流式 POST，然后按块把字节吐给 JS」。
 *
 * 为什么只认 https：WebView 这边的调用方（core/chat/session.js、core/chat/oneshot.js）走的都是
 * 公网模型服务；早先想用 http://127.0.0.1 打本地桩模拟慢响应，结果 `openConnection()` 返回的是
 * HttpURLConnection，强转 HttpsURLConnection 抛 ClassCastException，被上层吞成一句
 * 「聊天连接操作未完成。」，白查半小时。要接本地模型，得把这里换成 HttpURLConnection，
 * 那是另一轮的事，别偷偷放开明文。
 */
object ModelHttpTransport {

    data class Opened(val status: Int, val contentType: String?)

    data class Chunk(val data: ByteArray, val done: Boolean)

    private class Session(val conn: HttpsURLConnection) {
        val lock = Object()
        val chunks = ArrayList<ByteArray>()
        var done = false
        var error: String? = null
        var cancelled = false
    }

    private val sessions = ConcurrentHashMap<String, Session>()

    private const val CONNECT_TIMEOUT_MS = 15_000
    private const val READ_TIMEOUT_MS = 120_000
    private const val CHUNK = 8 * 1024
    private const val WAIT_MS = 120_000L

    fun open(requestId: String, url: String, apiKey: String, body: String): Opened {
        // 同一 requestId 再来一次就先把旧的收掉，避免连接泄漏
        close(requestId)

        val parsed = try {
            URL(url)
        } catch (e: Exception) {
            throw TransportError("INVALID_MODEL_HTTP_REQUEST", "这个地址不太对：$url")
        }
        if (parsed.protocol != "https") {
            throw TransportError("INSECURE_MODEL_HTTP", "只支持 https 的模型地址。")
        }

        val conn = (parsed.openConnection() as HttpsURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = CONNECT_TIMEOUT_MS
            readTimeout = READ_TIMEOUT_MS
            doOutput = true
            useCaches = false
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
            setRequestProperty("Accept", "text/event-stream, application/json")
            if (apiKey.isNotBlank()) setRequestProperty("Authorization", "Bearer $apiKey")
        }

        try {
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
        } catch (e: Exception) {
            conn.disconnect()
            throw TransportError("MODEL_HTTP_FAILED", describe(e))
        }

        val status = try {
            conn.responseCode
        } catch (e: Exception) {
            conn.disconnect()
            throw TransportError("MODEL_HTTP_FAILED", describe(e))
        }

        val session = Session(conn)
        sessions[requestId] = session

        // 4xx/5xx 的正文也照样读出来：上层要把服务端原话贴给用户看
        val stream: InputStream? = try {
            if (status >= 400) conn.errorStream else conn.inputStream
        } catch (e: Exception) {
            null
        }

        if (stream == null) {
            synchronized(session.lock) {
                session.done = true
            }
        } else {
            Thread({
                val buffer = ByteArray(CHUNK)
                try {
                    stream.use { input ->
                        while (true) {
                            val read = input.read(buffer)
                            if (read < 0) break
                            if (read == 0) continue
                            val piece = buffer.copyOf(read)
                            synchronized(session.lock) {
                                session.chunks.add(piece)
                                session.lock.notifyAll()
                            }
                        }
                    }
                } catch (e: Exception) {
                    synchronized(session.lock) {
                        if (!session.cancelled) session.error = describe(e)
                    }
                } finally {
                    synchronized(session.lock) {
                        session.done = true
                        session.lock.notifyAll()
                    }
                }
            }, "ellen-model-$requestId").apply { isDaemon = true }.start()
        }

        return Opened(status, conn.contentType)
    }

    /** sequence 从 1 开始，返回第 sequence 块；等到有数据、或者流结束为止。 */
    fun read(requestId: String, sequence: Int): Chunk {
        val session = sessions[requestId]
            ?: throw TransportError("INVALID_MODEL_HTTP_REQUEST", "这个请求已经关掉了。")
        if (sequence < 1) throw TransportError("INVALID_MODEL_HTTP_REQUEST", "序号要从 1 开始。")

        synchronized(session.lock) {
            val deadline = System.currentTimeMillis() + WAIT_MS
            while (session.chunks.size < sequence && !session.done && session.error == null) {
                val left = deadline - System.currentTimeMillis()
                if (left <= 0) throw TransportError("MODEL_HTTP_TIMEOUT", "等模型回应等太久了。")
                try {
                    session.lock.wait(left)
                } catch (e: InterruptedException) {
                    Thread.currentThread().interrupt()
                    throw TransportError("MODEL_HTTP_FAILED", "被中断了。")
                }
            }

            session.error?.let { err ->
                sessions.remove(requestId)
                session.conn.disconnect()
                throw TransportError("MODEL_HTTP_FAILED", err)
            }

            if (session.chunks.size >= sequence) {
                val piece = session.chunks[sequence - 1]
                val done = session.done && sequence >= session.chunks.size
                if (done) {
                    sessions.remove(requestId)
                    session.conn.disconnect()
                }
                return Chunk(piece, done)
            }

            // 流已经结束但没这么多块
            sessions.remove(requestId)
            session.conn.disconnect()
            return Chunk(ByteArray(0), true)
        }
    }

    fun cancel(requestId: String) {
        val session = sessions.remove(requestId) ?: return
        synchronized(session.lock) {
            session.cancelled = true
            session.done = true
            session.lock.notifyAll()
        }
        try {
            session.conn.disconnect()
        } catch (_: Exception) {
            /* 断开失败就算了，反正已经没人读 */
        }
    }

    fun close(requestId: String) {
        cancel(requestId)
    }

    fun closeAll() {
        sessions.keys.toList().forEach { cancel(it) }
    }

    private fun describe(e: Exception): String {
        val message = e.message ?: ""
        val name = e.javaClass.simpleName
        return (if (message.isBlank()) name else "$name: $message").take(160)
    }
}

/** 传输层的错误，插件层翻译成 Capacitor 的 reject 码。 */
class TransportError(val code: String, override val message: String) : Exception(message)

/** 兼容旧代码里 HttpURLConnection 的类型引用（避免 import 变成未使用告警）。 */
@Suppress("unused")
private val keepHttpURLConnectionImport: Class<HttpURLConnection> = HttpURLConnection::class.java
