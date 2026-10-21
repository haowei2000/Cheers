package com.cheers.android.data.auth

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

interface CredentialCodec {
    fun encrypt(value: String): String
    fun decrypt(value: String): String
}

/** Authenticated encryption with an injectable real key for JVM persistence tests. */
class AesGcmCredentialCodec(private val keyFactory: () -> SecretKey) : CredentialCodec {
    override fun encrypt(value: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, keyFactory())
        val encrypted = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        return "v1." + Base64.getEncoder().encodeToString(cipher.iv + encrypted)
    }

    override fun decrypt(value: String): String {
        require(value.startsWith("v1.")) { "Unsupported credential format" }
        val encoded = Base64.getDecoder().decode(value.removePrefix("v1."))
        require(encoded.size >= 12 + 16) { "Invalid encrypted credential" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, keyFactory(), GCMParameterSpec(128, encoded.copyOfRange(0, 12)))
        return cipher.doFinal(encoded.copyOfRange(12, encoded.size)).toString(Charsets.UTF_8)
    }
}

/** The encryption key stays in AndroidKeyStore and is never stored with DataStore. */
class AndroidKeystoreCredentialCodec : CredentialCodec by AesGcmCredentialCodec(::credentialKey)

private val keyLock = Any()
private const val KEY_ALIAS = "com.cheers.android.session_credentials"

private fun credentialKey(): SecretKey = synchronized(keyLock) {
    val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (keyStore.getKey(KEY_ALIAS, null) as? SecretKey) ?: KeyGenerator.getInstance(
        KeyProperties.KEY_ALGORITHM_AES,
        "AndroidKeyStore",
    ).apply {
        init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setKeySize(256)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
    }.generateKey()
}
