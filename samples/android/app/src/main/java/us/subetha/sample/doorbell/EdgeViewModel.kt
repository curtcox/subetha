package us.subetha.sample.doorbell

import android.app.Application
import android.content.Context
import android.net.wifi.WifiManager
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import us.subetha.SubEtha
import us.subetha.core.AudioLink
import us.subetha.core.Core
import us.subetha.core.EdgeBridge
import us.subetha.core.LanNode
import us.subetha.core.QrReceiver
import us.subetha.core.QrSender
import us.subetha.core.acceptPayload
import us.subetha.core.deliverPayload
import us.subetha.core.ffi.EdgeGossipNode
import us.subetha.core.ffi.newMessageId

data class EdgeState(
    /** libsubetha_core.so is bundled (src/main/jniLibs; see samples/android/README.md). */
    val coreAvailable: Boolean,
    val topic: String = "@me/doorbell",
    val listening: Boolean = false,
    val sending: Boolean = false,
    val bluetooth: Boolean = false,
    val bluetoothPeers: Int = 0,
    val lan: Boolean = false,
    val lanPeers: Int = 0,
    val bridging: Boolean = false,
    /** The animated QR code being shown, if any. */
    val qr: QrSender? = null,
    val scanning: Boolean = false,
    val heard: List<String> = emptyList(),
    val status: String = "",
)

/**
 * Edge transports between phones, no network. One gossip node holds what this phone has seen:
 * - Sound: "Send by sound" plays a message as a modem frame (a gossip `deliver`, spec
 *   §11.1/§11.4); "Listen" decodes what the microphone hears.
 * - QR: "Show as QR" animates a message as fountain-coded QR frames (spec §11.2); "Scan QR"
 *   decodes them from the camera.
 * - Bluetooth: [AndroidBle] connects to nearby phones (and Web Bluetooth pages) and gossips
 *   (spec §11.3/§11.4), so messages hop between phones in range.
 * - LAN: [LanNode] finds phones on the same Wi-Fi by UDP multicast and gossips with them
 *   (spec §11.5), holding a multicast lock while it runs.
 * - Bridge: with the Doorbell tab connected, relay messages on the topic enter the node (and
 *   reach Bluetooth peers), and messages heard over the edge are published to the relay. One
 *   online phone is then the gateway for offline phones nearby (PLAN §3).
 */
class EdgeViewModel(app: Application) : AndroidViewModel(app) {
    private val _state = MutableStateFlow(EdgeState(coreAvailable = Core.available))
    val state: StateFlow<EdgeState> = _state.asStateFlow()
    private val audio = AndroidAudio()
    private var node: EdgeGossipNode? = null
    private var link: AudioLink? = null
    private var stopRecording: (() -> Unit)? = null
    private var ble: AndroidBle? = null
    private var bridge: EdgeBridge? = null
    private var lan: LanNode? = null
    private var lanLock: WifiManager.MulticastLock? = null
    private var lanPeerJob: Job? = null
    private val qrReceiver by lazy { QrReceiver { payload -> node?.let { n -> acceptPayload(n, payload, now()).forEach { onEnvelope(it, "QR") } } } }

    private fun now() = (System.currentTimeMillis() / 1000).toULong()

    private fun ensureNode(): EdgeGossipNode {
        val n = node ?: EdgeGossipNode(false).also { node = it }
        n.subscribe(_state.value.topic)
        return n
    }

    private fun ensureLink(): Pair<EdgeGossipNode, AudioLink> {
        val n = ensureNode()
        val l = link ?: AudioLink(audio.sampleRate, play = { audio.play(it) { _state.update { s -> s.copy(sending = false) } } }, onPayload = ::onPayload)
            .also { link = it }
        return n to l
    }

    fun editTopic(topic: String) = _state.update { it.copy(topic = topic) }

    /** A new envelope for [text], also held by the node (so Bluetooth peers get it) and uplinked. */
    private suspend fun publishLocally(text: String): String {
        val env = buildJsonObject {
            put("id", newMessageId())
            put("time", now().toLong())
            put("topic", _state.value.topic)
            put("message", text)
            put("hops", 1)
        }.toString()
        ensureNode().publish(env, now())
        resyncLinks()
        bridge?.uplink(env)
        return env
    }

    fun send(text: String) {
        if (!_state.value.coreAvailable || text.isBlank()) return
        _state.update { it.copy(sending = true, status = "Playing…") }
        viewModelScope.launch(Dispatchers.Default) {
            try {
                val (_, l) = ensureLink()
                val env = publishLocally(text)
                l.send(deliverPayload(listOf(env)))
                _state.update { it.copy(status = "Sent ${text.length} characters by sound" + if (ble != null) " and Bluetooth" else "") }
            } catch (e: Exception) {
                _state.update { it.copy(sending = false, status = "Couldn't send: ${e.message}") }
            }
        }
    }

    /** Shows [text] as an animated QR code, or hides the one showing. */
    fun toggleQr(text: String) {
        if (!_state.value.coreAvailable) return
        if (_state.value.qr != null) {
            _state.update { it.copy(qr = null) }
            return
        }
        if (text.isBlank()) return
        viewModelScope.launch(Dispatchers.Default) {
            try {
                val sender = QrSender(deliverPayload(listOf(publishLocally(text))))
                _state.update { it.copy(qr = sender, status = "Showing ${sender.sourceBlocks} block(s) as QR frames") }
            } catch (e: Exception) {
                _state.update { it.copy(status = "Couldn't make QR frames: ${e.message}") }
            }
        }
    }

