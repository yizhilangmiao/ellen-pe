package cn.ellen.companion2.plugin

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import cn.ellen.companion2.proactive.EllenBackupWorker
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.OutputStream
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 资料包（.ellenpack）的导入导出 + 自动备份。
 *
 * 容器格式（与 web 侧 core/store/import.js 严格对齐，字节级）：
 *   "ELLENPK1\n"（9 字节魔数） + int32 大端 manifest 长度 + manifest UTF-8 + 各文件原始字节
 *
 * 备份复用同一个容器：一次备份就是一个整包，落在用户选定的文件夹里，
 * 按份数轮换（保留最近 N 份）。
 */
@CapacitorPlugin(name = "EllenArchive")
class EllenArchivePlugin : Plugin() {

    private val magic = "ELLENPK1\n".toByteArray(Charsets.US_ASCII)
    private val backupNamePattern = Regex("艾莲备份-[0-9]{8}-[0-9]{6}\\.ellenpack")
    /** 附件 sha256 的合法形状（与 import.js 的 HEX64 一致）。 */
    private val hex64 = Regex("[a-f0-9]{64}")

    private var exportCall: PluginCall? = null
    private var importCall: PluginCall? = null

    private fun cacheFile(name: String): File =
        File(context.cacheDir, name).apply { parentFile?.mkdirs() }

    private fun pendingFile(): File = cacheFile("export.ellenpack")

    /** 把 manifest 写成一个本地容器文件，返回 handle（就是文件名）。 */
    @PluginMethod
    fun createExport(call: PluginCall) {
        val manifestText = call.getString("manifestText").orEmpty()
        if (manifestText.isBlank()) {
            call.reject("资料包清单是空的。", "ARCHIVE_EMPTY")
            return
        }
        try {
            val file = pendingFile()
            file.outputStream().use { out ->
                out.write(magic)
                writeInt(out, manifestText.toByteArray(Charsets.UTF_8).size)
                out.write(manifestText.toByteArray(Charsets.UTF_8))
            }
            val out = JSObject()
            out.put("handle", file.name)
            out.put("bytes", file.length())
            call.resolve(out)
        } catch (e: Exception) {
            call.reject("打包失败：${e.javaClass.simpleName}", "ARCHIVE_WRITE_FAILED")
        }
    }

