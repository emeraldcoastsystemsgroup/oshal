/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial: device-pairing screen. Requests a code from /api/tv/pair/start, shows it + the approval URL, polls /api/tv/pair/poll until the user approves it in a browser (where Google login works), then stores the returned token and returns RESULT_OK so MainActivity loads the dashboard.
 */
package com.oshal.firetv

import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject

/**
 * Pairs the TV with the user's OSHAL account using an OAuth-device-grant-style flow.
 *
 * Google blocks sign-in inside embedded WebViews, so instead of logging in on the TV the user
 * approves a short code in a real browser; this screen polls until that approval lands and then
 * hands the resulting token back to [MainActivity].
 */
class PairingActivity : AppCompatActivity() {

    private val ui = Handler(Looper.getMainLooper())
    @Volatile private var polling = false
    private var deviceCode = ""
    private var pollIntervalMs = 5_000L
    private var deadline = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_pairing)
        findViewById<Button>(R.id.retry).setOnClickListener { start() }
        start()
    }

    override fun onDestroy() {
        polling = false
        super.onDestroy()
    }

    /** Requests a fresh pairing code and begins polling. */
    private fun start() {
        setStatus(getString(R.string.pairing_requesting))
        findViewById<Button>(R.id.retry).visibility = View.GONE
        findViewById<TextView>(R.id.code).text = "····-····"
        Thread {
            try {
                val base = Config.getBaseUrl(this)
                val res = JSONObject(Net.postJson("$base/api/tv/pair/start", "{}"))
                deviceCode = res.getString("device_code")
                pollIntervalMs = res.optLong("interval", 5L) * 1000L
                deadline = System.currentTimeMillis() + res.optLong("expires_in", 600L) * 1000L
                val code = res.getString("user_code")
                val url = res.getString("verification_uri")
                ui.post { showCode(code, url) }
                polling = true
                pollLoop()
            } catch (e: Exception) {
                ui.post { fail(getString(R.string.pairing_network_error)) }
            }
        }.start()
    }

    /** Polls the server until the code is approved or expires. Runs on a worker thread. */
    private fun pollLoop() {
        while (polling && System.currentTimeMillis() < deadline) {
            try {
                Thread.sleep(pollIntervalMs)
                if (!polling) return
                val res = JSONObject(Net.postJson("${Config.getBaseUrl(this)}/api/tv/pair/poll",
                    JSONObject().put("device_code", deviceCode).toString()))
                when (res.optString("status")) {
                    "approved" -> { finishApproved(res.getString("token")); return }
                    "expired" -> { ui.post { fail(getString(R.string.pairing_expired)) }; return }
                }
            } catch (e: Exception) {
                // transient — keep polling until the deadline
            }
        }
        if (polling) ui.post { fail(getString(R.string.pairing_expired)) }
    }

    private fun finishApproved(token: String) {
        polling = false
        Config.setTvToken(this, token)
        ui.post {
            setStatus(getString(R.string.pairing_connected))
            setResult(Activity.RESULT_OK)
            finish()
        }
    }

    private fun showCode(code: String, url: String) {
        findViewById<TextView>(R.id.code).text = code
        findViewById<TextView>(R.id.instructions).text = getString(R.string.pairing_instructions, url)
        setStatus(getString(R.string.pairing_waiting))
    }

    private fun fail(message: String) {
        polling = false
        setStatus(message)
        findViewById<Button>(R.id.retry).apply { visibility = View.VISIBLE; requestFocus() }
    }

    private fun setStatus(text: String) {
        findViewById<TextView>(R.id.status).text = text
    }
}
