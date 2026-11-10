package cn.ellen.companion2.vault

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * 密钥仓库：key 存在 Android Keystore 里的 AES 密钥加密后落 SharedPreferences。
 *
 * 为什么不用 androidx.security 的 EncryptedSharedPreferences：
 * 它要多带一个依赖，而且换机恢复时会因为 Keystore 对不上整片读不出来；
 * 这里只需要「一串 key 别明文躺在 dex 隔壁」，自己写 AES/GCM 更可控。
 *
 * 存的东西：模型 apiKey（含 endpoint/model）、minimax 的 tts key、硅基的 asr key。
 * 一律按 scope 分桶（model / voice / asr / tts），一个 scope 一个字符串。
 */
object EllenVault {
    private const val PREFS = "ellen-vault-v1"
    private const val KEY_ALIAS = "ellen-vault-key-v1"
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val IV_BYTES = 12
    private const val TAG_BITS = 128

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun secretKey(): SecretKey {
        val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (store.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
    }

    fun read(context: Context, scope: String): String {
        val packed = prefs(context).getString(scope, null) ?: return ""
        return try {
            val raw = Base64.decode(packed, Base64.NO_WRAP)
            if (raw.size <= IV_BYTES) return ""
            val iv = raw.copyOfRange(0, IV_BYTES)
            val body = raw.copyOfRange(IV_BYTES, raw.size)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(TAG_BITS, iv))
            String(cipher.doFinal(body), Charsets.UTF_8)
        } catch (e: Exception) {
            // Keystore 换了（重装/换机）就解不开，当作没存过，让用户重填一次
            ""
        }
    }

    fun write(context: Context, scope: String, value: String) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val body = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        val packed = ByteArray(cipher.iv.size + body.size)
        cipher.iv.copyInto(packed)
        body.copyInto(packed, cipher.iv.size)
        prefs(context).edit().putString(scope, Base64.encodeToString(packed, Base64.NO_WRAP)).apply()
    }

    fun remove(context: Context, scope: String): Boolean {
        val had = prefs(context).contains(scope)
        prefs(context).edit().remove(scope).apply()
        return had
    }

    fun has(context: Context, scope: String): Boolean = prefs(context).contains(scope)
}
