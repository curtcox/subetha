package us.subetha.core

import com.sun.net.httpserver.HttpServer
import java.io.File
import java.net.InetSocketAddress
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeEach
import us.subetha.Encoding
import us.subetha.JdkDeviceSigner
import us.subetha.PublishOptions
import us.subetha.SubEtha
import us.subetha.TopicKey
import kotlinx.serialization.json.JsonPrimitive
import us.subetha.core.ffi.FfiException
import us.subetha.core.ffi.canonicalizeJson
import us.subetha.core.ffi.HeaderRecord
import us.subetha.core.ffi.requestSigningInput
import us.subetha.core.ffi.validateEnvelopeJson
import us.subetha.signRequest

/** Runs against the real libsubetha_core via JNA; skipped when the library isn't built. */
class CoreTest {
    private val seed = Encoding.hexDecode("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")

    @BeforeEach
    fun needsLibrary() = assumeTrue(Core.available, "libsubetha_core not found on jna.library.path; run cargo build -p subetha-core --features uniffi")

    private fun vectors(name: String): JsonObject =
        Json.parseToJsonElement(File(System.getProperty("subetha.vectors"), name).readText()).jsonObject

    @Test
    fun signaturesConformance() {
        val v = vectors("signatures.json")
        for (d in v["devices"]!!.jsonArray) {
            val s = CoreDeviceSigner(Encoding.hexDecode(d.jsonObject["seed"]!!.jsonPrimitive.content))
            assertEquals(d.jsonObject["device_id"]!!.jsonPrimitive.content, s.deviceId)
        }
        for (c in v["cases"]!!.jsonArray) {
            val o = c.jsonObject
            val s = CoreDeviceSigner(Encoding.hexDecode(o["seed"]!!.jsonPrimitive.content))
            val signed = Json.parseToJsonElement(s.signEnvelope(o["unsigned"].toString())).jsonObject
            assertEquals(o["signed"]!!.jsonObject["sig"], signed["sig"])
            assertTrue(CoreEnvelopeCrypto.verify(o["signed"].toString()))
        }
        for (n in v["negative"]!!.jsonArray) assertFalse(CoreEnvelopeCrypto.verify(n.jsonObject["envelope"].toString()), n.toString())
        // The relay-set `event` and edge-decremented `hops` are outside the signature.
        for (k in listOf("hops_change", "event_added")) {
            val e = v[k]!!.jsonObject
            assertEquals(e["valid"]!!.jsonPrimitive.content.toBoolean(), CoreEnvelopeCrypto.verify(e["envelope"].toString()), k)
        }
    }

    @Test
    fun canonicalAndTopicConformance() {
        val c = vectors("canonical.json")
        for (v in c["valid"]!!.jsonArray) {
            val o = v.jsonObject
            assertEquals(o["canonical"]!!.jsonPrimitive.content, canonicalizeJson(o["input"].toString()), o["name"].toString())
        }
        for (v in c["invalid"]!!.jsonArray) {
            val o = v.jsonObject
            kotlin.test.assertFailsWith<FfiException>(o["name"].toString()) { canonicalizeJson(o["input_json"]!!.jsonPrimitive.content) }
        }
        val t = vectors("topics.json")
        val problems = { topic: String -> validateEnvelopeJson("{\"topic\":${JsonPrimitive(topic)}}") }
        for (v in t["valid"]!!.jsonArray) assertTrue(problems(v.jsonPrimitive.content).isEmpty(), v.toString())
        for (v in t["invalid"]!!.jsonArray) assertFalse(problems(v.jsonPrimitive.content).isEmpty(), v.toString())
    }

    @Test
    fun e2eeConformance() {
        val v = vectors("e2ee.json")
        val key = Encoding.hexDecode(v["key"]!!.jsonPrimitive.content)
        val dec = CoreEnvelopeCrypto.decrypt(v["encrypted"].toString(), key)!!
        assertEquals(v["plaintext"], Json.parseToJsonElement(dec))
        assertNull(CoreEnvelopeCrypto.decrypt(v["encrypted"].toString(), ByteArray(32)))
    }

