package org.subetha.sample.doorbell

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
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
import org.subetha.core.AudioLink
import org.subetha.core.Core
import org.subetha.core.acceptPayload
import org.subetha.core.deliverPayload
import org.subetha.core.ffi.EdgeGossipNode
import org.subetha.core.ffi.newMessageId

data class EdgeState(
    /** libsubetha_core.so is bundled (src/main/jniLibs; see samples/android/README.md). */
    val coreAvailable: Boolean,
    val topic: String = "@me/doorbell",
    val listening: Boolean = false,
    val sending: Boolean = false,
    val heard: List<String> = emptyList(),
    val status: String = "",
)

/**
 * Data over sound between two phones, no network: "Send by sound" plays a message as a modem
 * frame (a gossip `deliver`, spec §11.1/§11.4); "Listen" decodes what the microphone hears.
 */
class EdgeViewModel : ViewModel() {
    private val _state = MutableStateFlow(EdgeState(coreAvailable = Core.available))
    val state: StateFlow<EdgeState> = _state.asStateFlow()
    private val audio = AndroidAudio()
    private var node: EdgeGossipNode? = null
    private var link: AudioLink? = null
    private var stopRecording: (() -> Unit)? = null

    private fun now() = (System.currentTimeMillis() / 1000).toULong()

    private fun ensureLink(): Pair<EdgeGossipNode, AudioLink> {
        val n = node ?: EdgeGossipNode(false).also { node = it }
        n.subscribe(_state.value.topic)
        val l = link ?: AudioLink(audio.sampleRate, play = { audio.play(it) { _state.update { s -> s.copy(sending = false) } } }, onPayload = ::onPayload)
            .also { link = it }
        return n to l
    }

    fun editTopic(topic: String) = _state.update { it.copy(topic = topic) }

    fun send(text: String) {
        if (!_state.value.coreAvailable || text.isBlank()) return
        _state.update { it.copy(sending = true, status = "Playing…") }
        viewModelScope.launch(Dispatchers.Default) {
            try {
                val (n, l) = ensureLink()
                val env = buildJsonObject {
                    put("id", newMessageId())
                    put("time", now().toLong())
                    put("topic", _state.value.topic)
                    put("message", text)
                    put("hops", 1)
                }.toString()
                n.publish(env, now())
                l.send(deliverPayload(listOf(env)))
                _state.update { it.copy(status = "Sent ${text.length} characters by sound") }
            } catch (e: Exception) {
                _state.update { it.copy(sending = false, status = "Couldn't send: ${e.message}") }
            }
        }
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

    private fun onPayload(payload: ByteArray) {
        val n = node ?: return
        val messages = acceptPayload(n, payload, now()).mapNotNull {
            (Json.parseToJsonElement(it).jsonObject["message"] as? JsonPrimitive)?.content
        }
        if (messages.isNotEmpty()) _state.update { it.copy(heard = messages + it.heard, status = "Heard a message") }
    }

    override fun onCleared() {
        stopRecording?.invoke()
    }
}
