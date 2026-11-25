package us.subetha

import java.io.IOException
import java.net.URLEncoder
import kotlin.concurrent.thread
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.trySendBlocking
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onCompletion
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * SubEtha client: publish, dry-run estimates, poll, and subscribe with reconnect, dedupe and
 * acks. Mirrors the TypeScript reference client (`sdk/js/src/client.ts`).
 *
 * ```kotlin
 * val client = SubEtha(token = "se_…")
 * client.publish("@me/doorbell", "ding", PublishOptions(title = "Front door"))
 * client.subscribe(listOf("@me/doorbell")).collect { println(it.message) }
 * ```
 *
 * @param signRequests authenticate every request with the device signature instead of the
 *   bearer token (a signing key attached with [attachDeviceKey]).
 * @param dba authenticate every request as a devicebasedauth.org device (its Authorization and
 *   DPoP headers). Not with [signRequests].
 * @param crypto signature checks and E2EE, from `us.subetha:subetha-core`.
 * @param clock unix seconds; replaceable in tests.
 */
public class SubEtha @JvmOverloads constructor(
    baseUrl: String = DEFAULT_BASE_URL,
    private val token: String? = null,
    private val deviceSigner: DeviceSigner? = null,
    private val signRequests: Boolean = false,
    private val dba: DbaHeaders? = null,
    private val crypto: EnvelopeCrypto? = null,
    topicKeys: Map<String, TopicKey> = emptyMap(),
    private val transport: HttpTransport = UrlConnectionTransport(),
    private val clock: () -> Long = { System.currentTimeMillis() / 1000 },
) {
    public val baseUrl: String = baseUrl.trimEnd('/')
    private val topicKeys: java.util.concurrent.ConcurrentHashMap<String, TopicKey> = java.util.concurrent.ConcurrentHashMap(topicKeys)

    init {
        require(!signRequests || deviceSigner != null) { "signRequests needs a deviceSigner" }
        require(!(signRequests && dba != null)) { "use either signRequests or dba, not both" }
        require(topicKeys.isEmpty() || crypto != null) { "topicKeys need an EnvelopeCrypto (us.subetha:subetha-core)" }
    }

    /** Set or clear (with null) the E2EE topic key used automatically for [topic]. */
    public fun setTopicKey(topic: String, key: TopicKey?) {
        if (key == null) {
            topicKeys.remove(topic)
            return
        }
        require(crypto != null) { "topicKeys need an EnvelopeCrypto (us.subetha:subetha-core)" }
        topicKeys[topic] = key
    }

    // ---------------------------------------------------------------- HTTP

    private suspend fun headersFor(method: String, url: String, body: ByteArray?, extra: Map<String, String>): Map<String, String> {
        val h = LinkedHashMap<String, String>()
        h["User-Agent"] = USER_AGENT
        h["Accept"] = "application/json"
        h.putAll(extra)
        if (dba != null) h.putAll(dba.headers(method, url))
        else if (signRequests) h.putAll(signRequest(deviceSigner!!, method, url, body ?: ByteArray(0), clock(), headers = h.toMap()))
        else if (token != null) h["Authorization"] = "Bearer $token"
        return h
    }

    private suspend fun send(method: String, url: String, body: ByteArray?, extra: Map<String, String>, streaming: Boolean = false): HttpResponse =
        withContext(Dispatchers.IO) {
            val resp = transport.execute(HttpRequest(method, url, headersFor(method, url, body, extra), body, streaming))
            if (!resp.isSuccessful) {
                val text = try { resp.readText() } catch (_: IOException) { "" } finally { resp.close() }
                throw SubEthaException.from(resp.status, text, resp.header("retry-after"))
            }
            resp
        }

    /** Any JSON API call: `request("GET", "/v1/balance")`. Throws [SubEthaException] on errors. */
    public suspend fun request(method: String, path: String, body: JsonElement? = null, headers: Map<String, String> = emptyMap()): JsonElement {
        val bytes = body?.toString()?.toByteArray(Charsets.UTF_8)
        val extra = if (bytes != null) mapOf("Content-Type" to "application/json") + headers else headers
        val resp = send(method, baseUrl + path, bytes, extra)
        val text = withContext(Dispatchers.IO) { resp.use { it.readText() } }
        return if (text.isBlank()) JsonObject(emptyMap()) else json.parseToJsonElement(text)
    }

    private suspend fun requestObject(method: String, path: String, body: JsonElement? = null, headers: Map<String, String> = emptyMap()): JsonObject =
        request(method, path, body, headers) as? JsonObject ?: throw IOException("expected a JSON object from $path")

    // ---------------------------------------------------------------- publish

    /** The envelope [publish] would send, signed and/or encrypted as configured. */
    public fun buildEnvelope(topic: String, message: String, options: PublishOptions = PublishOptions()): JsonObject {
        var env = buildJsonObject {
            for ((k, v) in options.extra) put(k, v)
            put("topic", topic)
            put("message", message)
            options.title?.let { put("title", it) }
            options.priority?.takeIf { it != 3 }?.let { put("priority", it) }
            if (options.tags.isNotEmpty()) put("tags", JsonArray(options.tags.map(::JsonPrimitive)))
            options.click?.let { put("click", it) }
            options.icon?.let { put("icon", it) }
            options.contentType?.let { put("content_type", it) }
            if (options.actions.isNotEmpty()) put("actions", JsonArray(options.actions))
            options.expires?.let { put("expires", it) }
            options.hops?.let { put("hops", it) }
            options.route?.let { r ->
                put("route", buildJsonObject {
                    r.mode?.let { put("mode", it.wire) }
                    r.maxCostUsd?.let { put("max_cost_usd_micros", Math.floor(it * 1e6).toLong()) }
                    if (r.deny.isNotEmpty()) put("deny", JsonArray(r.deny.map(::JsonPrimitive)))
                    if (r.allow.isNotEmpty()) put("allow", JsonArray(r.allow.map(::JsonPrimitive)))
                    r.deadlineS?.let { put("deadline_s", it) }
                })
            }
        }
        val topicKey = topicKeys[topic]
        val sign = options.sign ?: (deviceSigner != null)
        val encrypt = options.encrypt ?: (topicKey != null)
        if (sign || encrypt) {
            env = JsonObject(env + mapOf("id" to JsonPrimitive(Ulid.next()), "time" to JsonPrimitive(clock())))
        }
        if (encrypt) {
            val k = topicKey ?: throw IllegalStateException("no E2EE key for $topic")
            env = json.parseToJsonElement(crypto!!.encrypt(env.toString(), k.key, k.kid)) as JsonObject
        }
        if (sign) {
            val signer = deviceSigner ?: throw IllegalStateException("sign requested but no deviceSigner configured")
            env = json.parseToJsonElement(signer.signEnvelope(env.toString())) as JsonObject
        }
        return env
    }

    /** Publishes a message and returns the stored envelope as the relay saw it. */
    public suspend fun publish(topic: String, message: String, options: PublishOptions = PublishOptions()): Message {
        val env = buildEnvelope(topic, message, options)
        val headers = options.idempotencyKey?.let { mapOf("Idempotency-Key" to it) } ?: emptyMap()
        return Message(requestObject("POST", "/", env, headers))
    }

    /**
     * Publishes an envelope exactly as given: one built elsewhere, or one that arrived over an
     * edge link (signatures and E2EE stay intact; the relay drops it as a duplicate by id).
     */
    public suspend fun publishEnvelope(envelope: JsonObject, idempotencyKey: String? = null): Message {
        val headers = idempotencyKey?.let { mapOf("Idempotency-Key" to it) } ?: emptyMap()
        return Message(requestObject("POST", "/", JsonObject(envelope - "event"), headers))
    }

    /** Dry run: who would get it, how, and the worst-case cost. Nothing is delivered. */
    public suspend fun estimate(topic: String, message: String, options: PublishOptions = PublishOptions()): Estimate {
        val env = buildEnvelope(topic, message, options)
        return Estimate(requestObject("POST", "/", env, mapOf("X-Dry-Run" to "1")))
    }

    private fun fileHeaders(filename: String, contentType: String, message: String?, options: PublishOptions, extra: Map<String, String> = emptyMap()): Map<String, String> {
        val h = LinkedHashMap<String, String>()
        h["Content-Type"] = contentType
        h["X-Filename"] = filename
        message?.let { h["X-Message"] = it }
        options.title?.let { h["X-Title"] = it }
        options.priority?.takeIf { it != 3 }?.let { h["X-Priority"] = it.toString() }
        if (options.tags.isNotEmpty()) h["X-Tags"] = options.tags.joinToString(",")
        options.click?.let { h["X-Click"] = it }
        options.icon?.let { h["X-Icon"] = it }
        if (options.actions.isNotEmpty()) h["X-Actions"] = JsonArray(options.actions).toString()
        if (options.contentType == "text/markdown") h["X-Markdown"] = "1"
        else options.contentType?.let { h["X-Content-Type"] = it }
        options.expires?.let { h["X-Expires"] = it.toString() }
        options.hops?.let { h["X-Hops"] = it.toString() }
        options.route?.let { r ->
            r.mode?.let { h["X-Route-Mode"] = it.wire }
            r.maxCostUsd?.let { h["X-Max-Cost"] = it.toString() }
            if (r.deny.isNotEmpty()) h["X-Deny"] = r.deny.joinToString(",")
            if (r.allow.isNotEmpty()) h["X-Allow"] = r.allow.joinToString(",")
            r.deadlineS?.let { h["X-Deadline"] = it.toString() }
        }
        options.idempotencyKey?.let { h["Idempotency-Key"] = it }
        h.putAll(extra)
        return h
    }

    /** Publishes a file attachment uploaded to R2 (`PUT /<topic>` with `X-Filename`). */
    public suspend fun publishFile(
        topic: String,
        filename: String,
        bytes: ByteArray,
        contentType: String = "application/octet-stream",
        message: String? = null,
        options: PublishOptions = PublishOptions(),
    ): Message {
        val url = "$baseUrl/${topicPath(listOf(topic))}"
        val resp = send("PUT", url, bytes, fileHeaders(filename, contentType, message, options))
        val text = withContext(Dispatchers.IO) { resp.use { it.readText() } }
        return Message(json.parseToJsonElement(text) as? JsonObject ?: throw IOException("expected a JSON object"))
    }

    /** Dry run for a file-attachment publish. */
    public suspend fun estimateFile(
        topic: String,
        filename: String,
        bytes: ByteArray,
        contentType: String = "application/octet-stream",
        message: String? = null,
        options: PublishOptions = PublishOptions(),
    ): Estimate {
        val url = "$baseUrl/${topicPath(listOf(topic))}"
        val resp = send("PUT", url, bytes, fileHeaders(filename, contentType, message, options, mapOf("X-Dry-Run" to "1")))
        val text = withContext(Dispatchers.IO) { resp.use { it.readText() } }
        return Estimate(json.parseToJsonElement(text) as? JsonObject ?: throw IOException("expected a JSON object"))
    }

    // ---------------------------------------------------------------- receive

    private fun query(since: String?, priority: List<Int>, tags: List<String>, poll: Boolean): String {
        val q = mutableListOf<String>()
        if (poll) q += "poll=1"
        since?.let { q += "since=${enc(it)}" }
        if (priority.isNotEmpty()) q += "priority=${priority.joinToString(",")}"
        if (tags.isNotEmpty()) q += "tags=${enc(tags.joinToString(","))}"
        return if (q.isEmpty()) "" else "?" + q.joinToString("&")
    }

    /** Cached messages for [topics] (since defaults to `all`). */
    public suspend fun poll(topics: List<String>, since: String = "all", priority: List<Int> = emptyList(), tags: List<String> = emptyList()): List<Message> {
        val url = "$baseUrl/${topicPath(topics)}/json${query(since, priority, tags, poll = true)}"
        val text = withContext(Dispatchers.IO) { send("GET", url, null, emptyMap()).use { it.readText() } }
        return text.lineSequence().filter { it.isNotBlank() }.map { receive(json.parseToJsonElement(it) as JsonObject) }.toList()
    }

    public suspend fun poll(topic: String, since: String = "all"): List<Message> = poll(listOf(topic), since)

    /** Acknowledges a message so escalation stops. */
    public suspend fun ack(topic: String, id: String, via: String = "http") {
        request("POST", "/v1/ack", buildJsonObject { put("topic", topic); put("id", id); put("via", via) })
    }

    private fun receive(env: JsonObject): Message {
        val key = topicKeys[(env["topic"] as? JsonPrimitive)?.content]
        if (env["enc"] != null && key != null) {
            crypto!!.decrypt(env.toString(), key.key)?.let { return Message(json.parseToJsonElement(it) as JsonObject) }
        }
        return Message(env)
    }

    /**
     * Subscribes to [topics] as a cold [Flow]. Collecting opens a JSON stream (or polls), and
     * reconnects with exponential backoff, resuming from the last message id. Duplicates are
     * dropped, encrypted messages decrypted, and each message is acked after the collector
     * returns. Cancel the collecting coroutine to unsubscribe.
     *
     * Client errors that retrying can't fix (401, 402, 403, 404, …) end the flow with a
     * [SubEthaException]; network errors, 408, 429 and 5xx reconnect.
     */
    public fun subscribe(topics: List<String>, options: SubscribeOptions = SubscribeOptions()): Flow<Message> = flow {
        require(!(options.verify || options.requireSignature) || crypto != null) { "verify needs an EnvelopeCrypto (us.subetha:subetha-core)" }
        val dedupe = Deduper()
        var since = options.since
        var backoff = options.initialBackoffMs
        val via = if (options.transport == SubscribeTransport.POLL) "poll" else "stream"

        suspend fun handle(raw: JsonObject): Message? {
            val event = (raw["event"] as? JsonPrimitive)?.content
            if (event != null && event != "message") {
                if (event == "open") {
                    backoff = options.initialBackoffMs
                    options.onOpen?.invoke()
                }
                return null
            }
            if (!dedupe.accept(raw, clock())) return null
            (raw["id"] as? JsonPrimitive)?.content?.let { since = it }
            if (options.verify || options.requireSignature) {
                if (raw["sig"] != null) { if (!crypto!!.verify(raw.toString())) return null } else if (options.requireSignature) return null
            }
            return if (options.raw) Message(raw) else receive(raw)
        }

        suspend fun afterEmit(m: Message) {
            val id = m.id
            if (options.autoAck && id != null) {
                try { ack(m.topic, id, via) } catch (e: CancellationException) { throw e } catch (e: Exception) { options.onError?.invoke(e) }
            }
        }

        while (true) {
            try {
                if (options.transport == SubscribeTransport.POLL) {
                    for (raw in pollRaw(topics, since ?: "all", options)) {
                        val m = handle(raw) ?: continue
                        emit(m)
                        afterEmit(m)
                    }
                    if (since == null) since = clock().toString()
                    backoff = options.initialBackoffMs
                    delay(options.pollIntervalMs)
                    continue
                }
                val url = "$baseUrl/${topicPath(topics)}/json${query(since, options.priority, options.tags, poll = false)}"
                val resp = send("GET", url, null, emptyMap(), streaming = true)
                // Blocking reads can't observe coroutine cancellation, and HttpURLConnection
                // can't abort a read from another thread, so the read loop runs on its own
                // daemon thread. Unsubscribing never waits for it: the thread exits on the
                // next line (keepalive) or when the server closes the stream.
                val lines = Channel<String>(64)
                thread(isDaemon = true, name = "subetha-stream") {
                    try {
                        val reader = resp.body.bufferedReader(Charsets.UTF_8)
                        while (true) {
                            val line = reader.readLine() ?: break
                            if (line.isNotBlank() && lines.trySendBlocking(line).isFailure) break
                        }
                        lines.close()
                    } catch (e: Throwable) {
                        lines.close(e)
                    }
                }
                try {
                    for (line in lines) {
                        val raw = json.parseToJsonElement(line) as? JsonObject ?: continue
                        val m = handle(raw) ?: continue
                        emit(m)
                        afterEmit(m)
                    }
                } finally {
                    lines.cancel()
                    thread(isDaemon = true, name = "subetha-stream-close") { resp.close() }
                }
                throw IOException("stream ended")
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (e is SubEthaException && e.status in 400..499 && e.status != 408 && e.status != 429) throw e
                options.onError?.invoke(e)
                val wait = (e as? SubEthaException)?.retryAfter?.let { (it * 1000).toLong() } ?: backoff
                delay(wait)
                backoff = minOf(backoff * 2, options.maxBackoffMs)
            }
        }
    }

    public fun subscribe(topic: String, options: SubscribeOptions = SubscribeOptions()): Flow<Message> = subscribe(listOf(topic), options)

    /**
     * Callback form of [subscribe] for Java and UI code without coroutines. Messages are
     * delivered on [scope]'s dispatcher; a terminal error goes to [SubscribeOptions.onError].
     */
    @JvmOverloads
    public fun subscribe(
        topics: List<String>,
        options: SubscribeOptions,
        listener: MessageListener,
        scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
    ): Subscription {
        var closed = false
        val job = subscribe(topics, options)
            .onEach { listener.onMessage(it) }
            .catch { options.onError?.invoke(it) }
            .onCompletion { closed = true }
            .launchIn(scope)
        return object : Subscription {
            override val isClosed: Boolean get() = closed || !job.isActive
            override fun close() {
                closed = true
                job.cancel()
            }
        }
    }

    private suspend fun pollRaw(topics: List<String>, since: String, options: SubscribeOptions): List<JsonObject> {
        val url = "$baseUrl/${topicPath(topics)}/json${query(since, options.priority, options.tags, poll = true)}"
        val text = withContext(Dispatchers.IO) { send("GET", url, null, emptyMap()).use { it.readText() } }
        return text.lineSequence().filter { it.isNotBlank() }.mapNotNull { json.parseToJsonElement(it) as? JsonObject }.toList()
    }

    // ---------------------------------------------------------------- devices

    /**
     * As a devicebasedauth.org device (the [dba] option), attach this client's Ed25519 signing key
     * ([deviceSigner]): topic keys can then be sealed to it, and it can sign requests and messages.
     * The DBA device needs grants for `subetha:publish` and `subetha:subscribe` on every topic.
     */
    public suspend fun attachDeviceKey(name: String? = null, capabilities: List<String> = emptyList()): JsonObject {
        val signer = deviceSigner ?: throw IllegalStateException("attachDeviceKey needs a deviceSigner")
        val p = enrollmentProof(signer, clock())
        val body = buildJsonObject {
            put("device_id", p.deviceId)
            put("time", p.time)
            put("proof", p.proof)
            name?.let { put("name", it) }
            if (capabilities.isNotEmpty()) put("capabilities", JsonArray(capabilities.map(::JsonPrimitive)))
        }
        return requestObject("POST", "/v1/devices/dba", body)
    }

    /** The account's devicebasedauth.org link: `linked`, `dba_account`, `issuer`, `audience`. */
    public suspend fun dbaLink(): JsonObject = requestObject("GET", "/v1/dba/link")
    /** Start linking (signed-in console sessions): open `url`; devicebasedauth.org returns to /auth/dba/callback. */
    public suspend fun startDbaLink(): JsonObject = requestObject("POST", "/v1/dba/link/start", JsonObject(emptyMap()))
    public suspend fun finishDbaLink(code: String, state: String): JsonObject =
        requestObject("POST", "/v1/dba/link/finish", buildJsonObject { put("code", code); put("state", state) })
    public suspend fun unlinkDba(): JsonObject = requestObject("DELETE", "/v1/dba/link")

    // ---------------------------------------------------------------- control plane

    public suspend fun account(): JsonObject = requestObject("GET", "/v1/account")
    public suspend fun updateAccount(patch: JsonObject): JsonObject = requestObject("PATCH", "/v1/account", patch)
    public suspend fun balance(): JsonObject = requestObject("GET", "/v1/balance")
    public suspend fun prices(): JsonObject = requestObject("GET", "/v1/prices")
    public suspend fun trace(topic: String, id: String): JsonObject = requestObject("GET", "/v1/traces/${enc(id)}?topic=${enc(topic)}")
    public suspend fun ledger(after: Long = 0, limit: Int = 100): JsonObject = requestObject("GET", "/v1/ledger?after=$after&limit=$limit")
    public suspend fun usage(days: Int = 30): JsonObject = requestObject("GET", "/v1/usage?days=$days")
    public suspend fun audit(limit: Int = 50): JsonObject = requestObject("GET", "/v1/audit?limit=$limit")
    public suspend fun topics(): JsonObject = requestObject("GET", "/v1/topics")
    public suspend fun topic(name: String): JsonObject = requestObject("GET", "/v1/topics/${topicPath(listOf(name))}")
    public suspend fun createTopic(name: String, policy: JsonObject = JsonObject(emptyMap())): JsonObject =
        requestObject("PUT", "/v1/topics/${topicPath(listOf(name))}", buildJsonObject { put("policy", policy) })
    public suspend fun deleteTopic(name: String): JsonObject = requestObject("DELETE", "/v1/topics/${topicPath(listOf(name))}")
    public suspend fun devices(): JsonObject = requestObject("GET", "/v1/devices")
    public suspend fun updateDevice(id: String, patch: JsonObject): JsonObject = requestObject("PATCH", "/v1/devices/${enc(id)}", patch)
    public suspend fun revokeDevice(id: String): JsonObject = requestObject("DELETE", "/v1/devices/${enc(id)}")
    public suspend fun endpoints(): JsonObject = requestObject("GET", "/v1/endpoints")
    public suspend fun deleteEndpoint(id: String): JsonObject = requestObject("DELETE", "/v1/endpoints/${enc(id)}")
    public suspend fun subscriptions(): JsonObject = requestObject("GET", "/v1/subscriptions")
    public suspend fun deleteSubscription(id: String): JsonObject = requestObject("DELETE", "/v1/subscriptions/${enc(id)}")
    public suspend fun tokens(): JsonObject = requestObject("GET", "/v1/tokens")
    public suspend fun revokeToken(id: String): JsonObject = requestObject("DELETE", "/v1/tokens/${enc(id)}")
    public suspend fun listWrappedKeys(topic: String? = null): JsonObject =
        requestObject("GET", if (topic != null) "/v1/keys?topic=${enc(topic)}" else "/v1/keys")
    public suspend fun deleteWrappedKeys(topic: String, kid: String? = null, device: String? = null): JsonObject {
        val qs = buildList {
            add("topic=${enc(topic)}")
            kid?.let { add("kid=${enc(it)}") }
            device?.let { add("device=${enc(it)}") }
        }
        return requestObject("DELETE", "/v1/keys?${qs.joinToString("&")}")
    }

    public companion object {
        public const val DEFAULT_BASE_URL: String = "https://subetha.us"
        public const val VERSION: String = "0.1.0"
        private const val USER_AGENT = "subetha-kotlin/$VERSION"

        private fun enc(s: String): String = URLEncoder.encode(s, "UTF-8").replace("+", "%20")

        /** `@a/b,@a/c` with each path segment percent-encoded. */
        internal fun topicPath(topics: List<String>): String {
            require(topics.isNotEmpty()) { "at least one topic is required" }
            return topics.joinToString(",") { t -> t.split("/").joinToString("/") { enc(it).replace("%40", "@") } }
        }
    }
}

/** Seen-id LRU (spec §6). Ids compare case-insensitively; expired messages are dropped. */
internal class Deduper(private val capacity: Int = 10_000) {
    private val seen = object : LinkedHashMap<String, Unit>(16, 0.75f, false) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Unit>?): Boolean = size > capacity
    }

    @Synchronized
    fun accept(env: JsonObject, nowSec: Long): Boolean {
        val expires = (env["expires"] as? JsonPrimitive)?.longOrNull
        if (expires != null && expires < nowSec) return false
        val id = (env["id"] as? JsonPrimitive)?.content ?: return true
        return seen.put(id.uppercase(), Unit) == null
    }
}