    @Test
    fun keyWrapConformance() {
        val v = vectors("e2ee.json")
        val w = v["key_wrap"]!!.jsonObject
        val key = Encoding.hexDecode(v["key"]!!.jsonPrimitive.content)
        val device = CoreDeviceSigner(Encoding.hexDecode(w["recipient_seed"]!!.jsonPrimitive.content))
        assertTrue(key.contentEquals(device.unwrapTopicKey(w["wrapped"].toString())!!))
        for (c in w["invalid"]!!.jsonArray) {
            assertNull(device.unwrapTopicKey(c.jsonObject["wrapped"].toString()), c.jsonObject["name"].toString())
        }
        // Round trip through a fresh wrap (random ephemeral key and nonce).
        val fresh = CoreKeyWrap.wrap(key, "@alice/secret", "k2", device.deviceId)
        assertTrue(key.contentEquals(device.unwrapTopicKey(fresh)!!))
        assertNull(CoreDeviceSigner.generate().unwrapTopicKey(fresh))
    }

    @Test
    fun coreAndJdkSignersAgree() {
        val core = CoreDeviceSigner(seed)
        val jdk = JdkDeviceSigner(seed)
        assertEquals(jdk.deviceId, core.deviceId)
        val nonce = "nonce_0123456789abcdef"
        val headers = mapOf("X-Title" to "Door", "Content-Type" to "text/plain")
        val a = signRequest(core, "POST", "https://x.test/v1/ack?x=1", "{}".toByteArray(), 1763750000, nonce, headers)
        val b = signRequest(jdk, "POST", "https://x.test/v1/ack?x=1", "{}".toByteArray(), 1763750000, nonce, headers)
        assertEquals(b, a)
        val signed = us.subetha.headersToSign(core.deviceId, 1763750000, nonce, headers)
        assertEquals(
            us.subetha.requestSigningInput("POST", "https://x.test/v1/ack?x=1", "{}".toByteArray(), signed),
            requestSigningInput("POST", "x.test", "/v1/ack?x=1", "{}".toByteArray(), signed.map { HeaderRecord(it.first, it.second) }),
        )
        val r = us.subetha.core.ffi.signRequest(seed, "POST", "x.test", "/v1/ack?x=1", 1763750000uL, nonce, "{}".toByteArray(), headers.map { HeaderRecord(it.key, it.value) })
        assertEquals(a["X-Device-Signed-Headers"], r.signedHeaders)
        assertEquals(a["X-Device-Signature"], r.signature)
        assertEquals(22, us.subetha.core.ffi.newRequestNonce().length)
        val g = CoreDeviceSigner.generate()
        assertNotEquals(core.deviceId, g.deviceId)
        assertEquals(g.deviceId, CoreDeviceSigner(g.seed()).deviceId)
    }

    @Test
    fun clientSignsEncryptsAndDecrypts() = runBlocking {
        var stored = ""
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { ex ->
            val body = ex.requestBody.readBytes().toString(Charsets.UTF_8)
            val out = if (ex.requestMethod == "POST") { stored = body; body } else stored + "\n"
            val bytes = out.toByteArray()
            ex.sendResponseHeaders(200, bytes.size.toLong())
            ex.responseBody.use { it.write(bytes) }
        }
        server.start()
        try {
            val signer = CoreDeviceSigner(seed)
            val key = ByteArray(32) { it.toByte() }
            val c = SubEtha(
                baseUrl = "http://127.0.0.1:${server.address.port}",
                deviceSigner = signer,
                crypto = CoreEnvelopeCrypto,
                topicKeys = mapOf("@a/b" to TopicKey("k1", key)),
            )
            val sent = c.publish("@a/b", "secret", PublishOptions(title = "shh"))
            assertNotEquals("secret", sent.message)
            assertNull(sent.title)
            assertEquals(signer.deviceId, sent.sender)
            assertTrue(sent.isEncrypted)
            assertTrue(CoreEnvelopeCrypto.verify(sent.toJson()))
            assertTrue(validateEnvelopeJson(sent.toJson()).isEmpty())
            val got = c.poll("@a/b").single()
            assertEquals("secret", got.message)
            assertEquals("shh", got.title)
            assertFalse(got.isEncrypted)
        } finally {
            server.stop(0)
        }
    }
}
