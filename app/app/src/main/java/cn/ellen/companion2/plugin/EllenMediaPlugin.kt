package cn.ellen.companion2.plugin

import android.Manifest
import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.io.ByteArrayOutputStream
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 聊天里的图片：选图（SAF）与存相册。只做两件事：pickImage / saveToAlbum。
 *
 * 为什么用 ACTION_OPEN_DOCUMENT 而不是 READ_MEDIA_IMAGES：系统相册选择器是「用户亲手指定一张」，
 * 根本没给 app 读整个相册的授权，所以不需要任何读权限；Android 13 那套细分媒体权限也就完全不用碰。
 *
 * 为什么选完先压缩再落盘：聊天里发的是 1080 长边的截图/照片，原图动辄 4~8 MB，
 * 一条消息带 3 张就把整库撑爆，而过桥的 base64 还要再涨 1/3。
 * 落到 `filesDir/photos/IMG_<ts>.jpg`，FileProvider 的 files-path 已经覆盖整个 filesDir，
 * 于是 uri 能直接丢给 EllenDocuments.open 读回 base64。
 *
 * 落点必须原子（先写 .part 再改名）：中途被系统杀掉时相册里不会留半张图。
 */
@CapacitorPlugin(
    name = "EllenMedia",
    // 只有 API 28 及以下往相册写真需要存储权限；29+ 由 MediaStore 代管、不声明也不申请。
    permissions = [Permission(alias = "storage", strings = [Manifest.permission.WRITE_EXTERNAL_STORAGE])],
)
class EllenMediaPlugin : Plugin() {

    /** 挂起的选择器 Call：Activity 被回收时要清掉，否则那个 Promise 永远不落地。 */
    private var pickCall: PluginCall? = null

    private fun photosDir(): File = File(context.filesDir, "photos").apply { mkdirs() }

    private fun attachmentsDir(): File = File(context.filesDir, "attachments")

    private fun authority(): String = "${context.packageName}.fileprovider"

    /** 存相册的目录名；不给 RELATIVE_PATH 就会散落到 DCIM 根下，用户找不到。 */
    private fun albumDir(): String = "Pictures/艾莲"

