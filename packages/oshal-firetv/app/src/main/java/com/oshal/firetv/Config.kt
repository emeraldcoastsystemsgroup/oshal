/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial: SharedPreferences-backed host-URL config for the Fire TV surface (ADR-047 phase-3 extension node). The Firestick app stores only the OSHAL host URL it points at; all reasoning/state lives on the host + cloud swarm.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Default to the production tunnel host (https://oshal.agenticfederal.us) so first run loads the dashboard with no typing; settings box pre-fills with it.
 */
package com.oshal.firetv

import android.content.Context

/**
 * Persistent configuration for the Fire TV surface.
 *
 * The Firestick is a thin display/control surface (ADR-047 #5) — it holds no device
 * state and no credentials beyond the one thing it needs to know: which OSHAL host to
 * load. That host serves the already-built Smart Home dashboard at [HOME_PATH].
 */
object Config {
    private const val PREFS = "oshal_firetv_prefs"
    private const val KEY_BASE_URL = "base_url"
    private const val KEY_TV_TOKEN = "tv_token"

    /** Name of the cookie the WebView sends to authenticate as the paired user. */
    const val TV_COOKIE = "oshal_tv"

    /** Path of the landing surface served by the OSHAL api (auth-gated). The Jarvis TV view shows
     *  the conversation large and speaks answers; you talk via the phone remote (/api/jarvis/remote).
     *  Full Jarvis is /api/jarvis/ui; Smart Home is /api/home/ui. */
    const val HOME_PATH = "/api/jarvis/tv"

    /** Production tunnel host — the default so the app works out of the box with no setup. */
    const val DEFAULT_BASE_URL = "https://oshal.agenticfederal.us"

    /**
     * @description Returns the configured base URL (scheme + host[:port]), falling back to
     *              [DEFAULT_BASE_URL] when the operator has not overridden it. Means first run
     *              loads the dashboard directly — no setup screen required.
     * @param context any Context (Activity/Application).
     * @returns the trimmed base URL, e.g. "https://oshal.agenticfederal.us" or a LAN override.
     */
    fun getBaseUrl(context: Context): String {
        val saved = prefs(context).getString(KEY_BASE_URL, "")?.trim().orEmpty()
        return saved.ifEmpty { DEFAULT_BASE_URL }
    }

    /**
     * @description Persists the operator-entered base URL. Trailing slash is stripped so
     *              [homeUrl] can append [HOME_PATH] cleanly.
     * @param context any Context.
     * @param value the base URL to store; may include trailing slash.
     * @returns Unit.
     */
    fun setBaseUrl(context: Context, value: String) {
        val cleaned = value.trim().trimEnd('/')
        prefs(context).edit().putString(KEY_BASE_URL, cleaned).apply()
    }

    /**
     * @description Full URL of the home dashboard to load in the WebView, or empty string
     *              when no base URL is configured yet.
     * @param context any Context.
     * @returns base URL + [HOME_PATH], or "" if unconfigured.
     */
    fun homeUrl(context: Context): String {
        val base = getBaseUrl(context)
        return if (base.isEmpty()) "" else base + HOME_PATH
    }

    /**
     * @description The stored TV pairing token (the signed `oshal_tv` value), or empty if the
     *              device has not been paired yet.
     * @param context any Context.
     * @returns the token, or "".
     */
    fun getTvToken(context: Context): String =
        prefs(context).getString(KEY_TV_TOKEN, "")?.trim().orEmpty()

    /**
     * @description Persists the TV pairing token after a successful approval.
     * @param context any Context.
     * @param token the signed token returned by the pairing poll.
     * @returns Unit.
     */
    fun setTvToken(context: Context, token: String) {
        prefs(context).edit().putString(KEY_TV_TOKEN, token.trim()).apply()
    }

    /**
     * @description Clears the stored token (e.g. when the server rejects it as expired) so the
     *              app re-pairs on next launch.
     * @param context any Context.
     * @returns Unit.
     */
    fun clearTvToken(context: Context) {
        prefs(context).edit().remove(KEY_TV_TOKEN).apply()
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
