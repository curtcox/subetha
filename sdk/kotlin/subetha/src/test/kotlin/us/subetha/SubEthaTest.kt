package us.subetha

import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long

// RFC 8032 test 1 seed; spec/vectors/signatures.json devices[0].
const val SEED = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"
const val DEVICE_ID = "dev_25njqamcweflpvkl73j4szahhihoc4xt3ktcgjnpaingr5yhkena"
// spec/vectors/requests.json nonce; ENROLL_SIG is pinned in sdk/core/src/ffi.rs.
const val NONCE = "nonce_0123456789abcdef"
const val ENROLL_SIG = "ZTDaaJXLPfCowo3I7bl8k3JvIl5nYldqr4735NNFrw4bGcu-Tl2p2W7jYXZH8NuORBcsaVO-5Em3aahKD1eqDQ"

class SubEthaTest {
    private fun obj(s: String): JsonObject = json.parseToJsonElement(s).jsonObject

    private fun vectors(name: String): JsonObject =
        json.parseToJsonElement(java.io.File(System.getProperty("subetha.vectors"), name).readText()).jsonObject

    @Test
    fun publishesJsonWithAuthIdempotencyAndRoute() = runBlocking {
        MockServer { r, ex -> MockServer.respond(ex, 200, r.body) }.use { s ->
            val c = SubEtha(baseUrl = s.url + "/", token = "se_t")
            val m = c.publish(
                "@a/b", "hi",
                PublishOptions(title = "T", priority = 3, tags = listOf("x"), route = Route(RouteMode.FAST, maxCostUsd = 0.02, deny = listOf("sms")), idempotencyKey = "k"),
            )
            val r = s.requests.single()
            assertEquals("POST", r.method)
            assertEquals("/", r.pathAndQuery)
            assertEquals("Bearer se_t", r.headers["authorization"])
            assertEquals("k", r.headers["idempotency-key"])
            assertEquals("application/json", r.headers["content-type"])
            assertEquals(
                obj("""{"topic":"@a/b","message":"hi","title":"T","tags":["x"],"route":{"mode":"fast","max_cost_usd_micros":20000,"deny":["sms"]}}"""),
                m.json,
            )
            assertEquals("hi", m.message)
            assertEquals(3, m.priority)
        }
    }

    @Test
    fun estimateSendsDryRun() = runBlocking {
        MockServer { r, ex ->
            MockServer.respond(ex, 200, """{"dry_run":true,"estimate_usd_micros":1500,"plan":[{"transport":"ws","cost_usd_micros":0},{"transport":"sms","cost_usd_micros":1500}],"message":${r.body}}""")
        }.use { s ->
            val e = SubEtha(baseUrl = s.url).estimate("@a/b", "ding", PublishOptions(route = Route(RouteMode.ALL)))
            assertEquals("1", s.requests.single().headers["x-dry-run"])
            assertEquals(1500, e.estimateUsdMicros)
            assertEquals(0.0015, e.estimateUsd)
            assertEquals(listOf("ws", "sms"), e.plan.map { it["transport"]!!.jsonPrimitive.content })
            assertEquals("ding", e.message?.message)
        }
    }

    @Test
    fun errorsCarryCodeStatusAndBody() = runBlocking {
        MockServer { _, ex ->
            MockServer.respond(ex, 402, """{"error":"insufficient_balance","http":402,"message":"no money","shortfall_usd_micros":5}""", headers = mapOf("Retry-After" to "7"))
        }.use { s ->
            val e = assertFailsWith<SubEthaException> { SubEtha(baseUrl = s.url).publish("@a/b", "x") }
            assertEquals("insufficient_balance", e.code)
            assertEquals(402, e.status)
            assertEquals(5, e.body["shortfall_usd_micros"]!!.jsonPrimitive.content.toInt())
            assertEquals(7.0, e.retryAfter)
            assertFalse(e.retryable)
        }
        MockServer { _, ex -> MockServer.respond(ex, 503, "upstream down", "text/plain") }.use { s ->
            val e = assertFailsWith<SubEthaException> { SubEtha(baseUrl = s.url).balance() }
            assertEquals("provider_unavailable", e.code)
            assertEquals("upstream down", e.message!!.substringAfter(": "))
            assertTrue(e.retryable)
        }
    }

