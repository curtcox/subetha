package us.subetha

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

/**
 * An error response from the relay (spec §9). [code] is the stable machine-readable code
 * (`insufficient_balance`, `rate_limited`, …; see spec/errors.json), [status] the HTTP status,
 * and [body] the full JSON error body (extra fields such as `shortfall_usd_micros`).
 */
public class SubEthaException(
    public val code: String,
    public val status: Int,
    message: String,
    public val body: JsonObject = JsonObject(emptyMap()),
    /** Seconds from `Retry-After`, if the server sent one. */
    public val retryAfter: Double? = null,
) : Exception(if (message.isEmpty()) "$code (HTTP $status)" else "$code (HTTP $status): $message") {

    /** Worth retrying later: rate limits and server-side failures. */
    public val retryable: Boolean get() = status == 429 || status >= 500 || status == 0

    internal companion object {
        // Fallback codes when a proxy in front of the relay returns a non-JSON body.
        private val STATUS_CODES = mapOf(
            400 to "bad_request", 401 to "unauthorized", 403 to "forbidden", 404 to "not_found",
            409 to "conflict", 413 to "message_too_large", 429 to "rate_limited",
            500 to "internal", 503 to "provider_unavailable",
        )

        fun from(status: Int, text: String, retryAfterHeader: String?): SubEthaException {
            val retryAfter = retryAfterHeader?.trim()?.toDoubleOrNull()
            val obj = parseObjectOrNull(text)
            val code = (obj?.get("error") as? JsonPrimitive)?.takeIf { it.isString }?.content
            if (obj != null && code != null) {
                val http = (obj["http"] as? JsonPrimitive)?.intOrNull ?: status
                val msg = (obj["message"] as? JsonPrimitive)?.content ?: ""
                return SubEthaException(code, http, msg, obj, retryAfter)
            }
            return SubEthaException(STATUS_CODES[status] ?: "http_$status", status, text.trim().take(500), obj ?: JsonObject(emptyMap()), retryAfter)
        }
    }
}
