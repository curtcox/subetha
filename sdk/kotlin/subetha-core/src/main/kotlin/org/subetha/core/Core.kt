package org.subetha.core

import org.subetha.DeviceSigner
import org.subetha.EnvelopeCrypto
import org.subetha.core.ffi.FfiException
import org.subetha.core.ffi.decryptEnvelopeJson
import org.subetha.core.ffi.deviceKeyFromSeed
import org.subetha.core.ffi.encryptEnvelopeJson
import org.subetha.core.ffi.newDeviceKey
import org.subetha.core.ffi.signBytes
import org.subetha.core.ffi.signEnvelopeJson
import org.subetha.core.ffi.unwrapTopicKeyJson
import org.subetha.core.ffi.wrapTopicKeyJson
import org.subetha.core.ffi.verifyEnvelopeJson

/**
 * A device key backed by the Rust core (UniFFI → JNA → libsubetha_core). Signs requests,
 * enrollment proofs and envelopes. Works on Android (ship the .so per ABI in jniLibs).
 *
 * The seed is the secret: keep it in the Android Keystore (wrapped) or an encrypted store.
 */
class CoreDeviceSigner(seed: ByteArray) : DeviceSigner {
    private val seed = seed.copyOf()
    private val record = deviceKeyFromSeed(this.seed)
    val publicKey: ByteArray get() = record.publicKey.copyOf()
    override val deviceId: String = record.deviceId

    override fun sign(message: ByteArray): ByteArray = signBytes(seed, message)

    override fun signEnvelope(envelopeJson: String): String = signEnvelopeJson(envelopeJson, seed)

    fun seed(): ByteArray = seed.copyOf()

    /**
     * Opens a wrapped topic key (spec §5.1; one entry of `GET /v1/keys`) addressed to this
     * device. Null if it's for another device, malformed, or tampered with.
     */
    fun unwrapTopicKey(wrappedJson: String): ByteArray? =
        try { unwrapTopicKeyJson(wrappedJson, seed) } catch (_: FfiException) { null }

    companion object {
        @JvmStatic
        fun generate(): CoreDeviceSigner = CoreDeviceSigner(newDeviceKey().seed)
    }
}

/** Signature checks and E2EE (spec §4, §5) through the Rust core. */
object CoreEnvelopeCrypto : EnvelopeCrypto {
    override fun verify(envelopeJson: String): Boolean = verifyEnvelopeJson(envelopeJson)

    override fun encrypt(envelopeJson: String, key: ByteArray, kid: String): String = encryptEnvelopeJson(envelopeJson, key, kid)

    override fun decrypt(envelopeJson: String, key: ByteArray): String? =
        try { decryptEnvelopeJson(envelopeJson, key) } catch (_: FfiException) { null }
}

/** Wrapped topic keys (spec §5.1): seal a 32-byte topic key to a device for `PUT /v1/keys`. */
object CoreKeyWrap {
    @JvmStatic
    fun wrap(key: ByteArray, topic: String, kid: String, deviceId: String): String = wrapTopicKeyJson(key, topic, kid, deviceId)
}

/** Whether libsubetha_core can be loaded in this process. */
object Core {
    val available: Boolean by lazy {
        try {
            org.subetha.core.ffi.newMessageId().isNotEmpty()
        } catch (_: Throwable) {
            false
        }
    }
}