    /** Starts or stops the camera. The UI asks for CAMERA first. */
    fun toggleScanning() {
        if (!_state.value.coreAvailable) return
        ensureNode()
        _state.update { it.copy(scanning = !it.scanning, status = if (it.scanning) "Stopped scanning" else "Point the camera at an animated QR code") }
    }

    /** One decoded QR string, from the scanner's thread. */
    fun onQrText(text: String) {
        val p = qrReceiver.push(text) ?: return
        if (!p.complete) _state.update { it.copy(status = "QR: ${p.known} of ${p.total} blocks") }
    }

    /** Starts or stops listening. The UI asks for RECORD_AUDIO first. */
    fun toggleListening() {
        if (!_state.value.coreAvailable) return
        val stop = stopRecording
        if (stop != null) {
            stop()
            stopRecording = null
            _state.update { it.copy(listening = false, status = "Stopped listening") }
            return
        }
        val (_, l) = ensureLink()
        stopRecording = audio.record { l.onSamples(it) }
        _state.update { it.copy(listening = true, status = "Listening…") }
    }

    /** Starts or stops Bluetooth. The UI asks for the Bluetooth permissions first. */
    fun toggleBluetooth() {
        if (!_state.value.coreAvailable) return
        ble?.let {
            it.close()
            ble = null
            _state.update { s -> s.copy(bluetooth = false, bluetoothPeers = 0, status = "Bluetooth off") }
            return
        }
        val b = AndroidBle(getApplication(), ensureNode(), onMessage = { onEnvelope(it, "Bluetooth") }) { status ->
            _state.update { it.copy(status = status, bluetoothPeers = ble?.peerCount ?: 0) }
        }
        if (!b.start()) {
            b.close()
            _state.update { it.copy(status = "Turn Bluetooth on first") }
            return
        }
        ble = b
        _state.update { it.copy(bluetooth = true) }
    }

    /**
     * Starts or stops bridging the topic between the relay ([client], from the Doorbell tab) and
     * the edge. Uplinked messages are billed to that token like any other publish.
     */
    fun toggleBridge(client: SubEtha?) {
        if (!_state.value.coreAvailable) return
        bridge?.let {
            it.close()
            bridge = null
            _state.update { s -> s.copy(bridging = false, status = "Bridge off") }
            return
        }
        if (client == null) {
            _state.update { it.copy(status = "Connect on the Doorbell tab first") }
            return
        }
        bridge = EdgeBridge(
            client,
            ensureNode(),
            listOf(_state.value.topic),
            viewModelScope,
            since = "10m",
            onDownlink = { env ->
                resyncLinks()
                text(env)?.let { m -> _state.update { it.copy(heard = listOf("relay: $m") + it.heard.take(99)) } }
            },
            onError = { e -> _state.update { it.copy(status = "Bridge: ${e.message}") } },
        )
        _state.update { it.copy(bridging = true, status = "Bridging ${_state.value.topic} to the relay") }
    }

    private fun onPayload(payload: ByteArray) {
        val n = node ?: return
        acceptPayload(n, payload, now()).forEach { onEnvelope(it, "sound") }
    }

    /** A new envelope from an edge link: show it, pass it on to Bluetooth peers, and uplink it. */
    private fun onEnvelope(env: String, via: String) {
        text(env)?.let { m -> _state.update { it.copy(heard = listOf("$via: $m") + it.heard.take(99), status = "Heard a message by $via") } }
        resyncLinks() // the sender already knows; other peers may not (multi-hop)
        bridge?.let { b -> viewModelScope.launch { b.uplink(env) } }
    }

    private fun text(env: String): String? = try {
        (Json.parseToJsonElement(env).jsonObject["message"] as? JsonPrimitive)?.content
    } catch (_: Exception) {
        null
    }

    /** Tells Bluetooth and LAN peers what the node holds (LAN sends off the main thread). */
    private fun resyncLinks() {
        ble?.resyncAll()
        lan?.let { l -> viewModelScope.launch(Dispatchers.IO) { l.resync() } }
    }

    /** Joins or leaves the LAN (UDP multicast on the current Wi-Fi network). */
    fun toggleLan() {
        if (!_state.value.coreAvailable) return
        lan?.let {
            stopLan()
            _state.update { s -> s.copy(lan = false, lanPeers = 0, status = "Left the LAN") }
            return
        }
        val n = ensureNode()
        viewModelScope.launch(Dispatchers.IO) {
            // Most phones drop multicast unless an app holds this lock.
            val wifi = getApplication<Application>().applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            val lock = wifi.createMulticastLock("subetha-lan").apply { setReferenceCounted(false); acquire() }
            try {
                val l = LanNode(n, onMessage = { onEnvelope(it, "LAN") })
                lan = l
                lanLock = lock
                lanPeerJob = viewModelScope.launch {
                    while (isActive) {
                        _state.update { it.copy(lanPeers = lan?.peerCount ?: 0) }
                        delay(2_000)
                    }
                }
                _state.update { it.copy(lan = true, status = "On the LAN as ${l.nodeId} (UDP ${l.unicastPort})") }
            } catch (e: Exception) {
                lock.release()
                _state.update { it.copy(status = "Couldn't join the LAN: ${e.message}") }
            }
        }
    }

    private fun stopLan() {
        lanPeerJob?.cancel()
        lanPeerJob = null
        lan?.close()
        lan = null
        lanLock?.let { if (it.isHeld) it.release() }
        lanLock = null
    }

    override fun onCleared() {
        stopRecording?.invoke()
        stopLan()
        ble?.close()
        bridge?.close()
    }
}
