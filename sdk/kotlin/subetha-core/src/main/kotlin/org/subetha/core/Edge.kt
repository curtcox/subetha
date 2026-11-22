package org.subetha.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import org.subetha.SubEtha
import org.subetha.SubscribeOptions
import org.subetha.core.ffi.EdgeAudioReceiver
import org.subetha.core.ffi.EdgeChunkReassembler
import org.subetha.core.ffi.EdgeGossipNode
import org.subetha.core.ffi.EdgeQrDecoder
import org.subetha.core.ffi.EdgeQrEncoder
import org.subetha.core.ffi.EdgeQrProgress
import org.subetha.core.ffi.FfiException
import org.subetha.core.ffi.audioModulate
import org.subetha.core.ffi.audioResample
import org.subetha.core.ffi.bleChunk
import org.subetha.core.ffi.edgeDeliverPayload

// Platform-independent drivers for edge transports (spec §11), mirroring sdk/js/src/edge/links.ts
// and bridge.ts. Platform shims (Android BluetoothGatt, AudioTrack/AudioRecord, CameraX) only
// move bytes and samples in and out; these classes do the rest.

private val json = Json { ignoreUnknownKeys = true }
private fun nowSecs(): ULong = (System.currentTimeMillis() / 1000).toULong()

/** The payload one-way links (audio, QR) carry for a set of envelopes: a gossip `deliver`. */
public fun deliverPayload(envelopesJson: List<String>): ByteArray = edgeDeliverPayload(envelopesJson)

/** Hands a payload from a one-way link to [node]; returns the new envelopes (JSON) for the app. */
public fun acceptPayload(node: EdgeGossipNode, payload: ByteArray, now: ULong = nowSecs()): List<String> {
    if (gossipType(payload)?.first != "deliver") return emptyList()
    return try { node.handle(payload, now).delivered } catch (_: FfiException) { emptyList() }
}

/** The gossip message's `type` and, for `deliver`, how many envelopes it carries. */
private fun gossipType(bytes: ByteArray): Pair<String, Int>? = try {
    val o = json.parseToJsonElement(bytes.decodeToString()) as? JsonObject
    val type = (o?.get("type") as? JsonPrimitive)?.content
    type?.let { it to ((o["envelopes"] as? JsonArray)?.size ?: 0) }
} catch (_: Exception) {
    null
}

/**
 * One gossip conversation with a peer (spec §11.4) over any two-way link: send our summary with
 * [resync], feed whatever the peer sends to [receive]. New envelopes go to [onMessage] as JSON.
 */
public class GossipSession(
    private val node: EdgeGossipNode,
    private val send: (ByteArray) -> Unit,
    private val onMessage: (String) -> Unit,
    private val clock: () -> ULong = ::nowSecs,
) {
    /** Sends our summary (on connect, and after publishing). */
    public fun resync() {
        send(node.summary(clock()))
    }

    /** Handles one gossip message from the peer. Malformed messages are dropped. */
    public fun receive(bytes: ByteArray) {
        val (type, count) = gossipType(bytes) ?: return
        val h = try { node.handle(bytes, clock()) } catch (_: FfiException) { return }
        h.delivered.forEach(onMessage)
        h.replies.forEach(send)
        // We hold something new: advertise it (the peer may also hold more for us).
        if (type == "deliver" && h.dropped.size < count) resync()
    }
}

/**
 * A gossip session over a BLE connection (spec §11.3): chunks outgoing messages for [write]
 * (a characteristic write or notification) and reassembles incoming chunks. Works on either
 * side, central or peripheral. [attMtu] is the negotiated ATT MTU.
 */
public class BleLink @JvmOverloads constructor(
    node: EdgeGossipNode,
    private val write: (ByteArray) -> Unit,
    onMessage: (String) -> Unit,
    @Volatile public var attMtu: Int = DEFAULT_ATT_MTU,
    private val clockMs: () -> Long = System::currentTimeMillis,
) {
    private var seq = 0
    private val reassembler = EdgeChunkReassembler()
    private val session = GossipSession(node, ::sendMessage, onMessage) { (clockMs() / 1000).toULong() }

    private fun sendMessage(bytes: ByteArray) {
        val s: Int
        synchronized(this) { s = seq; seq = (seq + 1) and 0xffff }
        for (c in bleChunk(s.toUShort(), bytes, attMtu.toUInt())) write(c)
    }

    /** Feeds one notification or write from the peer. Bad chunks are dropped. */
    public fun receive(chunk: ByteArray) {
        val now = clockMs().toULong()
        val msg = try { reassembler.push(chunk, now) } catch (_: FfiException) { return }
        reassembler.prune(now, REASSEMBLY_TIMEOUT_MS)
        if (msg != null) session.receive(msg)
    }

    /** Sends our summary (on connect, and after publishing). */
    public fun resync(): Unit = session.resync()

    public companion object {
        public const val DEFAULT_ATT_MTU: Int = 23
        private const val REASSEMBLY_TIMEOUT_MS: ULong = 30_000u
    }
}

/**
 * Data over sound (spec §11.1) at the device's sample rate. [send] plays a payload through
 * [play]; feed microphone buffers to [onSamples] and decoded payloads arrive at [onPayload].
 * Payloads are short (about 50 bytes/s): use [deliverPayload] / [acceptPayload] for envelopes.
 */
