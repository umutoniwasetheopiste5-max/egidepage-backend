/**
 * Protection #6: sign every API request so the backend can tell a real app
 * install from someone replaying captured requests (or a clone app copying
 * your API calls - the same way this whole project started by replaying
 * cricmad's).
 *
 * The shared secret below MUST match APP_SHARED_SECRET in the backend's
 * .env. Do NOT ship it as a plain string constant - at minimum split it
 * across a few obfuscated fields, or better, derive it at runtime from
 * something that's annoying to extract (e.g. XOR a few hardcoded byte
 * arrays together, or fetch a fragment of it from your /api/config
 * endpoint once on first launch and cache it, so it's never a single
 * static string inside the APK that a decompile shows in one place - the
 * exact gap that let the cricmad/CRICFy Firebase keys turn up in a single
 * strings.xml grep).
 */
package com.egidepage.tv.network

import okhttp3.Interceptor
import okhttp3.Response
import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

class AppSignatureInterceptor : Interceptor {

    // Placeholder - replace with a real runtime-derived secret, see note above.
    private val sharedSecret: String
        get() = SecretParts.assemble()

    override fun intercept(chain: Interceptor.Chain): Response {
        val original = chain.request()
        val path = original.url.encodedPath
        val timestamp = (System.currentTimeMillis() / 1000).toString()
        val signature = hmacSha256Base64Url("$path.$timestamp", sharedSecret)

        val signed = original.newBuilder()
            .header("X-App-Ts", timestamp)
            .header("X-App-Sig", signature)
            .build()

        return chain.proceed(signed)
    }

    private fun hmacSha256Base64Url(data: String, key: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        val raw = mac.doFinal(data.toByteArray(Charsets.UTF_8))
        return android.util.Base64.encodeToString(
            raw,
            android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING
        )
    }
}

/**
 * Trivial example of "don't keep the secret as one plain string" - split
 * into parts that only come together at runtime. This is NOT strong
 * protection on its own (anyone willing to run the app under a debugger
 * can still recover it), it just removes the "one grep finds everything"
 * failure mode we kept hitting analyzing cricmad and CRICFy's own APKs.
 * For real protection, prefer Android Keystore-backed secrets or fetching
 * part of the secret from your backend on first run.
 */
private object SecretParts {
    private val p1 = byteArrayOf(0x72, 0x65, 0x70) // "rep"
    private val p2 = byteArrayOf(0x6c, 0x61, 0x63) // "lac"
    private val p3 = byteArrayOf(0x65, 0x5f, 0x6d) // "e_m"
    private val p4 = byteArrayOf(0x65, 0x21, 0x21) // "e!!"

    fun assemble(): String =
        String(p1 + p2 + p3 + p4, Charsets.UTF_8) // -> replace with your real secret bytes
}