    /** 让用户选个地方存；选完把缓存文件拷过去。 */
    @PluginMethod
    fun saveExport(call: PluginCall) {
        val file = pendingFile()
        if (!file.exists()) {
            call.reject("还没打包。", "ARCHIVE_MISSING")
            return
        }
        exportCall = call
        val name = "艾莲资料包-${stamp()}.ellenpack"
        try {
            val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "application/octet-stream"
                putExtra(Intent.EXTRA_TITLE, name)
            }
            startActivityForResult(call, intent, "savedExport")
        } catch (e: Exception) {
            exportCall = null
            call.reject("这台机器没有文件选择器。", "ARCHIVE_UNAVAILABLE")
        }
    }

    @ActivityCallback
    private fun savedExport(call: PluginCall?, result: androidx.activity.result.ActivityResult) {
        val target = exportCall
        exportCall = null
        if (target == null) return
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            val out = JSObject()
            out.put("cancelled", true)
            target.resolve(out)
            return
        }
        try {
            val file = pendingFile()
            val bytes = file.readBytes()
            context.contentResolver.openOutputStream(uri, "wt")?.use { it.write(bytes) }
                ?: throw IllegalStateException("openOutputStream 返回 null")
            val out = JSObject()
            out.put("sizeBytes", bytes.size.toLong())
            out.put("cancelled", false)
            target.resolve(out)
        } catch (e: Exception) {
            target.reject("保存失败：${e.javaClass.simpleName}", "ARCHIVE_WRITE_FAILED")
        }
    }

    /** 让用户挑一个 .ellenpack，只读清单（媒体字节不读）。 */
    @PluginMethod
    fun pickImport(call: PluginCall) {
        importCall = call
        try {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "*/*"
                putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/octet-stream", "application/zip"))
            }
            startActivityForResult(call, intent, "pickedImport")
        } catch (e: Exception) {
            importCall = null
            call.reject("这台机器没有文件选择器。", "ARCHIVE_UNAVAILABLE")
        }
    }

    @ActivityCallback
    private fun pickedImport(call: PluginCall?, result: androidx.activity.result.ActivityResult) {
        val target = importCall
        importCall = null
        if (target == null) return
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            val out = JSObject()
            out.put("cancelled", true)
            target.resolve(out)
            return
        }
        try {
            val manifestText = context.contentResolver.openInputStream(uri)?.use { input ->
                val head = ByteArray(magic.size)
                if (input.read(head) != magic.size || !head.contentEquals(magic)) {
                    throw IllegalStateException("这不是艾莲的资料包。")
                }
                val size = readInt(input)
                if (size <= 0 || size > MAX_MANIFEST) throw IllegalStateException("清单长度不对。")
                val buf = ByteArray(size)
                var read = 0
                while (read < size) {
                    val n = input.read(buf, read, size - read)
                    if (n <= 0) break
                    read += n
                }
                String(buf, 0, read, Charsets.UTF_8)
            } ?: throw IllegalStateException("打不开这个文件。")

            val out = JSObject()
            out.put("manifestText", manifestText)
            out.put("cancelled", false)
            target.resolve(out)
        } catch (e: Exception) {
            target.reject("读资料包失败：${e.message ?: e.javaClass.simpleName}", "ARCHIVE_READ_FAILED")
        }
    }

    // —— 自动备份 ——

    private class Writer(val uri: Uri, val name: String, val files: JSONArray) {
        var out: OutputStream? = null
        var sha = MessageDigest.getInstance("SHA-256")
        var bytes = 0L
        /** 附件区已写字节（不含 magic/长度/manifest）。 */
        var offset = 0L
        /** 正在写的附件下标；等于 files.length() 表示附件全部落完。 */
        var fileIndex = 0
        var fileSha = MessageDigest.getInstance("SHA-256")
        var fileWritten = 0L
    }

    private var backupWriter: Writer? = null
    private var directoryCall: PluginCall? = null
    /** 后台提醒排期是否已按当前状态对过一次（App 起过一次就够，不必每次 state 都入队）。 */
    private var backupArmed = false

    private fun prefs() = context.getSharedPreferences("ellen-backup-v1", android.content.Context.MODE_PRIVATE)

    private fun readState(): JSONObject {
        val raw = prefs().getString("state", "") ?: ""
        return try {
            if (raw.isBlank()) JSONObject() else JSONObject(raw)
        } catch (e: Exception) {
            JSONObject()
        }
    }

    private fun writeState(json: JSONObject) {
        prefs().edit().putString("state", json.toString()).apply()
    }

    private fun withDefaults(json: JSONObject): JSONObject {
        if (!json.has("enabled")) json.put("enabled", false)
        if (!json.has("directory")) json.put("directory", "")
        if (!json.has("directoryName")) json.put("directoryName", "")
        if (!json.has("intervalDays")) json.put("intervalDays", 7)
        if (!json.has("retainGroups")) json.put("retainGroups", BACKUP_RETAIN)
        if (!json.has("nextAt")) json.put("nextAt", 0L)
        if (!json.has("lastSuccessAt")) json.put("lastSuccessAt", 0L)
        if (!json.has("lastName")) json.put("lastName", "")
        if (!json.has("lastBytes")) json.put("lastBytes", 0L)
        if (!json.has("lastError")) json.put("lastError", "")
        if (!json.has("writing")) json.put("writing", false)
        return json
    }

    private fun statePayload(): JSObject {
        val json = withDefaults(readState())
        val out = JSObject()
        out.put("supported", true)
        out.put("enabled", json.optBoolean("enabled"))
        out.put("directory", json.optString("directory"))
        out.put("directoryName", json.optString("directoryName"))
        out.put("intervalDays", json.optInt("intervalDays", 7))
        out.put("retainGroups", json.optInt("retainGroups", BACKUP_RETAIN))
        out.put("nextAt", json.optLong("nextAt", 0L))
        out.put("lastSuccessAt", json.optLong("lastSuccessAt", 0L))
        out.put("lastName", json.optString("lastName"))
        out.put("lastBytes", json.optLong("lastBytes", 0L))
        out.put("lastError", json.optString("lastError"))
        val writer = backupWriter
        out.put("writing", writer != null)
        // 进度给界面用：写到第几个附件、附件区已写多少字节
        if (writer != null) {
            out.put("writingName", writer.name)
            out.put("writingFiles", writer.files.length())
            out.put("writingDone", writer.fileIndex)
            out.put("writingBytes", writer.offset)
        }
        out.put("groups", groupsJson(json))
        return out
    }

    private fun groupsJson(state: JSONObject): JSONArray {
        val arr = JSONArray()
        listGroups(state).forEach { g ->
            arr.put(JSObject().apply {
                put("name", g.optString("name"))
                put("bytes", g.optLong("bytes", 0L))
                put("at", g.optLong("at", 0L))
            })
        }
        return arr
    }

    /** 备份文件夹里的容器列表（按时间倒序）。API 24 没有 getChildDocuments，只能 query。 */
    private fun listGroups(state: JSONObject): List<JSONObject> {
        val dir = state.optString("directory")
        if (dir.isBlank()) return emptyList()
        val treeUri = Uri.parse(dir)
        val treeDocId = try {
            DocumentsContract.getTreeDocumentId(treeUri)
        } catch (e: Exception) {
            return emptyList()
        }
        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, treeDocId)
        val out = mutableListOf<JSONObject>()
        try {
            context.contentResolver.query(
                childrenUri,
                arrayOf(
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    DocumentsContract.Document.COLUMN_SIZE,
                    DocumentsContract.Document.COLUMN_LAST_MODIFIED,
                ),
                null,
                null,
                null,
            )?.use { cursor ->
                while (cursor.moveToNext()) {
                    val docId = cursor.getString(0) ?: continue
                    val name = cursor.getString(1) ?: continue
                    if (!backupNamePattern.matches(name)) continue
                    out.add(JSONObject().apply {
                        put("docId", docId)
                        put("name", name)
                        put("bytes", if (cursor.isNull(2)) 0L else cursor.getLong(2))
                        put("at", if (cursor.isNull(3)) 0L else cursor.getLong(3))
                    })
                }
            }
        } catch (e: Exception) {
            return emptyList()
        }
        return out.sortedByDescending { it.optString("name") }
    }

    @PluginMethod
    fun backupCall(call: PluginCall) {
        val method = call.getString("method").orEmpty()
        val value = call.getObject("value") ?: JSObject()
        when (method) {
            "state" -> {
                // 每次启动 web 都会先读一次 state：顺手把后台提醒排上（老状态里可能根本没排过）
                if (!backupArmed) {
                    backupArmed = true
                    EllenBackupWorker.scheduleNext(context)
                }
                call.resolve(statePayload())
            }
            "configure" -> configure(call, value)
            "begin" -> backupBegin(call, value)
            "write" -> backupWrite(call, value)
            "commit" -> backupCommit(call, value)
            "abort" -> backupAbort(call, value)
            else -> call.reject("不认识的备份操作：$method", "BACKUP_UNAVAILABLE")
        }
    }

    private fun configure(call: PluginCall, value: JSObject) {
        val json = withDefaults(readState())
        if (value.has("enabled")) json.put("enabled", value.optBoolean("enabled", false))
        if (value.has("intervalDays")) json.put("intervalDays", (value.optInt("intervalDays", 7)).coerceIn(1, 90))
        if (value.has("retainGroups")) json.put("retainGroups", (value.optInt("retainGroups", BACKUP_RETAIN)).coerceIn(1, 10))
        if (json.optBoolean("enabled") && json.optString("directory").isNotBlank() && json.optLong("nextAt", 0L) == 0L) {
            json.put("nextAt", System.currentTimeMillis() + json.optInt("intervalDays", 7) * DAY)
        }
        if (!json.optBoolean("enabled")) json.put("nextAt", 0L)
        writeState(json)
        // 开关/间隔/nextAt 变了，后台提醒要跟着重排（关掉时 scheduleNext 会撤掉排期）
        EllenBackupWorker.scheduleNext(context)
        call.resolve(statePayload())
    }

    @PluginMethod
    fun chooseBackupDirectory(call: PluginCall) {
        directoryCall = call
        try {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
                addFlags(Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
            }
            startActivityForResult(call, intent, "chosenDirectory")
        } catch (e: Exception) {
            directoryCall = null
            call.reject("这台机器没有文件夹选择器。", "BACKUP_UNAVAILABLE")
        }
    }

    @ActivityCallback
    private fun chosenDirectory(call: PluginCall?, result: androidx.activity.result.ActivityResult) {
        val target = directoryCall
        directoryCall = null
        if (target == null) return
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            target.reject("没有选文件夹。", "BACKUP_CANCELLED")
            return
        }
        try {
            context.contentResolver.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
            )
        } catch (e: Exception) {
            // 有些 ROM 不给持久授权，本次会话内仍可用
        }
        val name = try {
            DocumentsContract.getTreeDocumentId(uri).substringAfterLast(':').ifBlank { "Documents" }
        } catch (e: Exception) {
            "Documents"
        }
        val json = withDefaults(readState())
        json.put("directory", uri.toString())
        json.put("directoryName", name)
        if (json.optBoolean("enabled") && json.optLong("nextAt", 0L) == 0L) {
            json.put("nextAt", System.currentTimeMillis() + json.optInt("intervalDays", 7) * DAY)
        }
        writeState(json)
        val out = statePayload()
        out.put("directoryName", name)
        EllenBackupWorker.scheduleNext(context)
        target.resolve(out)
    }

    private fun backupBegin(call: PluginCall, value: JSObject) {
        val state = withDefaults(readState())
        val dir = state.optString("directory")
        if (dir.isBlank()) {
            call.reject("还没选备份文件夹。", "BACKUP_NO_DIRECTORY")
            return
        }
        val manifestText = value.getString("manifestText").orEmpty()
        if (manifestText.isBlank()) {
            call.reject("备份内容是空的。", "BACKUP_EMPTY")
            return
        }

        // 清单里声明的附件清单：附件区字节必须按这个顺序、按这些 sha256 落盘。
        // 先校验清单再建文件，免得建出一个注定要删的空壳。
        val declared = JSONArray()
        try {
            val manifest = JSONObject(manifestText)
            val arr = manifest.optJSONArray("files") ?: JSONArray()
            for (i in 0 until arr.length()) {
                val f = arr.optJSONObject(i) ?: throw IllegalStateException("files[$i] 不是对象")
                val id = f.optString("id")
                val sha = f.optString("sha256").lowercase()
                val size = f.optLong("sizeBytes", 0L)
                if (id.isEmpty()) throw IllegalStateException("files[$i] 缺 id")
                if (!hex64.matches(sha)) throw IllegalStateException("files[$i] 的 sha256 不合法")
                if (size <= 0L) throw IllegalStateException("files[$i] 的 sizeBytes 不合法")
                declared.put(JSONObject().apply {
                    put("id", id)
                    put("sha256", sha)
                    put("sizeBytes", size)
                })
            }
        } catch (e: Exception) {
            call.reject("备份清单读不出来：${e.message ?: e.javaClass.simpleName}", "ARCHIVE_MANIFEST_INVALID")
            return
        }

        backupWriter?.let {
            // 上一份没收尾：先当失败处理，免得两份写同一个文件
            backupAbortSilently()
        }

        val treeUri = Uri.parse(dir)
        val name = "艾莲备份-${stamp()}.ellenpack"
        try {
            val treeDocId = DocumentsContract.getTreeDocumentId(treeUri)
            val parent = DocumentsContract.buildDocumentUriUsingTree(treeUri, treeDocId)
            val docUri = DocumentsContract.createDocument(
                context.contentResolver,
                parent,
                "application/octet-stream",
                name,
            ) ?: throw IllegalStateException("createDocument 返回 null")

            val writer = Writer(docUri, name, declared)
            val stream = context.contentResolver.openOutputStream(docUri, "wt")
                ?: throw IllegalStateException("openOutputStream 返回 null")
            writer.out = stream

            val manifestBytes = manifestText.toByteArray(Charsets.UTF_8)
            stream.write(magic)
            writeInt(stream, manifestBytes.size)
            stream.write(manifestBytes)
            writer.sha.update(manifestBytes)
            writer.bytes = magic.size + 4L + manifestBytes.size
            backupWriter = writer

            val out = JSObject()
            out.put("handle", name)
            out.put("name", name)
            out.put("bytes", writer.bytes)
            out.put("files", declared.length())
            call.resolve(out)
        } catch (e: Exception) {
            call.reject("备份没开起来：${e.javaClass.simpleName}", "BACKUP_WRITE_FAILED")
        }
    }

    private fun backupWrite(call: PluginCall, value: JSObject) {
        val writer = backupWriter
        if (writer == null) {
            call.reject("没有正在进行的备份。", "BACKUP_NOT_STARTED")
            return
        }
        val expected = value.optLong("offset", -1L)
        if (expected >= 0 && expected != writer.offset) {
            call.reject("写备份的顺序乱了。", "BACKUP_OUT_OF_ORDER")
            return
        }
        val b64 = value.getString("data").orEmpty()
        if (b64.isEmpty()) {
            call.reject("这一块是空的。", "BACKUP_EMPTY_CHUNK")
            return
        }
        try {
            val bytes = Base64.decode(b64, Base64.DEFAULT)
            if (bytes.isEmpty()) {
                call.reject("这一块是空的。", "BACKUP_EMPTY_CHUNK")
                return
            }
            val stream = writer.out ?: throw IllegalStateException("输出流已经关了")
            stream.write(bytes)
            writer.sha.update(bytes)
            writer.bytes += bytes.size
            writer.offset += bytes.size

            // 附件区按 manifest.files 的顺序落字节：一个文件写满立刻校 sha256，
            // 不符就把这份半成品删掉（ARCHIVE_FILE_MISMATCH），别等 commit 才发现包里是坏字节。
            var at = 0
            while (at < bytes.size) {
                if (writer.fileIndex >= writer.files.length()) {
                    throw FileMismatch("附件字节比清单多：${writer.files.length()} 个文件已写完，还有多余字节。")
                }
                val file = writer.files.getJSONObject(writer.fileIndex)
                val size = file.optLong("sizeBytes", 0L)
                val need = size - writer.fileWritten
                val take = minOf(need, (bytes.size - at).toLong()).toInt()
                writer.fileSha.update(bytes, at, take)
                writer.fileWritten += take
                at += take
                if (writer.fileWritten >= size) {
                    val actual = hexOf(writer.fileSha.digest())
                    val expected = file.optString("sha256")
                    if (!actual.equals(expected, ignoreCase = true)) {
                        throw FileMismatch("附件 ${file.optString("id")} 的 sha256 不符（期望 ${expected.take(12)}…，实际 ${actual.take(12)}…）。")
                    }
                    writer.fileIndex++
                    writer.fileSha = MessageDigest.getInstance("SHA-256")
                    writer.fileWritten = 0L
                }
            }

            val out = JSObject()
            out.put("offset", writer.offset)
            out.put("bytes", writer.bytes)
            out.put("fileIndex", writer.fileIndex)
            out.put("fileBytes", writer.fileWritten)
            call.resolve(out)
        } catch (e: FileMismatch) {
            failWriter(writer, e.message ?: "附件校验失败")
            call.reject(e.message ?: "附件校验失败。", "ARCHIVE_FILE_MISMATCH")
        } catch (e: Exception) {
            call.reject("写备份失败：${e.javaClass.simpleName}", "BACKUP_WRITE_FAILED")
        }
    }

    private fun backupCommit(call: PluginCall, value: JSObject) {
        val writer = backupWriter
        if (writer == null) {
            call.reject("没有正在进行的备份。", "BACKUP_NOT_STARTED")
            return
        }
        // 清单声明了附件就必须全部落完再收尾，否则容器里 manifest 说有 N 个文件、实际一个都没有
        if (writer.fileIndex < writer.files.length()) {
            val left = writer.files.length() - writer.fileIndex
            failWriter(writer, "还有 $left 个附件没写完，这份备份已清掉。")
            call.reject("还有 $left 个附件没写完。", "ARCHIVE_FILE_MISSING")
            return
        }
        backupWriter = null
        try {
            writer.out?.flush()
            writer.out?.close()

            val json = withDefaults(readState())
            val now = System.currentTimeMillis()
            json.put("lastSuccessAt", now)
            json.put("lastName", writer.name)
            json.put("lastBytes", writer.bytes)
            json.put("lastError", "")
            json.put("nextAt", now + json.optInt("intervalDays", 7) * DAY)
            writeState(json)

            val pruned = prune(json)
            // 备份成功了：nextAt 已经推到下一次，后台提醒跟着重排
            EllenBackupWorker.scheduleNext(context)

            val group = JSObject().apply {
                put("name", writer.name)
                put("bytes", writer.bytes)
                put("at", now)
            }
            val out = JSObject()
            out.put("group", group)
            out.put("pruned", pruned)
            out.put("state", statePayload())
            call.resolve(out)
        } catch (e: Exception) {
            call.reject("备份收尾失败：${e.javaClass.simpleName}", "BACKUP_WRITE_FAILED")
        }
    }

    private fun backupAbort(call: PluginCall, value: JSObject) {
        val writer = backupWriter
        backupWriter = null
        if (writer != null) {
            try {
                writer.out?.close()
            } catch (_: Exception) {
                /* 已经断了 */
            }
            try {
                DocumentsContract.deleteDocument(context.contentResolver, writer.uri)
            } catch (_: Exception) {
                /* 删不掉就留着，下次会当成坏包 */
            }
        }
        val json = withDefaults(readState())
        json.put("lastError", "上次备份没写完，已清掉半截文件。")
        writeState(json)
        val out = JSObject()
        out.put("aborted", writer != null)
        call.resolve(out)
    }

    private fun backupAbortSilently() {
        val writer = backupWriter
        backupWriter = null
        if (writer == null) return
        try {
            writer.out?.close()
        } catch (_: Exception) {
            /* ignore */
        }
        try {
            DocumentsContract.deleteDocument(context.contentResolver, writer.uri)
        } catch (_: Exception) {
            /* ignore */
        }
    }

    /** 只留最近 retainGroups 份，多的删掉。返回被删的文件名。 */
    private fun prune(state: JSONObject): JSONArray {
        val keep = state.optInt("retainGroups", BACKUP_RETAIN).coerceIn(1, 10)
        val groups = listGroups(state)
        val pruned = JSONArray()
        if (groups.size <= keep) return pruned
        val treeUri = Uri.parse(state.optString("directory"))
        groups.drop(keep).forEach { g ->
            val name = g.optString("name")
            try {
                val docUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, g.optString("docId"))
                DocumentsContract.deleteDocument(context.contentResolver, docUri)
                pruned.put(name)
            } catch (_: Exception) {
                /* 删不掉就算了，不能因此把整次备份判失败 */
            }
        }
        return pruned
    }

    // —— 小工具 ——

    /** 附件 sha256 不符：单独一类，好和「磁盘写不进去」区分开。 */
    private class FileMismatch(message: String) : Exception(message)

    private fun hexOf(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

    /** 写坏了：关流 + 删掉半成品，再把错误记进 state。 */
    private fun failWriter(writer: Writer, message: String) {
        backupWriter = null
        try {
            writer.out?.flush()
        } catch (_: Exception) {
            /* ignore */
        }
        try {
            writer.out?.close()
        } catch (_: Exception) {
            /* ignore */
        }
        try {
            DocumentsContract.deleteDocument(context.contentResolver, writer.uri)
        } catch (_: Exception) {
            /* 删不掉就留着，下次会被当成坏包 */
        }
        val json = withDefaults(readState())
        json.put("lastError", message)
        writeState(json)
    }

    private fun writeInt(out: OutputStream, value: Int) {
        out.write((value shr 24) and 0xff)
        out.write((value shr 16) and 0xff)
        out.write((value shr 8) and 0xff)
        out.write(value and 0xff)
    }

    private fun readInt(input: java.io.InputStream): Int {
        val b = ByteArray(4)
        var read = 0
        while (read < 4) {
            val n = input.read(b, read, 4 - read)
            if (n <= 0) break
            read += n
        }
        if (read < 4) return -1
        return ((b[0].toInt() and 0xff) shl 24) or
            ((b[1].toInt() and 0xff) shl 16) or
            ((b[2].toInt() and 0xff) shl 8) or
            (b[3].toInt() and 0xff)
    }

    private fun stamp(): String =
        SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())

    override fun handleOnDestroy() {
        backupAbortSilently()
        super.handleOnDestroy()
    }

    private companion object {
        const val BACKUP_RETAIN = 3
        const val DAY = 24L * 60 * 60 * 1000
        const val MAX_MANIFEST = 0x1100000
    }
}
