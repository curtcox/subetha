package org.subetha

import java.io.ByteArrayInputStream
import java.io.Closeable
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

/** One HTTP request. [body] is sent as-is; headers are case-insensitive on the wire. */
public class HttpRequest(
    public val method: String,
    public val url: String,
    public val headers: Map<String, String>,
    public val body: ByteArray? = null,
    /** True for long-lived subscriptions: use the stream read timeout. */
    public val streaming: Boolean = false,
)

/** A response whose [body] is read incrementally. [close] must abort a blocked read. */
public class HttpResponse(
    public val status: Int,
    /** Lower-cased header names. */
    public val headers: Map<String, String>,
    public val body: InputStream,
    private val onClose: () -> Unit = { body.close() },
) : Closeable {
    public val isSuccessful: Boolean get() = status in 200..299

    public fun header(name: String): String? = headers[name.lowercase()]

    public fun readText(): String = body.use { it.readBytes().toString(Charsets.UTF_8) }

    override fun close() {
        try { onClose() } catch (_: IOException) { }
    }
}

/**
 * The HTTP layer. Calls are blocking; the client runs them on `Dispatchers.IO`.
 * Swap in OkHttp/Ktor/etc. by implementing this interface.
 */
public fun interface HttpTransport {
    @Throws(IOException::class)
    public fun execute(request: HttpRequest): HttpResponse
}

/**
 * Default transport on `java.net.HttpURLConnection`, which exists on every JVM and on
 * Android, so the SDK needs no HTTP dependency.
 */
public class UrlConnectionTransport(
    private val connectTimeoutMs: Int = 15_000,
    private val readTimeoutMs: Int = 30_000,
    /** Servers send a keepalive at least every ~55 s; silence beyond this means a dead stream. */
    private val streamReadTimeoutMs: Int = 90_000,
) : HttpTransport {
    override fun execute(request: HttpRequest): HttpResponse {
        val conn = URL(request.url).openConnection() as HttpURLConnection
        conn.requestMethod = request.method
        conn.connectTimeout = connectTimeoutMs
        conn.readTimeout = if (request.streaming) streamReadTimeoutMs else readTimeoutMs
        conn.instanceFollowRedirects = false
        conn.useCaches = false
        for ((k, v) in request.headers) conn.setRequestProperty(k, v)
        val body = request.body
        if (body != null) {
            conn.doOutput = true
            conn.setFixedLengthStreamingMode(body.size)
            conn.outputStream.use { it.write(body) }
        }
        val status = conn.responseCode
        val headers = conn.headerFields.entries
            .filter { it.key != null }
            .associate { it.key.lowercase() to it.value.joinToString(",") }
        val stream = (if (status >= 400) conn.errorStream else conn.inputStream) ?: ByteArrayInputStream(ByteArray(0))
        // disconnect() closes the socket, which unblocks a read on another thread; closing a
        // chunked stream instead would try to drain it.
        return HttpResponse(status, headers, stream) { conn.disconnect() }
    }
}
