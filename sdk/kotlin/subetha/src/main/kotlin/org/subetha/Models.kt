package org.subetha

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull

/**
 * A message envelope (spec §2) as JSON, with typed accessors for the common fields. Unknown
 * and extension fields are kept in [json], so nothing is lost when re-sending or verifying.
 */
public class Message(public val json: JsonObject) {
    public val id: String? get() = str("id")
    public val time: Long? get() = (json["time"] as? JsonPrimitive)?.longOrNull
    public val topic: String get() = str("topic") ?: ""
    public val message: String? get() = str("message")
    public val title: String? get() = str("title")
    /** 1–5; absent means 3. */
    public val priority: Int get() = (json["priority"] as? JsonPrimitive)?.intOrNull ?: 3
    public val tags: List<String> get() = (json["tags"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content } ?: emptyList()
    public val click: String? get() = str("click")
    public val expires: Long? get() = (json["expires"] as? JsonPrimitive)?.longOrNull
    /** `message` for messages; `open` / `keepalive` for stream control events. */
    public val event: String? get() = str("event")
    /** Signing device id, if signed. */
    public val sender: String? get() = str("sender")
    public val isSigned: Boolean get() = json["sig"] != null
    /** Still encrypted (no topic key configured, or the wrong one). */
    public val isEncrypted: Boolean get() = json["enc"] != null

    public operator fun get(key: String): JsonElement? = json[key]

    public fun toJson(): String = json.toString()

    private fun str(k: String): String? = (json[k] as? JsonPrimitive)?.takeIf { it.isString }?.content

    override fun equals(other: Any?): Boolean = other is Message && other.json == json
    override fun hashCode(): Int = json.hashCode()
    override fun toString(): String = "Message(${toJson()})"

    public companion object {
        @JvmStatic
        public fun parse(text: String): Message = Message(json.parseToJsonElement(text) as JsonObject)
    }
}

/** Route modes (spec §7). */
public enum class RouteMode(public val wire: String) { ANY("any"), FAST("fast"), ALL("all"), CHEAP("cheap") }

/** Per-message routing (spec §2 `route`). Transports are names such as `ws`, `webpush`, `sms`. */
public data class Route(
    val mode: RouteMode? = null,
    /** Worst-case spend for this message, in US dollars. */
    val maxCostUsd: Double? = null,
    val deny: List<String> = emptyList(),
    val allow: List<String> = emptyList(),
    val deadlineS: Int? = null,
)

public data class PublishOptions(
    val title: String? = null,
    /** 1 (min) … 5 (max). */
    val priority: Int? = null,
    val tags: List<String> = emptyList(),
    val click: String? = null,
    val icon: String? = null,
    /** Unix seconds. */
    val expires: Long? = null,
    val hops: Int? = null,
    val route: Route? = null,
    val idempotencyKey: String? = null,
    /** Sign with the client's device signer. Default: sign when a signer is configured. */
    val sign: Boolean? = null,
    /** Encrypt with the topic key. Default: encrypt when a key for the topic is configured. */
    val encrypt: Boolean? = null,
    /** Extension fields merged into the envelope (spec §2.2). */
    val extra: Map<String, JsonElement> = emptyMap(),
) {
    init {
        require(priority == null || priority in 1..5) { "priority must be 1..5" }
    }
}

/** Dry-run result: route plan and worst-case cost; nothing was delivered. */
public class Estimate(public val json: JsonObject) {
    public val estimateUsdMicros: Long get() = (json["estimate_usd_micros"] as? JsonPrimitive)?.longOrNull ?: 0
    public val estimateUsd: Double get() = estimateUsdMicros / 1e6
    /** One entry per planned delivery step (transport, cost, latency, …). */
    public val plan: List<JsonObject> get() = (json["plan"] as? JsonArray)?.filterIsInstance<JsonObject>() ?: emptyList()
    public val message: Message? get() = (json["message"] as? JsonObject)?.let(::Message)
    override fun toString(): String = "Estimate($json)"
}

public enum class SubscribeTransport { STREAM, POLL }

public data class SubscribeOptions(
    /** `all`, a duration like `10m`, a unix time, or a message id. Default: new messages only. */
    val since: String? = null,
    val priority: List<Int> = emptyList(),
    val tags: List<String> = emptyList(),
    val transport: SubscribeTransport = SubscribeTransport.STREAM,
    val pollIntervalMs: Long = 5_000,
    /** Ack each message after the collector has handled it (stops escalation). */
    val autoAck: Boolean = true,
    /** Drop messages whose signature fails (needs an [EnvelopeCrypto]). */
    val verify: Boolean = false,
    /** Also drop unsigned messages. */
    val requireSignature: Boolean = false,
    /** Pass envelopes through as received (no E2EE decryption), e.g. to forward them. */
    val raw: Boolean = false,
    val initialBackoffMs: Long = 500,
    val maxBackoffMs: Long = 30_000,
    /** Called each time the stream (re)connects. */
    val onOpen: (() -> Unit)? = null,
    /** Called with each error that triggers a reconnect. */
    val onError: ((Throwable) -> Unit)? = null,
)

/** Device-code enrollment (RFC 8628-style), from `POST /v1/device/code`. */
public data class DeviceCode(
    val deviceCode: String,
    val userCode: String,
    val verificationUri: String,
    val verificationUriComplete: String,
    val expiresInS: Long,
    val intervalS: Long,
)

/** A running callback subscription. */
public interface Subscription {
    public val isClosed: Boolean
    public fun close()
}

public fun interface MessageListener {
    public fun onMessage(message: Message)
}
