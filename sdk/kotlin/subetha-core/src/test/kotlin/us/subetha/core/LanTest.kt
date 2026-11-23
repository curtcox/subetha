package us.subetha.core

import java.net.InetAddress
import java.net.NetworkInterface
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeEach
import us.subetha.core.ffi.EdgeGossipNode
import us.subetha.core.ffi.lanParseBeacon
import us.subetha.core.ffi.newMessageId

/** LanGossip in memory, and LanNode over real UDP on this host. */
class LanTest {
    @BeforeEach
    fun needsLibrary() = assumeTrue(Core.available, "libsubetha_core not found on jna.library.path")

    private val topic = "@alice/lan"
    private fun now() = System.currentTimeMillis() / 1000
    private fun env(msg: String, hops: Int = 2) =
        """{"id":"${newMessageId()}","time":${now()},"expires":${now() + 600},"topic":"$topic","message":"$msg","hops":$hops}"""
    private fun message(json: String) = Json.parseToJsonElement(json).jsonObject["message"]!!.jsonPrimitive.content
    private fun node() = EdgeGossipNode(false).apply { subscribe(topic) }

    @Test
    fun peersFindEachOtherByBeaconAndSpreadLargeMessages() {
        val hosts = listOf("10.0.0.1", "10.0.0.2", "10.0.0.3")
        val inbox = hosts.map { CopyOnWriteArrayList<String>() }
        val sizes = CopyOnWriteArrayList<Int>()
        val lans = ArrayList<LanGossip>()
        hosts.forEachIndexed { i, host ->
            val n = node()
            n.publish(env("from $host " + "x".repeat(if (i == 0) 3000 else 10)), now().toULong())
            lans += LanGossip(n, 9000 + i, send = { h, p, d ->
                sizes += d.size
                assertEquals(9000 + hosts.indexOf(h), p)
                lans[hosts.indexOf(h)].onDatagram(d, host, 9000 + i)
            }, onMessage = { inbox[i] += message(it) })
        }
        assertEquals("lan/1", Json.parseToJsonElement(lans[0].beacon().decodeToString()).jsonObject["subetha"]!!.jsonPrimitive.content)
        assertEquals(9000, lanParseBeacon(lans[0].beacon())!!.port.toInt())
        for (i in 0..2) for (j in 0..2) if (i != j) lans[j].onBeacon(lans[i].beacon(), hosts[i])
        inbox.forEachIndexed { i, got ->
            assertEquals(2, got.size, hosts[i])
            assertFalse(got.any { it.startsWith("from ${hosts[i]}") })
        }
        assertTrue(sizes.max() <= 1200 + 6)
        assertTrue(sizes.count { it > 1000 } >= 2) // the 3 KB message took several datagrams
        assertEquals(2, lans[0].peerCount)
        lans[0].onBeacon(lans[0].beacon(), hosts[0]) // our own beacon is ignored
        lans[0].onBeacon("junk".toByteArray(), hosts[1])
        assertEquals(2, lans[0].peerCount)
    }

    @Test
    fun peersExpireAndUnknownSendersAreAnswered() {
        var clock = 1_000_000L
        val sent = CopyOnWriteArrayList<Pair<String, Int>>()
        val a = LanGossip(node(), 9100, send = { h, p, _ -> sent += h to p }, onMessage = {}, clockMs = { clock })
        val b = LanGossip(node(), 9101, send = { _, _, _ -> }, onMessage = {})
        a.onBeacon(b.beacon(), "10.0.0.9")
        assertEquals(1, a.peerCount)
        clock += LanGossip.PEER_TIMEOUT_MS + 1
        a.resync()
        assertEquals(0, a.peerCount)
        // A datagram from a peer we never heard a beacon from still gets our summary.
        sent.clear()
        val summary = """{"type":"summary","topics":{}}""".toByteArray()
        val c = us.subetha.core.ffi.lanDatagrams(7u, summary).single()
        a.onDatagram(c, "10.0.0.7", 5555)
        assertTrue(sent.contains("10.0.0.7" to 5555))
    }

    @Test
    fun twoNodesOnThisHostGossipOverMulticast() {
        val loopback = NetworkInterface.getByInetAddress(InetAddress.getLoopbackAddress())
        val a = node()
        val b = node()
        a.publish(env("over real UDP"), now().toULong())
        val got = CopyOnWriteArrayList<String>()
        val port = 40_000 + (Math.random() * 10_000).toInt()
        val nodes = try {
            listOf(
                LanNode(a, {}, port = port, networkInterface = loopback, beaconMs = 100),
                LanNode(b, { got += message(it) }, port = port, networkInterface = loopback, beaconMs = 100),
            )
        } catch (e: Exception) {
            assumeTrue(false, "multicast unavailable here: ${e.message}")
            return
        }
        try {
            val deadline = System.currentTimeMillis() + 5_000
            while (got.isEmpty() && System.currentTimeMillis() < deadline) Thread.sleep(50)
            assumeTrue(nodes[0].peerCount > 0 || got.isNotEmpty(), "multicast loopback doesn't deliver here")
            assertEquals(listOf("over real UDP"), got.toList())
            assertTrue(nodes[1].unicastPort > 0)
            assertEquals(16, nodes[0].nodeId.length)
        } finally {
            nodes.forEach { it.close() }
        }
    }
}