public class AudioLink @JvmOverloads constructor(
    private val sampleRate: Int,
    private val play: (FloatArray) -> Unit,
    private val onPayload: (ByteArray) -> Unit,
    windowSeconds: Float = 6f,
) {
    private val receiver = EdgeAudioReceiver(sampleRate.toUInt(), windowSeconds)

    /** The samples for [payload] at this link's sample rate, without playing them. */
    public fun samples(payload: ByteArray): FloatArray {
        val s = audioModulate(payload)
        return (if (sampleRate == MODEM_RATE) s else audioResample(s, MODEM_RATE.toUInt(), sampleRate.toUInt())).toFloatArray()
    }

    public fun send(payload: ByteArray): Unit = play(samples(payload))

    /** Feeds microphone samples (mono, -1..1, at the link's sample rate). */
    public fun onSamples(samples: FloatArray) {
        receiver.push(samples.toList())?.let(onPayload)
    }

    public companion object {
        public const val MODEM_RATE: Int = 48_000
    }
}

/**
 * Animated-QR sender (spec §11.2): an endless stream of fountain-coded frames for [payload],
 * as base45 text for alphanumeric QR codes. Show `text(0)`, `text(1)`, … one after another
 * (5–10 a second); a receiver needs about 1.1–1.5 × [sourceBlocks] of them, in any order.
 */
public class QrSender @JvmOverloads constructor(payload: ByteArray, frameSize: Int = DEFAULT_FRAME_SIZE) {
    private val encoder = EdgeQrEncoder(payload, frameSize.toUInt())

    /** How many frames carry the payload's blocks directly. */
    public val sourceBlocks: Int get() = encoder.sourceBlocks().toInt()

    /** Frame [seq] as base45 text. */
    public fun text(seq: Int): String = encoder.frameText(seq.toUInt())

    public companion object {
        /** Fills a version 12 QR code at error correction L (535 alphanumeric characters). */
        public const val DEFAULT_FRAME_SIZE: Int = 356

        /** The frame size that fills a QR code holding [alphanumericChars] characters. */
        public fun frameSizeFor(alphanumericChars: Int): Int = alphanumericChars / 3 * 2 + if (alphanumericChars % 3 == 2) 1 else 0
    }
}

/**
 * Collects scanned QR strings into a payload. Other QR codes are ignored, and a new transfer
 * replaces an unfinished one. [onPayload] gets each completed payload once (use
 * [acceptPayload] for envelopes). Feed it from one thread.
 */
public class QrReceiver(private val onPayload: (ByteArray) -> Unit) {
    private val decoder = EdgeQrDecoder()
    private var last: ByteArray? = null

    /** Feeds one scanned string; returns progress, or null if it wasn't a SubEtha frame. */
    public fun push(text: String): EdgeQrProgress? {
        val p = decoder.pushText(text)
        if (!p.accepted) return null
        if (p.complete) {
            val result = decoder.result()
            if (result != null && !result.contentEquals(last)) {
                last = result
                onPayload(result)
            }
        }
        return p
    }
}

/**
 * Edge ↔ relay bridge (PLAN §3: a phone with internet is a gateway for nearby offline devices).
 * Relay messages on [topics] enter [node] (given [hops] if they carry none) so edge peers pick
 * them up; call [uplink] from your links' onMessage to publish edge messages to the relay
 * unchanged. Uplinked publishes are billed to the client's credentials like any other.
 */
public class EdgeBridge @JvmOverloads constructor(
    private val client: SubEtha,
    private val node: EdgeGossipNode,
    topics: List<String>,
    scope: CoroutineScope,
    private val hops: Int = 1,
    downlink: Boolean = true,
    private val uplinkEnabled: Boolean = true,
    since: String? = null,
    /** Called after a relay message enters the node; resync your links here. */
    private val onDownlink: ((String) -> Unit)? = null,
    private val onError: ((Throwable) -> Unit)? = null,
) {
    private val topics = topics.toSet()
    private val uplinked = LinkedHashSet<String>()
    private val job: Job?

    init {
        // Subscribed, not just relayable, so edge messages on these topics reach onMessage.
        for (t in this.topics) node.subscribe(t)
        job = if (!downlink) null else client.subscribe(topics, SubscribeOptions(since = since, raw = true, onError = onError))
            .onEach { m ->
                var env = JsonObject(m.json - "event")
                if (((env["hops"] as? JsonPrimitive)?.intOrNull ?: 0) <= 0) env = JsonObject(env + ("hops" to JsonPrimitive(hops)))
                val text = env.toString()
                val fresh = try { env["id"] != null && node.publish(text, nowSecs()) } catch (_: FfiException) { false }
                if (fresh) onDownlink?.invoke(text)
            }
            .catch { onError?.invoke(it) }
            .launchIn(scope)
    }

    /** Publishes a message that arrived over an edge link. Returns true if it was published. */
    public suspend fun uplink(envelopeJson: String): Boolean {
        if (!uplinkEnabled) return false
        val env = try { json.parseToJsonElement(envelopeJson) as? JsonObject } catch (_: Exception) { null } ?: return false
        val topic = (env["topic"] as? JsonPrimitive)?.content
        val id = (env["id"] as? JsonPrimitive)?.content?.uppercase() ?: return false
        synchronized(uplinked) {
            if (topic !in topics || !uplinked.add(id)) return false
            if (uplinked.size > 10_000) uplinked.remove(uplinked.first())
        }
        return try {
            client.publishEnvelope(env)
            true
        } catch (e: Exception) {
            synchronized(uplinked) { uplinked.remove(id) }
            onError?.invoke(e)
            false
        }
    }

    public fun close() {
        job?.cancel()
    }
}
