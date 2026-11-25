/**
 * Protection #5: certificate pinning on calls to YOUR OWN backend.
 *
 * This is exactly what made AppSniffer fail silently for the Liverpool
 * match when capturing cricmad's traffic - do the same thing to your own
 * API so nobody can MITM-sniff your /api/resolve calls the way this whole
 * investigation did to cricmad.
 *
 * 1. Get your backend's certificate pin (SHA-256 of the public key):
 *      openssl s_client -connect your-backend-domain.com:443 < /dev/null 2>/dev/null \\
 *        | openssl x509 -pubkey -noout \\
 *        | openssl pkey -pubin -outform der \\
 *        | openssl dgst -sha256 -binary \\
 *        | openssl enc -base64
 *
 * 2. Put that value below, and ship this OkHttpClient as the one you use
 *    for ALL calls to your backend.
 *
 * IMPORTANT: when you rotate your TLS certificate in the future, you must
 * ship an app update with the new pin BEFORE the old cert expires, or your
 * app will refuse to connect to its own backend. Consider pinning the
 * certificate's public key (survives a cert renewal if you reuse the same
 * key pair) rather than the leaf cert itself, or pin two values (current +
 * next) ahead of a planned rotation.
 */
package com.egidepage.tv.network

import okhttp3.CertificatePinner
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

object NetworkSecurity {

    private const val BACKEND_HOST = "your-backend-domain.com"

    // Replace with the real pin from the openssl command above. Keeping a
    // backup pin here means you can rotate without bricking old app
    // installs - generate the NEXT cert's key pair ahead of time, compute
    // its pin, and include it even before you switch to it.
    private const val PRIMARY_PIN = "sha256/REPLACE_ME_PRIMARY_PIN="
    private const val BACKUP_PIN = "sha256/REPLACE_ME_BACKUP_PIN="

    fun buildClient(): OkHttpClient {
        val pinner = CertificatePinner.Builder()
            .add(BACKEND_HOST, PRIMARY_PIN)
            .add(BACKEND_HOST, BACKUP_PIN)
            .build()

        return OkHttpClient.Builder()
            .certificatePinner(pinner)
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .addInterceptor(AppSignatureInterceptor()) // protection #6, see AppSignature.kt
            .build()
    }
}
