/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial: first-run / MENU settings screen to enter the OSHAL host URL the Fire TV surface points at. Validates non-empty + http(s) scheme, persists via Config, then returns to the dashboard.
 */
package com.oshal.firetv

import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity

/**
 * Lets the operator set the OSHAL host URL the Fire TV surface loads.
 *
 * Reached on first run (no host configured) and via the remote MENU button. Stores only the
 * base URL (scheme + host[:port]); [Config] appends the dashboard path.
 */
class SettingsActivity : AppCompatActivity() {

    /**
     * @description Renders the host-URL form, pre-filled with any saved value, and saves on submit.
     * @param savedInstanceState standard Android saved-state bundle.
     * @returns Unit.
     */
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)

        val input = findViewById<EditText>(R.id.url_input)
        val save = findViewById<Button>(R.id.save_btn)

        input.setText(Config.getBaseUrl(this))
        input.requestFocus()

        save.setOnClickListener {
            val value = input.text.toString().trim()
            if (!isValid(value)) {
                Toast.makeText(this, R.string.invalid_url, Toast.LENGTH_LONG).show()
                return@setOnClickListener
            }
            Config.setBaseUrl(this, value)
            Toast.makeText(this, R.string.saved, Toast.LENGTH_SHORT).show()
            finish() // back to MainActivity, which reloads with the new host on resume
        }
    }

    private fun isValid(value: String): Boolean =
        value.startsWith("http://") || value.startsWith("https://")
}