    @Test
    fun pollParsesNdjsonAndEncodesTopics() = runBlocking {
        MockServer { _, ex ->
            MockServer.respond(ex, 200, """{"id":"01A","topic":"@a/b c","message":"one"}""" + "\n" + """{"id":"01B","topic":"@a/b c","message":"two"}""" + "\n", "application/x-ndjson")
        }.use { s ->
            val got = SubEtha(baseUrl = s.url).poll(listOf("@a/b c", "@a/d"), priority = listOf(4, 5))
            assertEquals(listOf("one", "two"), got.map { it.message })
            assertEquals("/@a/b%20c,@a/d/json?poll=1&since=all&priority=4,5", s.requests.single().pathAndQuery)
        }
    }

    @Test
    fun subscribeDedupesResumesFromLastIdAndAcks() = runBlocking {
        val conn = AtomicInteger()
        val opens = AtomicInteger()
        MockServer { r, ex ->
            when {
                r.pathAndQuery == "/v1/ack" -> MockServer.respond(ex, 200, """{"acked":true}""")
                conn.incrementAndGet() == 1 -> MockServer.stream(ex, listOf(
                    """{"event":"open","topic":"@a/b"}""",
                    """{"id":"01JD0000000000000000000001","topic":"@a/b","message":"one","event":"message"}""",
                    """{"id":"01jd0000000000000000000001","topic":"@a/b","message":"one","event":"message"}""",
                    """{"event":"keepalive","topic":"@a/b"}""",
                ))
                else -> MockServer.stream(ex, listOf(
                    """{"event":"open","topic":"@a/b"}""",
                    """{"id":"01JD0000000000000000000001","topic":"@a/b","message":"one"}""",
                    """{"id":"01JD0000000000000000000002","topic":"@a/b","message":"two"}""",
                ), holdOpenMs = 5_000)
            }
        }.use { s ->
            val c = SubEtha(baseUrl = s.url, token = "se_t")
            val got = withTimeout(10_000) {
                c.subscribe("@a/b", SubscribeOptions(initialBackoffMs = 10, onOpen = { opens.incrementAndGet() })).take(2).map { it.message }.toList()
            }
            assertEquals(listOf("one", "two"), got)
            assertEquals(2, opens.get())
            val subs = s.requests.filter { it.pathAndQuery.startsWith("/@a/b/json") }
            assertEquals("/@a/b/json", subs[0].pathAndQuery)
            assertEquals("/@a/b/json?since=01JD0000000000000000000001", subs[1].pathAndQuery)
            val acks = s.requests.filter { it.pathAndQuery == "/v1/ack" }.map { obj(it.body) }
            assertEquals(listOf("01JD0000000000000000000001"), acks.map { it["id"]!!.jsonPrimitive.content }.take(1))
            assertEquals("stream", acks[0]["via"]!!.jsonPrimitive.content)
        }
    }

    @Test
    fun subscribeEndsOnAuthErrors() = runBlocking {
        MockServer { _, ex -> MockServer.respond(ex, 403, """{"error":"forbidden","message":"token lacks subscribe scope"}""") }.use { s ->
            val e = assertFailsWith<SubEthaException> {
                withTimeout(5_000) { SubEtha(baseUrl = s.url).subscribe("@a/b").first() }
            }
            assertEquals("forbidden", e.code)
            assertEquals(1, s.requests.size)
        }
    }

    @Test
    fun subscribeRetriesServerErrors() = runBlocking {
        val n = AtomicInteger()
        val errors = AtomicInteger()
        MockServer { r, ex ->
            if (r.pathAndQuery == "/v1/ack") MockServer.respond(ex, 200, "{}")
            else if (n.incrementAndGet() < 3) MockServer.respond(ex, 500, """{"error":"internal"}""")
            else MockServer.stream(ex, listOf("""{"id":"01X","topic":"@a/b","message":"ok"}"""), holdOpenMs = 5_000)
        }.use { s ->
            val m = withTimeout(5_000) {
                SubEtha(baseUrl = s.url).subscribe("@a/b", SubscribeOptions(initialBackoffMs = 5, autoAck = false, onError = { errors.incrementAndGet() })).first()
            }
            assertEquals("ok", m.message)
            assertEquals(2, errors.get())
        }
    }

