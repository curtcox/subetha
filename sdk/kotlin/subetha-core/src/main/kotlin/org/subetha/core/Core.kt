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
