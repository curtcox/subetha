package us.subetha

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/** Encodings used by the protocol (spec §1): base32 lowercase no padding, base64url no padding, hex. */
public object Encoding {
    private const val B32 = "abcdefghijklmnopqrstuvwxyz234567"

    public fun base32(bytes: ByteArray): String {
        val sb = StringBuilder((bytes.size * 8 + 4) / 5)
        var buffer = 0
        var bits = 0
        for (b in bytes) {
            buffer = (buffer shl 8) or (b.toInt() and 0xff)
            bits += 8
            while (bits >= 5) {
                sb.append(B32[(buffer shr (bits - 5)) and 31])
                bits -= 5
            }
        }
        if (bits > 0) sb.append(B32[(buffer shl (5 - bits)) and 31])
        return sb.toString()
    }

    public fun base64url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    public fun base64urlDecode(s: String): ByteArray = Base64.getUrlDecoder().decode(s)

    public fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }

    public fun hexDecode(s: String): ByteArray {
        require(s.length % 2 == 0) { "odd-length hex" }
        return ByteArray(s.length / 2) { i -> s.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
    }

    public fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)

    /** `dev_` + base32(public key) (spec §1.3). */
    public fun deviceId(publicKey: ByteArray): String {
        require(publicKey.size == 32) { "Ed25519 public keys are 32 bytes" }
        return "dev_" + base32(publicKey)
    }
}

/** ULIDs (spec §1.1): 48-bit millisecond time + 80 random bits, Crockford base32. Monotonic per process. */
public object Ulid {
    private const val CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    private val random = SecureRandom()
    private var lastTime = -1L
    private val lastRandom = ByteArray(10)

    @Synchronized
    public fun next(nowMs: Long = System.currentTimeMillis()): String {
        if (nowMs == lastTime) {
            // Same millisecond: increment the random part so ids stay sorted.
            var i = 9
            while (i >= 0) {
                val v = (lastRandom[i].toInt() and 0xff) + 1
                lastRandom[i] = v.toByte()
                if (v <= 0xff) break
                i--
            }
        } else {
            random.nextBytes(lastRandom)
            lastTime = nowMs
        }
        val out = CharArray(26)
        var t = nowMs
        for (i in 9 downTo 0) {
            out[i] = CROCKFORD[(t and 31).toInt()]
            t = t shr 5
        }
        var buffer = 0L
        var bits = 0
        var pos = 10
        for (b in lastRandom) {
            buffer = (buffer shl 8) or (b.toLong() and 0xff)
            bits += 8
            while (bits >= 5) {
                out[pos++] = CROCKFORD[((buffer shr (bits - 5)) and 31).toInt()]
                bits -= 5
            }
        }
        return String(out)
    }
}

internal val json: Json = Json { ignoreUnknownKeys = true }

internal fun parseObjectOrNull(text: String): JsonObject? =
    try { json.parseToJsonElement(text) as? JsonObject } catch (_: Exception) { null }
