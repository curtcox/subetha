package org.subetha

import java.net.URI
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.SecureRandom
import java.security.Signature
import java.security.spec.EdECPrivateKeySpec
import java.security.spec.NamedParameterSpec

/**
 * An Ed25519 device key (spec §1.3). Signs HTTP requests (`X-Device-*` headers) and
 * enrollment proofs, and optionally envelopes.
 *
 * Implementations: [JdkDeviceSigner] (pure JVM, Java 15+) and `org.subetha.core.CoreDeviceSigner`
 * (the Rust core through UniFFI; works on Android and also signs envelopes).
 */
public interface DeviceSigner {
    /** `dev_` + base32(public key). */
    public val deviceId: String

    /** Raw 64-byte Ed25519 signature over [message]. */
    public fun sign(message: ByteArray): ByteArray

    /**
     * Signs an envelope (spec §4: canonical JSON, sets `sender` and `sig`) and returns the
     * signed JSON. Needs canonical JSON, which lives in the Rust core.
     */
    public fun signEnvelope(envelopeJson: String): String =
        throw UnsupportedOperationException("envelope signing needs org.subetha:subetha-core (CoreDeviceSigner)")
}

/** Envelope crypto that needs the Rust core: signature checks and E2EE (spec §4, §5). */
public interface EnvelopeCrypto {
    public fun verify(envelopeJson: String): Boolean
    public fun encrypt(envelopeJson: String, key: ByteArray, kid: String): String
    /** Null if the key is wrong or the message was tampered with. */
    public fun decrypt(envelopeJson: String, key: ByteArray): String?
}

/** An E2EE topic key (spec §5). */
public class TopicKey(public val kid: String, public val key: ByteArray) {
    init { require(key.size == 32) { "topic keys are 32 bytes" } }
}

/**
 * Ed25519 with the JDK's built-in provider (Java 15+). Deterministic, so its signatures are
 * byte-identical to the Rust core's. Not available on most Android versions: use
 * `CoreDeviceSigner` there.
 */
public class JdkDeviceSigner(seed: ByteArray) : DeviceSigner {
    private val seed: ByteArray = seed.copyOf()
    public val publicKey: ByteArray
    override val deviceId: String

    init {
        require(seed.size == 32) { "Ed25519 seeds are 32 bytes" }
        // The JDK has no "public key from seed" API, but its generator takes the seed from the
        // SecureRandom it is given (RFC 8032 key generation), so feed it the seed.
        val gen = KeyPairGenerator.getInstance("Ed25519")
        gen.initialize(NamedParameterSpec.ED25519, FixedRandom(this.seed))
        val encoded = gen.generateKeyPair().public.encoded // X.509 SubjectPublicKeyInfo; key is the last 32 bytes
        publicKey = encoded.copyOfRange(encoded.size - 32, encoded.size)
        deviceId = Encoding.deviceId(publicKey)
    }

    override fun sign(message: ByteArray): ByteArray {
        val key = KeyFactory.getInstance("Ed25519").generatePrivate(EdECPrivateKeySpec(NamedParameterSpec.ED25519, seed))
        return Signature.getInstance("Ed25519").run {
            initSign(key)
            update(message)
            sign()
        }
    }

    /** The secret seed, for storing in a keystore. */
    public fun seed(): ByteArray = seed.copyOf()

    public companion object {
        @JvmStatic
        public fun generate(): JdkDeviceSigner = JdkDeviceSigner(ByteArray(32).also { SecureRandom().nextBytes(it) })
    }

    private class FixedRandom(private val bytes: ByteArray) : SecureRandom() {
        override fun nextBytes(out: ByteArray) {
            check(out.size == bytes.size) { "unexpected key generation request" }
            bytes.copyInto(out)
        }
    }
}

/** `URL.host` as WHATWG defines it: lowercase host, plus `:port` unless it is the scheme default. */
internal fun urlHost(u: URI): String {
    val host = (u.host ?: "").lowercase()
    val default = when (u.scheme?.lowercase()) { "http", "ws" -> 80; "https", "wss" -> 443; else -> -1 }
    return if (u.port == -1 || u.port == default) host else "$host:${u.port}"
}

/** A fresh single-use request nonce: base64url of 16 random bytes. */
public fun newRequestNonce(): String = Encoding.base64url(ByteArray(16).also { SecureRandom().nextBytes(it) })

/**
 * The string signed for a device-signed request (see workers/api/src/devices.ts):
 * `subetha-req-v1\nMETHOD\nhost\npath?query\ntime\nnonce\nhex(sha256(body))`.
 */
public fun requestSigningInput(method: String, url: String, timeSec: Long, nonce: String, body: ByteArray): String {
    val u = URI(url)
    val pathAndQuery = (u.rawPath?.ifEmpty { "/" } ?: "/") + (u.rawQuery?.let { "?$it" } ?: "")
    return "subetha-req-v1\n${method.uppercase()}\n${urlHost(u)}\n$pathAndQuery\n$timeSec\n$nonce\n${Encoding.hex(Encoding.sha256(body))}"
}

/** `X-Device-Id`, `X-Device-Time`, `X-Device-Nonce` and `X-Device-Signature` for one request. */
@JvmOverloads
public fun signRequest(signer: DeviceSigner, method: String, url: String, body: ByteArray, timeSec: Long, nonce: String = newRequestNonce()): Map<String, String> {
    require(nonce.length in 16..64 && nonce.all { it.isLetterOrDigit() && it.code < 128 || it == '-' || it == '_' }) { "nonce must be 16-64 base64url characters" }
    val sig = signer.sign(requestSigningInput(method, url, timeSec, nonce, body).toByteArray(Charsets.UTF_8))
    return mapOf(
        "X-Device-Id" to signer.deviceId,
        "X-Device-Time" to timeSec.toString(),
        "X-Device-Nonce" to nonce,
        "X-Device-Signature" to Encoding.base64url(sig),
    )
}

/** Proof of key possession for `POST /v1/device/code`. */
public data class EnrollmentProof(val deviceId: String, val time: Long, val proof: String)

public fun enrollmentProof(signer: DeviceSigner, timeSec: Long): EnrollmentProof {
    val sig = signer.sign("subetha-enroll-v1\n${signer.deviceId}\n$timeSec".toByteArray(Charsets.UTF_8))
    return EnrollmentProof(signer.deviceId, timeSec, Encoding.base64url(sig))
}
