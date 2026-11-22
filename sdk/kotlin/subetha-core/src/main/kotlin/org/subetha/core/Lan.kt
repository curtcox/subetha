package org.subetha.core

import java.io.Closeable
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.MulticastSocket
import java.net.NetworkInterface
import java.net.SocketException
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import org.subetha.core.ffi.EdgeChunkReassembler
import org.subetha.core.ffi.EdgeGossipNode
import org.subetha.core.ffi.FfiException
import org.subetha.core.ffi.lanBeacon
import org.subetha.core.ffi.lanDatagrams
import org.subetha.core.ffi.lanNewNodeId
import org.subetha.core.ffi.lanParseBeacon

// LAN discovery and gossip (spec §11.5), mirroring sdk/js/src/edge/lan.ts and lan-socket.ts.
// Peers multicast a beacon (node id + unicast port) every few seconds and gossip over unicast
// UDP, each gossip message split into datagrams with the BLE chunk framing.

/**
 * LAN gossip without sockets: known peers, per-peer reassembly, and the gossip exchange. Feed
 * it multicast datagrams ([onBeacon]) and unicast ones ([onDatagram]); it sends through
 * [send]. [LanNode] wires it to java.net sockets. Thread-safe.
 */
public class LanGossip @JvmOverloads constructor(
    private val node: EdgeGossipNode,
    /** Our unicast port, announced in beacons. */
    public val port: Int,
    private val send: (host: String, port: Int, datagram: ByteArray) -> Unit,
    private val onMessage: (String) -> Unit,
    public val nodeId: String = lanNewNodeId(),
    private val clockMs: () -> Long = System::currentTimeMillis,
) {
    private class Peer(val host: String, val port: Int, var seen: Long) {
        val reassembler = EdgeChunkReassembler()
    }

    private val peers = LinkedHashMap<String, Peer>()
    private var seq = 0

    /** The beacon to multicast every few seconds. */
    public fun beacon(): ByteArray = lanBeacon(nodeId, port.toUShort())

    public val peerCount: Int get() = synchronized(this) { peers.size }

    private fun sendTo(p: Peer, message: ByteArray) {
        val s: Int
        synchronized(this) { s = seq; seq = (seq + 1) and 0xffff }
        val datagrams = try { lanDatagrams(s.toUShort(), message) } catch (_: FfiException) { return }
        for (d in datagrams) send(p.host, p.port, d)
    }

    private fun expire() {
        val t = clockMs()
        synchronized(this) { peers.values.removeAll { t - it.seen > PEER_TIMEOUT_MS } }
    }

    private fun summary(): ByteArray = node.summary((clockMs() / 1000).toULong())

    /** Handles a multicast datagram. A newly seen peer gets our summary. */
    public fun onBeacon(bytes: ByteArray, fromHost: String) {
        val b = lanParseBeacon(bytes) ?: return
        if (b.node == nodeId) return
        expire()
        val key = "$fromHost:${b.port}"
        val fresh: Peer
        synchronized(this) {
            val known = peers[key]
            if (known != null) {
                known.seen = clockMs()
                return
            }
            fresh = Peer(fromHost, b.port.toInt(), clockMs())
            peers[key] = fresh
        }
        sendTo(fresh, summary())
    }

    /** Handles a unicast datagram. Unknown senders are answered too (beacons can be lost). */
    public fun onDatagram(bytes: ByteArray, fromHost: String, fromPort: Int) {
        val key = "$fromHost:$fromPort"
        val p: Peer
        val isNew: Boolean
        synchronized(this) {
            val known = peers[key]
            isNew = known == null
            p = known ?: Peer(fromHost, fromPort, clockMs()).also { peers[key] = it }
        }
        val now = clockMs().toULong()
        val message = synchronized(p) {
            val m = try { p.reassembler.push(bytes, now) } catch (_: FfiException) { return }
            p.reassembler.prune(now, REASSEMBLY_TIMEOUT_MS)
            m
        } ?: return
        val (type, count) = gossipType(message) ?: return
        val h = try { node.handle(message, now / 1000u) } catch (_: FfiException) { return }
        h.delivered.forEach(onMessage)
        h.replies.forEach { sendTo(p, it) }
        // A peer we hadn't heard a beacon from yet: offer what we hold right away.
        if (isNew) sendTo(p, summary())
        // Something new arrived: tell every peer (they may want it), including this one.
        if (type == "deliver" && h.dropped.size < count) resync()
    }

    /** Sends our summary to every known peer (after publishing). */
    public fun resync() {
        expire()
        val s = summary()
        val all = synchronized(this) { peers.values.toList() }
        all.forEach { sendTo(it, s) }
    }

    public companion object {
        public const val GROUP: String = "239.255.83.69"
        public const val PORT: Int = 47353
        public const val PEER_TIMEOUT_MS: Long = 30_000
        private const val REASSEMBLY_TIMEOUT_MS: ULong = 10_000u
    }
}

