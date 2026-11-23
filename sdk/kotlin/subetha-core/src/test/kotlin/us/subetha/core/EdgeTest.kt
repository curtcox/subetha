package us.subetha.core

import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Base64
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeEach
import us.subetha.Encoding
import us.subetha.core.ffi.CoreDeduper
import us.subetha.core.ffi.CoreOutbox
import us.subetha.core.ffi.EdgeAudioReceiver
import us.subetha.core.ffi.EdgeChunkReassembler
import us.subetha.core.ffi.EdgeGossipNode
import us.subetha.core.ffi.EdgeQrDecoder
import us.subetha.core.ffi.EdgeQrEncoder
import us.subetha.core.ffi.audioDemodulate
import us.subetha.core.ffi.bleChunk
import us.subetha.core.ffi.edgeDeliverPayload
import us.subetha.core.ffi.lanDatagrams
import us.subetha.core.ffi.newMessageId

/** Edge transports through the core (spec §11, vectors/edge.json); skipped without the library. */
class EdgeTest {
    @BeforeEach
    fun needsLibrary() = assumeTrue(Core.available, "libsubetha_core not found on jna.library.path")

    private val edge: JsonObject by lazy {
        Json.parseToJsonElement(File(System.getProperty("subetha.vectors"), "edge.json").readText()).jsonObject
    }
    private fun hex(s: String) = Encoding.hexDecode(s)

    @Test
    fun bleLanAndQrMatchTheVectors() {
        val ble = edge["ble"]!!.jsonObject
        val chunks = bleChunk(ble["seq"]!!.jsonPrimitive.int.toUShort(), ble["payload"]!!.jsonPrimitive.content.toByteArray(), ble["att_mtu"]!!.jsonPrimitive.int.toUInt())
        assertEquals(ble["chunks"]!!.jsonArray.map { it.jsonPrimitive.content }, chunks.map { Encoding.hex(it) })

        val lan = edge["lan"]!!.jsonObject
        val n = lan["payload_len"]!!.jsonPrimitive.int
        val payload = ByteArray(n) { ((it * 31 + 7) % 256).toByte() }
        val datagrams = lanDatagrams(lan["seq"]!!.jsonPrimitive.int.toUShort(), payload)
        assertEquals(lan["datagrams"]!!.jsonArray.map { it.jsonPrimitive.content }, datagrams.map { Encoding.hex(it) })

        val f = edge["fountain"]!!.jsonObject
        val enc = EdgeQrEncoder(f["payload"]!!.jsonPrimitive.content.toByteArray(), f["frame_size"]!!.jsonPrimitive.int.toUInt())
        val dec = EdgeQrDecoder()
        for (fr in f["frames"]!!.jsonArray.reversed()) {
            val o = fr.jsonObject
            assertEquals(o["hex"]!!.jsonPrimitive.content, Encoding.hex(enc.frame(o["seq"]!!.jsonPrimitive.long.toUInt())))
            dec.pushFrame(hex(o["hex"]!!.jsonPrimitive.content))
        }
        assertEquals(f["payload"]!!.jsonPrimitive.content, dec.result()!!.toString(Charsets.UTF_8))
        assertFalse(dec.pushText("https://example.com").accepted)
    }

    @Test
    fun audioVectorDecodes() {
        val a = edge["audio"]!!.jsonObject
        val raw = Base64.getUrlDecoder().decode(a["pcm_s16le"]!!.jsonPrimitive.content)
        val shorts = ByteBuffer.wrap(raw).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
        val pcm = FloatArray(shorts.remaining()) { shorts.get(it) / 32767f }
        assertEquals(a["pcm_payload"]!!.jsonPrimitive.content, audioDemodulate(pcm.toList())!!.toString(Charsets.UTF_8))
        val rx = EdgeAudioReceiver(48000u, 3f)
        // A live microphone keeps delivering samples; the receiver scans every 0.5 s.
        val got = (pcm.toList() + List(48000) { 0f }).chunked(4096).mapNotNull { rx.push(it) }
        assertEquals(listOf(a["pcm_payload"]!!.jsonPrimitive.content), got.map { it.toString(Charsets.UTF_8) })
    }

    @Test
    fun gossipOverChunks() {
        val topic = "@alice/doorbell"
        val now = 1_763_750_000uL
        val phone = EdgeGossipNode(false).apply { subscribe(topic) }
        val watch = EdgeGossipNode(false).apply { subscribe(topic) }
        val env = """{"id":"${newMessageId()}","time":$now,"topic":"$topic","message":"ding","hops":1}"""
        assertTrue(phone.publish(env, now))
        val toWatch = EdgeChunkReassembler()
        val toPhone = EdgeChunkReassembler()
        var queue = listOf(true to phone.summary(now))
        val delivered = mutableListOf<String>()
        var seq = 0
        while (queue.isNotEmpty()) {
            val (forWatch, msg) = queue.first()
            queue = queue.drop(1)
            val (node, reasm) = if (forWatch) watch to toWatch else phone to toPhone
            val whole = bleChunk((seq++).toUShort(), msg, 23u).mapNotNull { reasm.push(it, 0uL) }.single()
            val h = node.handle(whole, now)
            delivered += h.delivered
            queue = queue + h.replies.map { !forWatch to it }
        }
        assertEquals(1, delivered.size)
        assertEquals("ding", Json.parseToJsonElement(delivered[0]).jsonObject["message"]!!.jsonPrimitive.content)
        // One-way links carry a deliver message; the receiver dedupes it.
        assertTrue(watch.handle(edgeDeliverPayload(listOf(env)), now).dropped.single().endsWith(":duplicate"))
    }

    @Test
    fun outboxAndDeduper() {
        val outbox = CoreOutbox(1000uL, 10000uL, 3u, 10u)
        val id = newMessageId()
        val env = """{"id":"$id","topic":"@a/b","message":"queued while offline"}"""
        assertEquals("queued", outbox.enqueue(env, 0uL).result)
        assertEquals(listOf(id), outbox.poll(0uL).map { it.id })
        assertTrue(outbox.poll(10uL).isEmpty())
        val restored = CoreOutbox(1000uL, 10000uL, 3u, 10u)
        restored.restoreJson(outbox.toJson())
        assertEquals(1uL, restored.len())
        assertTrue(outbox.ack(id))
        assertTrue(outbox.isEmpty())
        val dedupe = CoreDeduper(100u)
        assertTrue(dedupe.accept(id, null, 1uL))
        assertFalse(dedupe.accept(id.lowercase(), null, 1uL))
    }
}