    /**
     * pickImage({requestId?, maxSide=1080, maxBytes=2097152})
     *   → {picked:false} 或 {picked:true, name, uri, mimeType, bytes, width, height}
     *
     * 用户取消一律 resolve({picked:false})，不 reject：取消是正常路径，不该逼调用方写 catch。
     */
    @PluginMethod
    fun pickImage(call: PluginCall) {
        if (pickCall != null) {
            call.reject("上一张图还在挑。", "MEDIA_BUSY")
            return
        }
        pickCall = call
        try {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "image/*"
            }
            startActivityForResult(call, intent, "pickedImage")
        } catch (e: Exception) {
            pickCall = null
            call.reject("这台机器没有图片选择器。", "MEDIA_UNAVAILABLE")
        }
    }

    @ActivityCallback
    private fun pickedImage(call: PluginCall?, result: androidx.activity.result.ActivityResult) {
        val target = pickCall ?: call ?: return
        pickCall = null

        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            target.resolve(JSObject().put("picked", false))
            return
        }

        val maxSide = intParam(target, "maxSide", DEFAULT_MAX_SIDE).coerceIn(MIN_MAX_SIDE, MAX_MAX_SIDE)
        val maxBytes = longParam(target, "maxBytes", DEFAULT_MAX_BYTES).coerceIn(MIN_MAX_BYTES, MAX_MAX_BYTES)

        // 解码 + 压质量是几十到几百毫秒的活，放主线程会让「刚选完图」那一秒整屏定住
        Thread {
            try {
                resolveOnUi(target, compressToPhoto(uri, maxSide, maxBytes))
            } catch (e: Exception) {
                rejectOnUi(target, "这张图处理不了：${e.javaClass.simpleName}", "MEDIA_DECODE_FAILED")
            }
        }.apply { isDaemon = true }.start()
    }

    /** 读图 → 校正 EXIF 方向 → 缩到长边上限 → 压到体积上限 → 原子落盘。 */
    private fun compressToPhoto(uri: Uri, maxSide: Int, maxBytes: Long): JSObject {
        val resolver = context.contentResolver

        // 第一遍只读尺寸（inJustDecodeBounds），不占像素内存；拿不到尺寸说明根本不是图
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
            ?: throw IllegalStateException("读不到这张图")
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw IllegalStateException("这不是有效的图片")

        // 采样率按 2 的幂往下降，先省内存再谈质量：4000px 的原图直接整张解码会吃掉几十 MB
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= maxSide && bounds.outHeight / (sample * 2) >= maxSide) {
            sample *= 2
        }
        val options = BitmapFactory.Options().apply { inSampleSize = sample }
        var bitmap = resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) }
            ?: throw IllegalStateException("解码失败")

        bitmap = applyExifRotation(uri, bitmap)
        bitmap = scaleToMaxSide(bitmap, maxSide)
        val bytes = encodeJpeg(bitmap, maxBytes)
        val width = bitmap.width
        val height = bitmap.height

        val name = "IMG_${stamp()}.jpg"
        val file = File(photosDir(), name)
        val part = File(photosDir(), "$name.part")
        part.outputStream().use { it.write(bytes) }
        if (file.exists()) file.delete()
        if (!part.renameTo(file)) throw IllegalStateException("改名失败")

        val out = JSObject()
        out.put("picked", true)
        out.put("name", name)
        out.put("uri", FileProvider.getUriForFile(context, authority(), file).toString())
        out.put("mimeType", "image/jpeg")
        out.put("bytes", bytes.size.toLong())
        out.put("width", width)
        out.put("height", height)
        return out
    }

    /**
     * 相机拍的照片方向写在 EXIF 里，像素本身是躺着的。
     * 不校正的话聊天里会出现「横着的人」——而位图一旦重新编码，EXIF 就丢了，事后救不回来。
     */
    private fun applyExifRotation(uri: Uri, bitmap: Bitmap): Bitmap {
        val orientation = try {
            context.contentResolver.openInputStream(uri)?.use { stream ->
                ExifInterface(stream).getAttributeInt(
                    ExifInterface.TAG_ORIENTATION,
                    ExifInterface.ORIENTATION_NORMAL,
                )
            } ?: ExifInterface.ORIENTATION_NORMAL
        } catch (e: Exception) {
            // 读不到 EXIF（部分三方相册导出的图）就按正立处理，别为了元数据把整张图废掉
            ExifInterface.ORIENTATION_NORMAL
        }

        val matrix = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> matrix.postRotate(90f)
            ExifInterface.ORIENTATION_ROTATE_180 -> matrix.postRotate(180f)
            ExifInterface.ORIENTATION_ROTATE_270 -> matrix.postRotate(270f)
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.postScale(-1f, 1f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.postScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> {
                matrix.postRotate(90f)
                matrix.postScale(-1f, 1f)
            }
            ExifInterface.ORIENTATION_TRANSVERSE -> {
                matrix.postRotate(270f)
                matrix.postScale(-1f, 1f)
            }
            else -> return bitmap
        }
        return try {
            Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
        } catch (e: Exception) {
            bitmap
        }
    }

    private fun scaleToMaxSide(bitmap: Bitmap, maxSide: Int): Bitmap {
        val longSide = maxOf(bitmap.width, bitmap.height)
        if (longSide <= maxSide) return bitmap
        val scale = maxSide.toFloat() / longSide.toFloat()
        val w = maxOf(1, Math.round(bitmap.width * scale))
        val h = maxOf(1, Math.round(bitmap.height * scale))
        return try {
            Bitmap.createScaledBitmap(bitmap, w, h, true)
        } catch (e: Exception) {
            bitmap
        }
    }

    /**
     * 质量二分：只压质量通常就够；实在塞不进上限时再按 3/4 缩尺寸重来，最多几轮。
     *
     * 最后一轮还不达标也照样返回——宁可回一张糊的，也别让用户白选一次图然后收到一个错误。
     */
    private fun encodeJpeg(bitmap: Bitmap, maxBytes: Long): ByteArray {
        var current = bitmap
        var smallest: ByteArray? = null
        repeat(SHRINK_ROUNDS) {
            var low = MIN_QUALITY
            var high = 100
            var best: ByteArray? = null
            while (low <= high) {
                val mid = (low + high) / 2
                val data = toJpeg(current, mid)
                if (smallest == null || data.size < smallest!!.size) smallest = data
                if (data.size.toLong() <= maxBytes) {
                    best = data
                    low = mid + 1
                } else {
                    high = mid - 1
                }
            }
            if (best != null) return best
            val w = current.width
            val h = current.height
            if (w <= MIN_DIMENSION || h <= MIN_DIMENSION) return smallest ?: toJpeg(current, MIN_QUALITY)
            current = try {
                Bitmap.createScaledBitmap(current, maxOf(1, w * 3 / 4), maxOf(1, h * 3 / 4), true)
            } catch (e: Exception) {
                return smallest ?: toJpeg(current, MIN_QUALITY)
            }
        }
        return smallest ?: toJpeg(bitmap, MIN_QUALITY)
    }

    private fun toJpeg(bitmap: Bitmap, quality: Int): ByteArray {
        val buffer = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, quality, buffer)
        return buffer.toByteArray()
    }

    /**
     * saveToAlbum({requestId?, name, mimeType?}) → {saved:true}
     *
     * 只认「photos/ 或 attachments/ 里的文件名」，绝不拿调用方给的字符串拼路径（防 ../）。
     * 失败按契约分三种码：MEDIA_NOT_FOUND / MEDIA_PERMISSION / MEDIA_WRITE_FAILED。
     */
    @PluginMethod
    fun saveToAlbum(call: PluginCall) {
        // name 是契约字段；path 只是兼容早期写法，值同样是文件名
        val raw = call.getString("name") ?: call.getString("path")
        val name = safeFileName(raw.orEmpty())
        if (name.isEmpty()) {
            call.reject("没有指定要存的图片。", "MEDIA_NOT_FOUND")
            return
        }
        val file = photoFile(name)
        if (file == null || !file.isFile) {
            call.reject("这张图找不到了。", "MEDIA_NOT_FOUND")
            return
        }
        val mime = call.getString("mimeType").orEmpty()
        val safeMime = if (mime.startsWith("image/")) mime else "image/jpeg"

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            insertWithMediaStore(call, file, name, safeMime)
            return
        }
        if (!hasStoragePermission()) {
            requestPermissionForAlias("storage", call, "storageResult")
            return
        }
        insertLegacy(call, file, name)
    }

    @PermissionCallback
    private fun storageResult(call: PluginCall) {
        if (!hasStoragePermission()) {
            call.reject("没有写相册的权限。", "MEDIA_PERMISSION")
            return
        }
        val name = safeFileName(call.getString("name") ?: call.getString("path").orEmpty())
        val file = photoFile(name)
        if (file == null || !file.isFile) {
            call.reject("这张图找不到了。", "MEDIA_NOT_FOUND")
            return
        }
        insertLegacy(call, file, name)
    }

    /**
     * Android 10+：自己 insert 一条 MediaStore 记录再往里写流，全程不碰存储权限。
     * IS_PENDING 必须置 1 再回 0 —— 否则相册可能在文件还没写完时就把半张图扫进去。
     */
    private fun insertWithMediaStore(call: PluginCall, file: File, name: String, mime: String) {
        val resolver = context.contentResolver
        val collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, name)
            put(MediaStore.Images.Media.MIME_TYPE, mime)
            put(MediaStore.Images.Media.RELATIVE_PATH, albumDir())
            put(MediaStore.Images.Media.IS_PENDING, 1)
        }
        var target: Uri? = null
        try {
            target = resolver.insert(collection, values) ?: throw IllegalStateException("系统没给相册条目")
            resolver.openOutputStream(target)?.use { out ->
                file.inputStream().use { input -> input.copyTo(out) }
            } ?: throw IllegalStateException("打不开相册写入流")
            val done = ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) }
            resolver.update(target, done, null, null)
            call.resolve(JSObject().put("saved", true))
        } catch (e: SecurityException) {
            target?.let { runCatching { resolver.delete(it, null, null) } }
            call.reject("系统不让写相册。", "MEDIA_PERMISSION")
        } catch (e: Exception) {
            // 失败就把刚建的空条目删掉，不然相册里会留一条打不开的残影
            target?.let { runCatching { resolver.delete(it, null, null) } }
            call.reject("存相册失败：${e.javaClass.simpleName}", "MEDIA_WRITE_FAILED")
        }
    }

    /** Android 9 及以下：老 insertImage 会自己扫库，但要走 WRITE_EXTERNAL_STORAGE。 */
    @Suppress("DEPRECATION")
    private fun insertLegacy(call: PluginCall, file: File, name: String) {
        val bitmap = try {
            file.inputStream().use { BitmapFactory.decodeStream(it) }
        } catch (e: Exception) {
            null
        }
        if (bitmap == null) {
            call.reject("这张图读不出来。", "MEDIA_NOT_FOUND")
            return
        }
        try {
            val url = MediaStore.Images.Media.insertImage(context.contentResolver, bitmap, name, "艾莲")
            if (url.isNullOrEmpty()) {
                call.reject("系统没把图放进相册。", "MEDIA_WRITE_FAILED")
                return
            }
            call.resolve(JSObject().put("saved", true))
        } catch (e: SecurityException) {
            call.reject("没有写相册的权限。", "MEDIA_PERMISSION")
        } catch (e: Exception) {
            call.reject("存相册失败：${e.javaClass.simpleName}", "MEDIA_WRITE_FAILED")
        } finally {
            bitmap.recycle()
        }
    }

    private fun hasStoragePermission(): Boolean = try {
        ContextCompat.checkSelfPermission(context, Manifest.permission.WRITE_EXTERNAL_STORAGE) ==
            PackageManager.PERMISSION_GRANTED
    } catch (e: Exception) {
        false
    }

    /** 先看 photos/（选图落点），再看 attachments/（附件落点）；两处都没有就是真没有。 */
    private fun photoFile(name: String): File? {
        if (name.isEmpty()) return null
        val inPhotos = File(photosDir(), name)
        if (inPhotos.isFile) return inPhotos
        val inAttachments = File(attachmentsDir(), name)
        return if (inAttachments.isFile) inAttachments else null
    }

    /** 只留字母数字和 . _ -，别的一律丢掉；含路径分隔符的一律判非法。 */
    private fun safeFileName(raw: String): String {
        val text = raw.trim()
        if (text.isEmpty() || text.length > 120) return ""
        val backslash = 92.toChar()
        if (text.contains('/') || text.contains(backslash) || text.contains("..")) return ""
        return if (text.all { it.isLetterOrDigit() || it == '.' || it == '_' || it == '-' }) text else ""
    }

    private fun stamp(): String =
        SimpleDateFormat("yyyyMMdd_HHmmss_SSS", Locale.US).format(Date())

    /** JS 的数字过桥一律是 Double，先按 Double 读，读不到再退回整数接口。 */
    private fun intParam(call: PluginCall, key: String, fallback: Int): Int {
        val asDouble = call.getDouble(key)
        if (asDouble != null) return Math.round(asDouble).toInt()
        return call.getInt(key) ?: fallback
    }

    private fun longParam(call: PluginCall, key: String, fallback: Long): Long {
        val asDouble = call.getDouble(key)
        if (asDouble != null) return Math.round(asDouble)
        return call.getLong(key) ?: fallback
    }

    private fun resolveOnUi(call: PluginCall, out: JSObject) {
        val act = activity
        if (act != null && !act.isFinishing && !act.isDestroyed) act.runOnUiThread { call.resolve(out) } else call.resolve(out)
    }

    private fun rejectOnUi(call: PluginCall, message: String, code: String) {
        val act = activity
        if (act != null && !act.isFinishing && !act.isDestroyed) {
            act.runOnUiThread { call.reject(message, code) }
        } else {
            call.reject(message, code)
        }
    }

    /** 页面关掉时把挂起的 Call 清掉：留着就是一个永远不落地的 Promise + 一份 Activity 引用。 */
    override fun handleOnDestroy() {
        pickCall = null
        super.handleOnDestroy()
    }

    private companion object {
        const val DEFAULT_MAX_SIDE = 1080
        const val MIN_MAX_SIDE = 240
        const val MAX_MAX_SIDE = 4096
        const val DEFAULT_MAX_BYTES = 2L * 1024 * 1024
        const val MIN_MAX_BYTES = 64L * 1024
        const val MAX_MAX_BYTES = 32L * 1024 * 1024
        const val MIN_QUALITY = 10
        const val SHRINK_ROUNDS = 5
        const val MIN_DIMENSION = 64
    }
}
