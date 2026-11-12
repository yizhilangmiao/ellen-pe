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
import android.util.Base64
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.getcapacitor.JSArray
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
 * 聊天里的图片：选图（SAF）、存相册，以及自定义表情的导入/读取/删除。
 *
 * 照片三条（pickImage / saveToAlbum / 内部压缩）：
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

    /**
     * 「导入自定义表情」挂起的选择器 Call。
     * 和 pickCall 分开记：两条流程都要挡住第二个选择器（Android 上第二个会把第一个顶掉，
     * 回来的 Uri 就和发起方对不上号），但各自要能认出「是我的那一张还没回来」。
     */
    private var stickerCall: PluginCall? = null

    private fun photosDir(): File = File(context.filesDir, "photos").apply { mkdirs() }

    /**
     * 自定义表情落点。和 photos/ 分开：photos 是「发给她的照片」（1080 长边），
     * stickers 是「她能用的表情」（512 长边、300KB），混在一起迟早互相清理错。
     */
    private fun stickersDir(): File = File(context.filesDir, "stickers").apply { mkdirs() }

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

    // ───────────────────────── 自定义表情（排期2 §3） ─────────────────────────
    //
    // 为什么这一摊放在原生，而不是 JS 里读 base64 再解码：
    //   1) 用户从相册挑的可能是一张 4000×3000、6 MB 的原图，过桥成 base64 再涨 1/3，
    //      WebView 里再 decode 一次 —— 一台中端机就是两三秒白屏 + 一百多 MB 峰值内存；
    //   2) 动图（gif / 动画 webp）一旦被 JS 重新编码就会变成一张静态图，
    //      这个损失在 web 层补救不回来，只有在拿到原始字节的地方才好判断。
    // 所以：选图、缩放、压体积、判动图、写盘、读回字节，全在这一层做完；
    // web 层只负责「清单（meta）与界面」。清单不放原生：那是随消息库一起备份的东西。

    /**
     * importSticker({requestId?, maxSide=512, maxBytes=307200})
     *   → {picked:false}
     *   | {picked:true, name, mimeType, bytes, width, height, animated, id}
     *
     * 落点 filesDir/stickers/u_<ts>.<ext>，名称只由原生生成（不接受调用方传名，防 ../）。
     * 取消照样 resolve({picked:false})，和 pickImage 一个口径。
     */
    @PluginMethod
    fun importSticker(call: PluginCall) {
        if (pickCall != null || stickerCall != null) {
            call.reject("上一张图还在挑。", "MEDIA_BUSY")
            return
        }
        stickerCall = call
        try {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                // 只给 image/* 会让部分机器的选择器把 gif 也放进来；
                // 显式列 MIME 是为了让「选了动图却变成静图」这件事不发生
                type = "image/*"
                putExtra(
                    Intent.EXTRA_MIME_TYPES,
                    arrayOf("image/png", "image/jpeg", "image/webp", "image/gif"),
                )
            }
            startActivityForResult(call, intent, "pickedSticker")
        } catch (e: Exception) {
            stickerCall = null
            call.reject("这台机器没有图片选择器。", "MEDIA_UNAVAILABLE")
        }
    }

    @ActivityCallback
    private fun pickedSticker(call: PluginCall?, result: androidx.activity.result.ActivityResult) {
        val target = stickerCall ?: call ?: return
        stickerCall = null

        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null) {
            target.resolve(JSObject().put("picked", false))
            return
        }

        val maxSide = intParam(target, "maxSide", STICKER_MAX_SIDE)
            .coerceIn(MIN_MAX_SIDE, MAX_MAX_SIDE)
        val maxBytes = longParam(target, "maxBytes", STICKER_MAX_BYTES)
            .coerceIn(MIN_MAX_BYTES, MAX_MAX_BYTES)

        Thread {
            try {
                resolveOnUi(target, processSticker(uri, maxSide, maxBytes))
            } catch (e: StickerTooLarge) {
                rejectOnUi(
                    target,
                    "这张图超过 ${maxBytes / 1024}KB 或 ${maxSide}px，动图没法无损缩小，换一张吧。",
                    "MEDIA_TOO_LARGE",
                )
            } catch (e: Exception) {
                rejectOnUi(target, "这张图处理不了：${e.javaClass.simpleName}", "MEDIA_DECODE_FAILED")
            }
        }.apply { isDaemon = true }.start()
    }

    /** 体积超上限。单独一个类型，好让上层给出「太大了」而不是「解码失败」这种误导性提示。 */
    private class StickerTooLarge : Exception()

    /**
     * 分两条路：
     *   · 动图（gif / ANIM 块的 webp）→ 原样复制字节，绝不重编码（重编码 = 掉帧 + 变静图）；
     *   · 静图 → EXIF 校正 → 缩到 ≤maxSide → 压到 ≤maxBytes（有透明通道先试 PNG，塞不下退 JPEG）。
     */
    private fun processSticker(uri: Uri, maxSide: Int, maxBytes: Long): JSObject {
        val mime = (context.contentResolver.getType(uri) ?: "").lowercase(Locale.US)
        // 只有 gif / webp（以及个别机器不给 MIME 的情况）需要先拿原始字节判「是不是动画」。
        // 静图不在这里读：一张 6 MB 的照片读完再丢掉，纯属白吃内存 —— 它走下面的采样解码。
        val maybeAnimated = mime == "image/gif" || mime == "image/webp" || mime.isEmpty()
        val raw = if (maybeAnimated) readBytesLimited(uri, MAX_STICKER_RAW) else null
        val animated = raw != null && isAnimatedBytes(raw, mime)

        if (animated) {
            // 动图不能重编码（会掉帧、会变静图），所以只能在「原样放进去」和「拒绝」之间选。
            // 超标的动图宁可明确拒绝，也不要偷偷压成静图骗用户「导入成功」。
            if (raw == null) throw IllegalStateException("读不到这张图")
            if (raw.size.toLong() > maxBytes) throw StickerTooLarge()
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(raw, 0, raw.size, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw IllegalStateException("这不是有效的图片")
            if (maxOf(bounds.outWidth, bounds.outHeight) > maxSide) throw StickerTooLarge()
            val ext = if (mime == "image/gif" || looksLikeGif(raw)) "gif" else "webp"
            val name = "u_${stamp()}.$ext"
            writeAtomically(name, raw)
            return stickerResult(
                name = name,
                mimeType = if (ext == "gif") "image/gif" else "image/webp",
                bytes = raw.size,
                width = bounds.outWidth,
                height = bounds.outHeight,
                animated = true,
            )
        }

        // 静图：走和照片同一套采样/缩放的思路，只是目标尺寸小得多
        val source = decodeScaled(uri, maxSide)
            ?: throw IllegalStateException("解码失败")
        val rotated = applyExifRotation(uri, source)
        val scaled = scaleToMaxSide(rotated, maxSide)
        val hasAlpha = scaled.hasAlpha()

        var bytes = encodePng(scaled)
        var ext = "png"
        var outMime = "image/png"
        // PNG 塞不进 300KB（照片类素材几乎必然）就退 JPEG：表情面板里一律 512 长边，
        // 丢掉透明通道的代价远小于「存不进来」
        if (!hasAlpha || bytes.size.toLong() > maxBytes) {
            bytes = encodeJpeg(scaled, maxBytes)
            ext = "jpg"
            outMime = "image/jpeg"
        }
        if (bytes.size.toLong() > maxBytes) throw StickerTooLarge()

        val name = "u_${stamp()}.$ext"
        writeAtomically(name, bytes)
        return stickerResult(
            name = name,
            mimeType = outMime,
            bytes = bytes.size,
            width = scaled.width,
            height = scaled.height,
            animated = false,
        )
    }

    private fun stickerResult(
        name: String,
        mimeType: String,
        bytes: Int,
        width: Int,
        height: Int,
        animated: Boolean,
    ): JSObject {
        val out = JSObject()
        out.put("picked", true)
        out.put("name", name)
        // id 只在 web 层拼（`u:` 前缀是它的约定）；原生给 name，别把命名规则藏两份
        out.put("mimeType", mimeType)
        out.put("bytes", bytes.toLong())
        out.put("width", width)
        out.put("height", height)
        out.put("animated", animated)
        return out
    }

    /** 读进内存但设硬上限：一张 30 MB 的原图不该把进程撑爆，超过就直接判「太大」。 */
    private fun readBytesLimited(uri: Uri, limit: Long): ByteArray {
        val resolver = context.contentResolver
        val out = ByteArrayOutputStream()
        resolver.openInputStream(uri)?.use { input ->
            val buf = ByteArray(64 * 1024)
            var total = 0L
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                total += n
                if (total > limit) throw StickerTooLarge()
                out.write(buf, 0, n)
            }
        } ?: throw IllegalStateException("读不到这张图")
        return out.toByteArray()
    }

    /**
     * 判动图。gif 不需要判；webp 看 RIFF 里有没有 `ANIM` 块 ——
     * BitmapFactory 对动画 webp 只会给第一帧，靠它判断会一律判成静图。
     * MIME 缺失时（个别文档提供方不给）再退回看文件魔数。
     */
    private fun isAnimatedBytes(bytes: ByteArray, mime: String): Boolean {
        if (mime == "image/gif") return true
        if (mime.isEmpty() && looksLikeGif(bytes)) return true
        if (mime != "image/webp" && !mime.isEmpty()) return false
        // ANIM 块在文件头附近（RIFF + VP8X 之后），查前 4KB 足够，也不至于误伤压缩数据
        val end = minOf(bytes.size - 4, 4096)
        var i = 0
        while (i <= end) {
            if (bytes[i] == 65.toByte() && bytes[i + 1] == 78.toByte() &&
                bytes[i + 2] == 73.toByte() && bytes[i + 3] == 77.toByte()
            ) {
                return true
            }
            i++
        }
        return false
    }

    /** 文件头 GIF8 —— MIME 缺失时的兜底判断。 */
    private fun looksLikeGif(bytes: ByteArray): Boolean {
        if (bytes.size < 4) return false
        return bytes[0] == 71.toByte() && bytes[1] == 73.toByte() &&
            bytes[2] == 70.toByte() && bytes[3] == 56.toByte()
    }

    private fun decodeScaled(uri: Uri, maxSide: Int): Bitmap? {
        val resolver = context.contentResolver
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= maxSide && bounds.outHeight / (sample * 2) >= maxSide) {
            sample *= 2
        }
        val options = BitmapFactory.Options().apply { inSampleSize = sample }
        return resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) }
    }

    private fun encodePng(bitmap: Bitmap): ByteArray {
        val buffer = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, buffer)
        return buffer.toByteArray()
    }

    /** 先写 .part 再改名：中途被杀进程时 stickers/ 里不会留半张图（半张图在面板里就是个破图标）。 */
    private fun writeAtomically(name: String, bytes: ByteArray) {
        val file = File(stickersDir(), name)
        val part = File(stickersDir(), "$name.part")
        part.outputStream().use { it.write(bytes) }
        if (file.exists()) file.delete()
        if (!part.renameTo(file)) throw IllegalStateException("改名失败")
    }

    /**
     * readSticker({name}) → {name, base64, bytes, mimeType}
     *
     * 为什么不复用 EllenDocuments.open：那个插件只认 attachments/ 那一套路径白名单，
     * 表情在 stickers/ 里。要么放开它的白名单（越权改别人的插件），要么在这里给一个只认
     * 文件名的方法 —— 后者的攻击面更小：safeFileName 过后拼到固定目录，不存在 ../ 的可能。
     */
    @PluginMethod
    fun readSticker(call: PluginCall) {
        val name = safeFileName(call.getString("name").orEmpty())
        if (name.isEmpty()) {
            call.reject("没有指定表情文件名。", "STICKER_INVALID_NAME")
            return
        }
        val file = File(stickersDir(), name)
        if (!file.isFile) {
            call.reject("这张表情找不到了。", "STICKER_NOT_FOUND")
            return
        }
        // 读回是有上限的：清单里的东西本该 ≤300KB，超过说明文件被外部换过，
        // 这时宁可报错，也不要把几十 MB 的东西 base64 过桥
        if (file.length() > MAX_STICKER_READ) {
            call.reject("这张表情异常地大，已跳过。", "STICKER_TOO_LARGE")
            return
        }
        Thread {
            try {
                val bytes = file.readBytes()
                val out = JSObject()
                out.put("name", name)
                out.put("bytes", bytes.size.toLong())
                out.put("mimeType", mimeOfName(name))
                out.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
                resolveOnUi(call, out)
            } catch (e: Exception) {
                rejectOnUi(call, "读表情失败：${e.javaClass.simpleName}", "STICKER_READ_FAILED")
            }
        }.apply { isDaemon = true }.start()
    }

    /**
     * deleteSticker({name}) → {removed}
     *
     * 真删。表情是用户自己导入的文件，留在 filesDir 里没有「可恢复」的价值，
     * 只有「越堆越大」的风险 —— 所以删就是删，不做回收站。
     */
    @PluginMethod
    fun deleteSticker(call: PluginCall) {
        val name = safeFileName(call.getString("name").orEmpty())
        if (name.isEmpty()) {
            call.reject("没有指定表情文件名。", "STICKER_INVALID_NAME")
            return
        }
        val file = File(stickersDir(), name)
        val removed = file.isFile && file.delete()
        call.resolve(JSObject().put("removed", removed))
    }

    /**
     * listStickers() → {files:[{name, bytes, mtime}]}
     *
     * 给 web 层做对账：meta 里的条目和磁盘上的文件对不上时（用户清了应用数据、
     * 或某次写盘被杀），以磁盘为准修清单，别留一堆「点了没反应」的格子。
     */
    @PluginMethod
    fun listStickers(call: PluginCall) {
        Thread {
            try {
                val files = stickersDir().listFiles()
                    ?.filter { it.isFile && !it.name.endsWith(".part") }
                    ?.sortedByDescending { it.lastModified() }
                    ?.take(MAX_STICKER_LIST)
                    ?.map { f ->
                        JSObject()
                            .put("name", f.name)
                            .put("bytes", f.length())
                            .put("mtime", f.lastModified())
                    }
                    ?: emptyList()
                val out = JSObject()
                val arr = JSArray()
                files.forEach { arr.put(it) }
                out.put("files", arr)
                resolveOnUi(call, out)
            } catch (e: Exception) {
                rejectOnUi(call, "列表情失败：${e.javaClass.simpleName}", "STICKER_LIST_FAILED")
            }
        }.apply { isDaemon = true }.start()
    }

    private fun mimeOfName(name: String): String = when {
        name.endsWith(".png") -> "image/png"
        name.endsWith(".gif") -> "image/gif"
        name.endsWith(".webp") -> "image/webp"
        else -> "image/jpeg"
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
        stickerCall = null
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

        /** 自定义表情：512 长边 / 300 KB（web 层 core/sticker-library.js 用同一组数复核）。 */
        const val STICKER_MAX_SIDE = 512
        const val STICKER_MAX_BYTES = 300L * 1024

        /** 判动图时最多读进内存的量：够装下任何合理的表情，又不至于被一张巨图撑爆进程。 */
        const val MAX_STICKER_RAW = 8L * 1024 * 1024

        /** 读回上限：清单里本该 ≤300KB，给到 1MB 是留余量，不是留后门。 */
        const val MAX_STICKER_READ = 1024L * 1024

        /** 一次最多列 2000 个：目录异常变大时别把回包撑爆（正常上限是 200 张）。 */
        const val MAX_STICKER_LIST = 2000
    }
}
