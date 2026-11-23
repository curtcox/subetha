package us.subetha.sample.doorbell

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import us.subetha.Message
import us.subetha.PublishOptions
import us.subetha.Route
import us.subetha.RouteMode
import us.subetha.SubEtha
import us.subetha.SubEthaException
import us.subetha.SubscribeOptions

data class DoorbellState(
    val token: String = "",
    val topic: String = "@me/doorbell",
    val baseUrl: String = SubEtha.DEFAULT_BASE_URL,
    val connected: Boolean = false,
    val status: String = "Not connected",
    val inbox: List<Message> = emptyList(),
    val estimate: String? = null,
    val busy: Boolean = false,
)

/** The scripted doorbell flow: connect, subscribe, inbox, ring, dry-run cost. */
class DoorbellViewModel : ViewModel() {
    private val _state = MutableStateFlow(DoorbellState())
    val state: StateFlow<DoorbellState> = _state.asStateFlow()
    private var client: SubEtha? = null

    /** The connected client, for the Edge tab's relay bridge. */
    val connectedClient: SubEtha? get() = client.takeIf { _state.value.connected }
    private var subscription: Job? = null

    fun edit(token: String? = null, topic: String? = null, baseUrl: String? = null) = _state.update {
        it.copy(token = token ?: it.token, topic = topic ?: it.topic, baseUrl = baseUrl ?: it.baseUrl)
    }

    fun connect() {
        val s = _state.value
        val c = SubEtha(baseUrl = s.baseUrl, token = s.token.trim())
        client = c
        subscription?.cancel()
        _state.update { it.copy(connected = true, status = "Connecting…", inbox = emptyList(), estimate = null) }
        subscription = viewModelScope.launch {
            c.subscribe(
                s.topic,
                SubscribeOptions(
                    since = "1h",
                    onOpen = { _state.update { it.copy(status = "Subscribed to ${s.topic}") } },
                    onError = { e -> _state.update { it.copy(status = "Reconnecting: ${e.message}") } },
                ),
            )
                .catch { e -> _state.update { it.copy(status = describe(e), connected = false) } }
                .collect { m -> _state.update { it.copy(inbox = listOf(m) + it.inbox.take(99)) } }
        }
    }

    fun disconnect() {
        subscription?.cancel()
        _state.update { it.copy(connected = false, status = "Not connected") }
    }

    fun ring() = launchAction {
        client!!.publish(_state.value.topic, "ding", PublishOptions(title = "Doorbell", tags = listOf("bell")))
    }

    fun estimate() = launchAction {
        val e = client!!.estimate(_state.value.topic, "ding", PublishOptions(title = "Doorbell", route = Route(RouteMode.ALL)))
        val plan = e.plan.joinToString("\n") { step -> step.entries.joinToString(", ") { (k, v) -> "$k=$v" } }
        _state.update { it.copy(estimate = "Worst case \$${"%.6f".format(e.estimateUsd)}\n$plan") }
    }

    private fun launchAction(block: suspend () -> Unit) {
        viewModelScope.launch {
            _state.update { it.copy(busy = true) }
            try {
                block()
            } catch (e: Exception) {
                _state.update { it.copy(status = describe(e)) }
            } finally {
                _state.update { it.copy(busy = false) }
            }
        }
    }

    private fun describe(e: Throwable): String = when (e) {
        is SubEthaException -> "${e.code} (HTTP ${e.status})"
        else -> e.message ?: e.toString()
    }
}
