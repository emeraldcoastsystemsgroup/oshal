/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial: tiny HttpURLConnection JSON POST helper for the TV pairing flow (no extra dependencies). Callers run it off the main thread.
 */
package com.oshal.firetv

import java.net.HttpURLConnection
import java.net.URL

/** Minimal HTTP helper for the pairing endpoints — avoids pulling in a networking library. */
object Net {
    /**
     * @description POSTs a JSON body and returns the response body as text (success or error stream).
     *              Must be called off the UI thread.
     * @param urlStr absolute URL to POST to.
     * @param json the request body (already serialized).
     * @returns the response body text (possibly empty); throws on transport failure.
     */
    fun postJson(urlStr: String, json: String): String {
        val conn = URL(urlStr).openConnection() as HttpURLConnection
        return try {
            conn.requestMethod = "POST"
            conn.connectTimeout = 10_000
            conn.readTimeout = 15_000
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Accept", "application/json")
            conn.outputStream.use { it.write(json.toByteArray(Charsets.UTF_8)) }
            val ok = conn.responseCode in 200..299
            val stream = if (ok) conn.inputStream else conn.errorStream
            stream?.bufferedReader()?.use { it.readText() }.orEmpty()
        } finally {
            conn.disconnect()
        }
    }
}
