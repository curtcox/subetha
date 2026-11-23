package us.subetha

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors

/** A recorded request. Header names are lower-cased. */
class Recorded(val method: String, val pathAndQuery: String, val headers: Map<String, String>, val body: String)

/** Local relay stand-in on com.sun.net.httpserver. [handler] writes the response. */
class MockServer(private val handler: (Recorded, HttpExchange) -> Unit) : AutoCloseable {
    val requests = CopyOnWriteArrayList<Recorded>()
    private val server: HttpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
    private val pool = Executors.newCachedThreadPool()

    init {
        server.createContext("/") { ex ->
            val uri = ex.requestURI
            val r = Recorded(
                ex.requestMethod,
                uri.rawPath + (uri.rawQuery?.let { "?$it" } ?: ""),
                ex.requestHeaders.entries.associate { it.key.lowercase() to it.value.joinToString(",") },
                ex.requestBody.readBytes().toString(Charsets.UTF_8),
            )
            requests += r
            try {
                handler(r, ex)
            } catch (_: Exception) {
                // client went away
            } finally {
                ex.close()
            }
        }
        server.executor = pool
        server.start()
    }

    val url: String get() = "http://127.0.0.1:${server.address.port}"

    override fun close() {
        server.stop(0)
        pool.shutdownNow()
    }

    companion object {
        fun respond(ex: HttpExchange, status: Int, body: String, contentType: String = "application/json", headers: Map<String, String> = emptyMap()) {
            val bytes = body.toByteArray(Charsets.UTF_8)
            ex.responseHeaders.add("Content-Type", contentType)
            for ((k, v) in headers) ex.responseHeaders.add(k, v)
            ex.sendResponseHeaders(status, if (bytes.isEmpty()) -1 else bytes.size.toLong())
            if (bytes.isNotEmpty()) ex.responseBody.use { it.write(bytes) }
        }

        /** Starts a chunked NDJSON stream and writes [lines], flushing each. */
        fun stream(ex: HttpExchange, lines: List<String>, holdOpenMs: Long = 0) {
            ex.responseHeaders.add("Content-Type", "application/x-ndjson")
            ex.sendResponseHeaders(200, 0)
            val out = ex.responseBody
            for (l in lines) {
                out.write((l + "\n").toByteArray())
                out.flush()
            }
            if (holdOpenMs > 0) Thread.sleep(holdOpenMs)
            out.close()
        }
    }
}