    @Test
    fun cancellingAnOpenStreamReturnsPromptly() = runBlocking {
        MockServer { _, ex -> MockServer.stream(ex, listOf("""{"event":"open"}""", """{"id":"01Y","topic":"@a/b","message":"x"}"""), holdOpenMs = 30_000) }.use { s ->
            val start = System.nanoTime()
            withTimeout(5_000) { SubEtha(baseUrl = s.url).subscribe("@a/b", SubscribeOptions(autoAck = false)).first() }
            assertTrue(System.nanoTime() - start < 5_000_000_000L)
        }
    }

    @Test
    fun pollTransportDeliversNewMessagesOnly() = runBlocking {
        val n = AtomicInteger()
        MockServer { r, ex ->
            val body = if (n.incrementAndGet() == 1) """{"id":"01P1","topic":"@a/b","message":"p1"}""" + "\n"
            else """{"id":"01P1","topic":"@a/b","message":"p1"}""" + "\n" + """{"id":"01P2","topic":"@a/b","message":"p2"}""" + "\n"
            MockServer.respond(ex, 200, body, "application/x-ndjson")
        }.use { s ->
            val got = withTimeout(5_000) {
                SubEtha(baseUrl = s.url).subscribe("@a/b", SubscribeOptions(transport = SubscribeTransport.POLL, pollIntervalMs = 10, autoAck = false)).take(2).map { it.message }.toList()
            }
            assertEquals(listOf("p1", "p2"), got)
            assertTrue(s.requests[0].pathAndQuery.contains("since=all"))
            assertTrue(s.requests[1].pathAndQuery.contains("since=01P1"))
        }
    }

    @Test
    fun callbackSubscription() {
        MockServer { r, ex ->
            if (r.pathAndQuery == "/v1/ack") MockServer.respond(ex, 200, "{}")
            else MockServer.stream(ex, listOf("""{"id":"01C","topic":"@a/b","message":"cb"}"""), holdOpenMs = 10_000)
        }.use { s ->
            val latch = CountDownLatch(1)
            var got: String? = null
            val sub = SubEtha(baseUrl = s.url).subscribe(listOf("@a/b"), SubscribeOptions(autoAck = false), MessageListener { got = it.message; latch.countDown() })
            assertTrue(latch.await(5, TimeUnit.SECONDS))
            assertEquals("cb", got)
            sub.close()
            assertTrue(sub.isClosed)
        }
    }

    @Test
    fun jdkSignerMatchesTheCore() {
        val signer = JdkDeviceSigner(Encoding.hexDecode(SEED))
        assertEquals(DEVICE_ID, signer.deviceId)
        assertEquals(ENROLL_SIG, enrollmentProof(signer, 1763750000).proof)
        val v = vectors("requests.json")
        assertEquals(NONCE, v["nonce"]!!.jsonPrimitive.content)
        for (c in v["cases"]!!.jsonArray.map { it.jsonObject }) {
            val str = { k: String -> c[k]!!.jsonPrimitive.content }
            val headers = c["headers"]!!.jsonObject.mapValues { it.value.jsonPrimitive.content }
            val body = str("body").toByteArray()
            val time = c["time"]!!.jsonPrimitive.long
            val h = signRequest(signer, str("method"), str("url"), body, time, NONCE, headers)
            assertEquals(str("signed_headers"), h["X-Device-Signed-Headers"], str("name"))
            assertEquals(str("signature"), h["X-Device-Signature"], str("name"))
            assertEquals(str("signing_input"), requestSigningInput(str("method"), str("url"), body, headersToSign(DEVICE_ID, time, NONCE, headers)), str("name"))
        }
        // Host as WHATWG URL.host: lowercase, default ports dropped, others kept.
        assertEquals(
            "subetha-req-v2\nGET\nx.test\n/\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            requestSigningInput("GET", "https://X.test:443", ByteArray(0), emptyList()),
        )
        assertTrue(requestSigningInput("GET", "http://127.0.0.1:8080/a%20b?q=1", ByteArray(0), emptyList()).startsWith("subetha-req-v2\nGET\n127.0.0.1:8080\n/a%20b?q=1\n"))
        val fresh = signRequest(signer, "GET", "https://x.test/", ByteArray(0), 1)
        assertEquals(22, fresh.getValue("X-Device-Nonce").length)
        assertTrue(fresh.getValue("X-Device-Nonce") != signRequest(signer, "GET", "https://x.test/", ByteArray(0), 1).getValue("X-Device-Nonce"))
        assertFailsWith<IllegalArgumentException> { signRequest(signer, "GET", "https://x.test/", ByteArray(0), 1, "short") }
        val g = JdkDeviceSigner.generate()
        assertEquals(g.deviceId, JdkDeviceSigner(g.seed()).deviceId)
        assertFailsWith<UnsupportedOperationException> { g.signEnvelope("{}") }
    }

