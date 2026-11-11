package cn.ellen.companion2.plugin

import android.net.Uri
import android.util.Base64
import androidx.core.content.FileProvider
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray
import java.io.File
import java.util.UUID

/**
 * 聊天附件的落盘/读取。只做五件事：save / open / remove / stat / list。
 *
 * 落点是 context.filesDir/attachments，uri 由 `${applicationId}.fileprovider` 出
 * （res/xml/file_paths.xml 里 files-path 已经覆盖整个 filesDir）。
 *
 * 三条约束（老大定的）：
 *  1. 单次 base64 上限 32 MiB，超了回 DOCUMENT_TOO_LARGE —— 别让一次附件把内存吃光；
 *  2. 文件名 = 调用方给的 name 当**前缀** + 自己生成的 id，绝不拿 name 拼路径（防 ../）；
 *  3. 读只认本机 fileprovider 出来的 uri 或纯文件名，path 分隔符一律不接。
 */
@CapacitorPlugin(name = "EllenDocuments")
class EllenDocumentsPlugin : Plugin() {

    /** 32 MiB：够放一张原图或一段短录音，再大就该走别通道了。 */
    private val maxBytes = 32L * 1024 * 1024

    /** list() 一次最多回多少条：5000 条 × 4 个字段，过桥体积还在几十 KB 量级。 */
    private val MAX_LIST = 5000

    private fun dir(): File = File(context.filesDir, "attachments").apply { mkdirs() }

    private fun authority(): String = "${context.packageName}.fileprovider"

    private fun newId(): String = UUID.randomUUID().toString().replace("-", "").take(16)

    /** 只留字母数字下划线短横，剩下的换成下划线；给文件名当前缀用。 */
    private fun safePrefix(name: String): String {
        val base = name.substringBeforeLast('.', name)
        val cleaned = base.map { ch ->
            if (ch.isLetterOrDigit() || ch == '-' || ch == '_') ch else '_'
        }.joinToString("").take(40)
        return if (cleaned.isBlank()) "attachment" else cleaned
    }

    /** 扩展名只认 1-8 位字母数字，别的一律丢掉。 */
    private fun safeExt(name: String): String {
        val ext = name.substringAfterLast('.', "").lowercase()
        if (ext.isEmpty() || ext.length > 8 || !ext.all { it.isLetterOrDigit() }) return ""
        return ".$ext"
    }

    private fun fileOf(uriText: String): File {
        val text = uriText.trim()
        if (text.isEmpty()) throw IllegalArgumentException("附件 uri 是空的。")
        val uri = Uri.parse(text)
        val name = when {
            uri.scheme == "content" -> {
                if (uri.authority != authority()) throw IllegalArgumentException("这个 uri 不是本机附件。")
                uri.lastPathSegment.orEmpty()
            }
            uri.scheme == "file" -> File(uri.path.orEmpty()).name
            uri.scheme == null -> File(text).name
            else -> throw IllegalArgumentException("不认识的 uri 协议：${uri.scheme}")
        }
        // 反斜杠用 92.toChar() 拼：源码里直接敲字面量容易被各层转义吃掉（踩过）
        val backslash = 92.toChar()
        if (name.isBlank() || name.contains('/') || name.contains(backslash) || name.contains("..")) {
            throw IllegalArgumentException("附件名不合法。")
        }
        return File(dir(), name)
    }

    /** save({name, base64}) → {uri, bytes, name, mimeType} */
    @PluginMethod
    fun save(call: PluginCall) {
        val name = call.getString("name").orEmpty()
        val raw = call.getString("base64").orEmpty().trim()
        if (raw.isEmpty()) {
            call.reject("附件内容是空的。", "DOCUMENT_EMPTY")
            return
        }
        // 允许 data URL（data:image/png;base64,xxxx）
        val payload = if (raw.startsWith("data:")) raw.substringAfter(',', "") else raw
        if (payload.isEmpty()) {
            call.reject("附件内容是空的。", "DOCUMENT_EMPTY")
            return
        }
        // 先按长度挡一道：base64 每 4 字符 3 字节，别等解码完才发现太大
        if (payload.length.toLong() / 4 * 3 > maxBytes + 4) {
            call.reject("附件太大了（上限 32 MB）。", "DOCUMENT_TOO_LARGE")
            return
        }
        val bytes = try {
            Base64.decode(payload, Base64.DEFAULT)
        } catch (e: Exception) {
            call.reject("附件不是有效的 base64。", "DOCUMENT_INVALID_DATA")
            return
        }
        if (bytes.isEmpty()) {
            call.reject("附件内容是空的。", "DOCUMENT_EMPTY")
            return
        }
        if (bytes.size.toLong() > maxBytes) {
            call.reject("附件太大了（上限 32 MB）。", "DOCUMENT_TOO_LARGE")
            return
        }

        val fileName = "${safePrefix(name)}-${newId()}${safeExt(name)}"
        val file = File(dir(), fileName)
        val tmp = File(dir(), "$fileName.part")
        try {
            // 先写 .part 再改名：中途失败不会在附件目录里留半个文件
            tmp.outputStream().use { it.write(bytes) }
            if (file.exists()) file.delete()
            if (!tmp.renameTo(file)) throw IllegalStateException("改名失败")
            val out = JSObject()
            out.put("uri", FileProvider.getUriForFile(context, authority(), file).toString())
            out.put("name", fileName)
            out.put("bytes", bytes.size.toLong())
            out.put("mimeType", guessMime(fileName))
            call.resolve(out)
        } catch (e: Exception) {
            try {
                tmp.delete()
            } catch (_: Exception) {
                /* 删不掉就留着，下次写同名会覆盖 */
            }
            call.reject("附件写不进去：${e.javaClass.simpleName}", "DOCUMENT_WRITE_FAILED")
        }
    }