/**
 * LAN gossip over java.net UDP sockets, for the JVM and Android: joins [group]:[port], beacons
 * every [beaconMs], and gossips with the peers it hears until [close]d. On Android, hold a
 * `WifiManager.MulticastLock` while it runs (most devices drop multicast otherwise) and declare
 * `CHANGE_WIFI_MULTICAST_STATE`. Call [resync] after publishing to [node].
 */
public class LanNode @JvmOverloads constructor(
    node: EdgeGossipNode,
    onMessage: (String) -> Unit,
    private val group: String = LanGossip.GROUP,
    private val port: Int = LanGossip.PORT,
    /** The interface to multicast on (default: the system's choice). */
    networkInterface: NetworkInterface? = null,
    beaconMs: Long = 5_000,
    ttl: Int = 1,
    nodeId: String = lanNewNodeId(),
) : Closeable {
    private val unicast = DatagramSocket(0)
    private val multicast = MulticastSocket(null)
    private val groupAddress = InetAddress.getByName(group)
    private val gossip: LanGossip
    private val timer: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "subetha-lan-beacon").apply { isDaemon = true }
    }
    @Volatile private var closed = false

    public val nodeId: String get() = gossip.nodeId
    public val unicastPort: Int get() = unicast.localPort
    public val peerCount: Int get() = gossip.peerCount

    init {
        gossip = LanGossip(node, unicast.localPort, ::sendUnicast, onMessage, nodeId)
        try {
            multicast.reuseAddress = true
            multicast.bind(InetSocketAddress(port))
            multicast.timeToLive = ttl
            if (networkInterface != null) multicast.networkInterface = networkInterface
            @Suppress("DEPRECATION")
            multicast.loopbackMode = false // false *enables* loopback: peers on this host find each other
            multicast.joinGroup(InetSocketAddress(groupAddress, port), networkInterface)
        } catch (e: Exception) {
            unicast.close()
            multicast.close()
            throw e
        }
        receiveLoop("subetha-lan-unicast", unicast) { p -> gossip.onDatagram(p.data.copyOfRange(p.offset, p.offset + p.length), p.address.hostAddress, p.port) }
        receiveLoop("subetha-lan-multicast", multicast) { p -> gossip.onBeacon(p.data.copyOfRange(p.offset, p.offset + p.length), p.address.hostAddress) }
        timer.scheduleWithFixedDelay(::announce, 0, beaconMs, TimeUnit.MILLISECONDS)
    }

    private fun sendUnicast(host: String, toPort: Int, datagram: ByteArray) {
        try {
            unicast.send(DatagramPacket(datagram, datagram.size, InetAddress.getByName(host), toPort))
        } catch (_: Exception) {
            // the peer went away or the network changed; gossip recovers on the next beacon
        }
    }

    private fun announce() {
        val b = gossip.beacon()
        try {
            multicast.send(DatagramPacket(b, b.size, groupAddress, port))
        } catch (_: Exception) {
            // no route yet (Wi-Fi just dropped); the next beacon retries
        }
    }

    private fun receiveLoop(name: String, socket: DatagramSocket, handle: (DatagramPacket) -> Unit) {
        Thread({
            val buf = ByteArray(65_535)
            while (!closed) {
                val p = DatagramPacket(buf, buf.size)
                try {
                    socket.receive(p)
                } catch (_: SocketException) {
                    break // closed
                } catch (_: Exception) {
                    continue
                }
                try {
                    handle(p)
                } catch (_: Exception) {
                    // a bad datagram or a failing onMessage must not stop the loop
                }
            }
        }, name).apply { isDaemon = true }.start()
    }

    /** Sends our summary to every known peer (after publishing). */
    public fun resync(): Unit = gossip.resync()

    override fun close() {
        if (closed) return
        closed = true
        timer.shutdownNow()
        try { multicast.leaveGroup(InetSocketAddress(groupAddress, port), null) } catch (_: Exception) {}
        multicast.close()
        unicast.close()
    }
}