    @Test
    fun deviceSignedRequestsReplaceTheBearerToken() = runBlocking {
        MockServer { _, ex -> MockServer.respond(ex, 200, """{"available_usd_micros":1,"reserved_usd_micros":0}""") }.use { s ->
            val signer = JdkDeviceSigner(Encoding.hexDecode(SEED))
            val c = SubEtha(baseUrl = s.url, token = "se_t", deviceSigner = signer, signRequests = true, clock = { 1763750000 })
            c.ack("@a/b", "01Z")
            val r = s.requests.single()
            assertNull(r.headers["authorization"])
            assertEquals(DEVICE_ID, r.headers["x-device-id"])
            assertEquals("1763750000", r.headers["x-device-time"])
            val nonce = r.headers["x-device-nonce"]!!
            assertTrue(Regex("^[A-Za-z0-9_-]{16,64}$").matches(nonce))
            // Verify the way the relay does: the public key comes from the device id, and every
            // listed header is signed with its value as received.
            val listed = r.headers["x-device-signed-headers"]!!.split(",")
            assertEquals(listOf("x-device-id", "x-device-time", "x-device-nonce", "content-type"), listed)
            val input = requestSigningInput("POST", s.url + r.pathAndQuery, r.body.toByteArray(), listed.map { it to r.headers[it]!! })
            val spki = Encoding.hexDecode("302a300506032b6570032100") + signer.publicKey
            val ok = Signature.getInstance("Ed25519").run {
                initVerify(KeyFactory.getInstance("Ed25519").generatePublic(X509EncodedKeySpec(spki)))
                update(input.toByteArray())
                verify(Encoding.base64urlDecode(r.headers["x-device-signature"]!!))
            }
            assertTrue(ok)
        }
    }

    @Test
    fun enrollmentFlow() = runBlocking {
        val polls = AtomicInteger()
        MockServer { r, ex ->
            when (r.pathAndQuery) {
                "/v1/device/code" -> MockServer.respond(ex, 200, """{"device_code":"dc","user_code":"BCDF-GHJK","verification_uri":"https://x/console/#device","verification_uri_complete":"https://x/console/#device=BCDF-GHJK","expires_in":600,"interval":0}""")
                else -> if (polls.incrementAndGet() == 1) MockServer.respond(ex, 400, """{"error":"authorization_pending"}""")
                else MockServer.respond(ex, 200, """{"device_id":"$DEVICE_ID","account_id":"acct_1"}""")
            }
        }.use { s ->
            val c = SubEtha(baseUrl = s.url, deviceSigner = JdkDeviceSigner(Encoding.hexDecode(SEED)), clock = { 1763750000 })
            val code = c.startEnrollment(name = "Pixel")
            assertEquals("BCDF-GHJK", code.userCode)
            val body = obj(s.requests[0].body)
            assertEquals(ENROLL_SIG, body["proof"]!!.jsonPrimitive.content)
            assertEquals(1763750000, body["time"]!!.jsonPrimitive.content.toLong())
            assertEquals("Pixel", body["name"]!!.jsonPrimitive.content)
            assertEquals("acct_1", c.awaitEnrollment(code))
        }
    }

    @Test
    fun encodingAndUlid() {
        assertEquals("", Encoding.base32(ByteArray(0)))
        assertEquals("my", Encoding.base32(byteArrayOf(0x66)))
        assertEquals("mzxw6ytboi", Encoding.base32("foobar".toByteArray()))
        val a = Ulid.next(1_700_000_000_000)
        val b = Ulid.next(1_700_000_000_000)
        assertEquals(26, a.length)
        assertTrue(a < b)
        assertEquals(a.substring(0, 10), b.substring(0, 10))
        assertEquals("@a/b,@a/c", SubEtha.topicPath(listOf("@a/b", "@a/c")))
        assertFailsWith<IllegalArgumentException> { PublishOptions(priority = 6) }
        assertFailsWith<IllegalArgumentException> { SubEtha(signRequests = true) }
        assertEquals(JsonPrimitive("x"), Message.parse("""{"topic":"t","a":"x"}""")["a"])
    }
}