    /** open({uri}) → {base64, bytes, name, mimeType} */
    @PluginMethod
    fun open(call: PluginCall) {
        val file = try {
            fileOf(call.getString("uri").orEmpty())
        } catch (e: Exception) {
            call.reject(e.message ?: "附件 uri 不合法。", "DOCUMENT_INVALID_URI")
            return
        }
        if (!file.isFile) {
            call.reject("找不到这个附件。", "DOCUMENT_NOT_FOUND")
            return
        }
        if (file.length() > maxBytes) {
            call.reject("附件太大了（上限 32 MB）。", "DOCUMENT_TOO_LARGE")
            return
        }
        try {
            val bytes = file.readBytes()
            val out = JSObject()
            out.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
            out.put("bytes", bytes.size.toLong())
            out.put("name", file.name)
            out.put("mimeType", guessMime(file.name))
            call.resolve(out)
        } catch (e: Exception) {
            call.reject("读附件失败：${e.javaClass.simpleName}", "DOCUMENT_READ_FAILED")
        }
    }

    /** remove({uri}) → {removed} */
    @PluginMethod
    fun remove(call: PluginCall) {
        val file = try {
            fileOf(call.getString("uri").orEmpty())
        } catch (e: Exception) {
            call.reject(e.message ?: "附件 uri 不合法。", "DOCUMENT_INVALID_URI")
            return
        }
        val removed = try {
            file.exists() && file.delete()
        } catch (e: Exception) {
            false
        }
        val out = JSObject()
        out.put("removed", removed)
        call.resolve(out)
    }

    /** stat({uri}) → {exists, bytes, mtime, name} */
    @PluginMethod
    fun stat(call: PluginCall) {
        val file = try {
            fileOf(call.getString("uri").orEmpty())
        } catch (e: Exception) {
            call.reject(e.message ?: "附件 uri 不合法。", "DOCUMENT_INVALID_URI")
            return
        }
        val exists = file.isFile
        val out = JSObject()
        out.put("exists", exists)
        out.put("bytes", if (exists) file.length() else 0L)
        out.put("mtime", if (exists) file.lastModified() else 0L)
        out.put("name", file.name)
        call.resolve(out)
    }

    /**
     * list({prefix?}) → {files:[{name, bytes, mtime, uri}], count, totalBytes, skipped, truncated}
     *
     * 只列 filesDir/attachments 这一层，不递归；按 mtime 从新到旧；最多 5000 条。
     * prefix 可选（例如 "voice-"），只回文件名以它开头的。
     * 半成品（*.part）和子目录不计入，只加进 skipped。
     * 排序与删谁由 web 侧决定，这里只给数据。
     */
    @PluginMethod
    fun list(call: PluginCall) {
        val prefix = call.getString("prefix").orEmpty()
        val all = dir().listFiles() ?: emptyArray()
        var skipped = 0
        val picked = ArrayList<File>(all.size)
        for (f in all) {
            if (!f.isFile || f.name.endsWith(".part")) {
                skipped++
                continue
            }
            if (prefix.isNotEmpty() && !f.name.startsWith(prefix)) continue
            picked.add(f)
        }
        picked.sortByDescending { it.lastModified() }
        val truncated = picked.size > MAX_LIST
        val capped = if (truncated) picked.subList(0, MAX_LIST) else picked
        val arr = JSONArray()
        var total = 0L
        for (f in capped) {
            val o = JSObject()
            o.put("name", f.name)
            o.put("bytes", f.length())
            o.put("mtime", f.lastModified())
            o.put("uri", try {
                FileProvider.getUriForFile(context, authority(), f).toString()
            } catch (e: Exception) {
                ""
            })
            arr.put(o)
            total += f.length()
        }
        val out = JSObject()
        out.put("files", arr)
        out.put("count", capped.size)
        out.put("totalBytes", total)
        out.put("skipped", skipped)
        out.put("truncated", truncated)
        call.resolve(out)
    }

    private fun guessMime(name: String): String = when (safeExt(name)) {
        ".png" -> "image/png"
        ".jpg", ".jpeg" -> "image/jpeg"
        ".webp" -> "image/webp"
        ".gif" -> "image/gif"
        ".heic" -> "image/heic"
        ".m4a" -> "audio/mp4"
        ".mp3" -> "audio/mpeg"
        ".wav" -> "audio/wav"
        ".ogg", ".opus" -> "audio/ogg"
        ".mp4" -> "video/mp4"
        ".webm" -> "video/webm"
        ".pdf" -> "application/pdf"
        ".txt" -> "text/plain"
        ".json" -> "application/json"
        else -> "application/octet-stream"
    }
}
