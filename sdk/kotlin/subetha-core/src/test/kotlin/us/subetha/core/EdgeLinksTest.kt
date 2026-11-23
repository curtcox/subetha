package us.subetha.core

import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.math.PI
import kotlin.math.sin
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeEach
import us.subetha.SubEtha
import us.subetha.core.ffi.EdgeGossipNode
import us.subetha.core.ffi.newMessageId

/** The edge link drivers in Edge.kt, wired back to back in memory. */
class EdgeLinksTest {
    @BeforeEach
    fun needsLibrary() = assumeTrue(Core.available, "libsubetha_core not found on jna.library.path")

    private val topic = "@alice/doorbell"
    private fun now() = System.currentTimeMillis() / 1000
    private fun env(msg: String, hops: Int = 2) = """{"id":"${newMessageId()}","time":${now()},"topic":"$topic","message":"$msg","hops":$hops}"""
    private fun message(json: String) = Json.parseToJsonElement(json).jsonObject["message"]!!.jsonPrimitive.content

    @Test
    fun qrSenderToReceiver() {
        val node = EdgeGossipNode(false).apply { subscribe(topic) }
        val got = mutableListOf<String>()
        val receiver = QrReceiver { got += acceptPayload(node, it) }
        val envs = (1..6).map { env("message $it with some padding to need several frames") }
        val sender = QrSender(deliverPayload(envs), frameSize = 120)
        assertTrue(sender.sourceBlocks > 1)
        assertEquals(null, receiver.push("https://example.com/not-ours"))
        // Start late and skip every third frame, as a camera would.
        var seq = 3
        while (got.isEmpty() && seq < 200) {
            if (seq % 3 != 0) receiver.push(sender.text(seq))
            seq++
        }
        assertEquals(envs.map(::message), got.map(::message))
        // More frames of the same transfer don't deliver again.
        receiver.push(sender.text(seq))
        assertEquals(6, got.size)
        // A new transfer replaces it, even a one-frame one.
        receiver.push(QrSender(deliverPayload(listOf(env("next")))).text(0))
        assertEquals("next", message(got.last()))
        assertEquals(356, QrSender.frameSizeFor(535))
    }

    @Test
    fun bleLinksGossipBothWays() {
        val phone = EdgeGossipNode(false).apply { subscribe(topic) }
        val watch = EdgeGossipNode(false).apply { subscribe(topic) }
        val atPhone = mutableListOf<String>()
        val atWatch = mutableListOf<String>()
        lateinit var phoneLink: BleLink
        lateinit var watchLink: BleLink
        // Writes go straight to the other side's receive (a GATT write/notification).
        phoneLink = BleLink(phone, { watchLink.receive(it) }, { atPhone += it }, attMtu = 23)
        watchLink = BleLink(watch, { phoneLink.receive(it) }, { atWatch += it }, attMtu = 185)
        assertTrue(phone.publish(env("ding"), now().toULong()))
        assertTrue(watch.publish(env("dong"), now().toULong()))
        phoneLink.resync()
        assertEquals(listOf("ding"), atWatch.map(::message))
        assertEquals(listOf("dong"), atPhone.map(::message))
        // Garbage chunks are dropped, not thrown.
        watchLink.receive(byteArrayOf(1, 2, 3))
        phoneLink.resync()
        assertEquals(1, atWatch.size)
    }

    @Test
    fun audioLinkRoundTripAt44k() {
        val node = EdgeGossipNode(false).apply { subscribe(topic) }
        val e = env("hi", 1)
        val payload = deliverPayload(listOf(e))
        val got = mutableListOf<ByteArray>()
        val link = AudioLink(44_100, play = {}, onPayload = { got += it }, windowSeconds = payload.size / 40f + 2f)
        val samples = link.samples(payload)
        // A little noise before and after, as a microphone hears it.
        val noise = FloatArray(22_050) { 0.01f * sin(2 * PI * 440 * it / 44_100).toFloat() }
        (noise + samples + noise + FloatArray(44_100)).toList().chunked(2048).forEach { link.onSamples(it.toFloatArray()) }
        assertEquals(1, got.size)
        assertEquals(listOf("hi"), acceptPayload(node, got[0]).map(::message))
        assertEquals(emptyList(), acceptPayload(node, got[0]), "duplicates are dropped")
        assertEquals(emptyList(), acceptPayload(node, node.summary(now().toULong())), "only deliver messages are accepted")
    }

    @Test
    fun bridgeCarriesRelayMessagesToTheEdgeAndBack() = runBlocking {
        val relayed = env("from relay", hops = 0)
        val posts = CopyOnWriteArrayList<String>()
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { ex ->
            val body = ex.requestBody.readBytes().decodeToString()
            val out = if (ex.requestMethod == "POST") { if (ex.requestURI.path == "/") posts += body; body } else "{\"event\":\"open\"}\n$relayed\n"
            val bytes = out.toByteArray()
            ex.sendResponseHeaders(200, bytes.size.toLong())
            ex.responseBody.use { it.write(bytes) }
        }
        server.start()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        try {
            val client = SubEtha(baseUrl = "http://127.0.0.1:${server.address.port}", token = "se_t")
            val gateway = EdgeGossipNode(false)
            val downlinked = CopyOnWriteArrayList<String>()
            val bridge = EdgeBridge(client, gateway, listOf(topic), scope, hops = 2, onDownlink = { downlinked += it })
            withTimeout(5_000) { while (downlinked.isEmpty()) delay(20) }
            val d = Json.parseToJsonElement(downlinked.single()).jsonObject
            assertEquals("from relay", d["message"]!!.jsonPrimitive.content)
            assertEquals("2", d["hops"]!!.jsonPrimitive.content, "relay messages get hops so they spread")
            assertFalse("event" in d)

            // An offline watch picks it up from the gateway over BLE, and sends one back.
            val watch = EdgeGossipNode(false).apply { subscribe(topic) }
            val atWatch = mutableListOf<String>()
            val atGateway = mutableListOf<String>()
            lateinit var g: BleLink
            lateinit var w: BleLink
            g = BleLink(gateway, { w.receive(it) }, { atGateway += it })
            w = BleLink(watch, { g.receive(it) }, { atWatch += it })
            val fromWatch = env("from watch", hops = 1)
            assertTrue(watch.publish(fromWatch, now().toULong()))
            w.resync()
            assertEquals(listOf("from relay"), atWatch.map(::message))
            assertEquals(listOf("from watch"), atGateway.map(::message))
            assertTrue(bridge.uplink(atGateway.single()))
            assertFalse(bridge.uplink(atGateway.single()), "each message goes up once")
            assertFalse(bridge.uplink(env("x").replace(topic, "@alice/other")), "only bridged topics")
            assertEquals(listOf("from watch"), posts.map(::message))
            bridge.close()
        } finally {
            scope.cancel()
            server.stop(0)
        }
    }
}
