/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial: full-screen WebView surface that loads the OSHAL Smart Home dashboard on a Fire TV Stick. Adds D-pad/remote focus navigation over the web UI, BACK = web history, MENU = settings. Surface only (ADR-047 #5) — no reasoning, no device state on the stick.
 */
package com.oshal.firetv

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.view.KeyEvent
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity

/**
 * The single full-screen activity for the Fire TV surface.
 *
 * Loads [Config.homeUrl] into a [WebView]. On first run (no host configured) it redirects
 * to [SettingsActivity]. The Fire TV remote maps to: D-pad = move focus between web controls,
 * CENTER/ENTER = activate the focused control, BACK = web back (then exit), MENU = settings.
 */
class MainActivity : AppCompatActivity(), TextToSpeech.OnInitListener {

    private lateinit var web: WebView
    private lateinit var progress: ProgressBar
    private lateinit var errorView: TextView

    /** On-device TTS engine; the Jarvis TV view calls it via the `OshalTTS` JS bridge to speak
     *  answers (Fire OS WebView's own speechSynthesis is unreliable). */
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var ttsFallbackTried = false

    /** Launches device pairing; on success (RESULT_OK) the dashboard reloads with the new token. */
    private val pairingLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == RESULT_OK) loadHome() else finish()
    }

    /**
     * @description Builds the WebView surface and loads the configured home URL, or sends the
     *              operator to settings when no host is configured yet.
     * @param savedInstanceState standard Android saved-state bundle.
     * @returns Unit.
     */
    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        web = findViewById(R.id.web)
        progress = findViewById(R.id.progress)
        errorView = findViewById(R.id.error)

        // Make the WebView the D-pad focus owner so remote navigation reaches the page.
        web.isFocusable = true
        web.isFocusableInTouchMode = true
        web.keepScreenOn = true

        // Native TTS + the JS bridge the Jarvis TV view uses to speak answers out loud.
        // Pico is the most reliable bundled engine on Fire OS; fall back to the system default.
        initTts("com.svox.pico")
        web.addJavascriptInterface(TtsBridge(), "OshalTTS")

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            // Camera/clip feeds in the dashboard should autoplay without a (non-existent) tap.
            mediaPlaybackRequiresUserGesture = false
            loadWithOverviewMode = true
            useWideViewPort = true
            // Hardening: we only load the remote OSHAL surface — no local file/content access,
            // and never silently downgrade an https page to http resources.
            allowFileAccess = false
            allowContentAccess = false
            @Suppress("DEPRECATION") allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION") allowUniversalAccessFromFileURLs = false
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }

        web.webChromeClient = WebChromeClient()
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView, request: WebResourceRequest
            ): Boolean = false // keep all navigation (including the OIDC login redirect) in-app

            override fun onPageFinished(view: WebView, url: String) {
                progress.visibility = View.GONE
                view.evaluateJavascript(DPAD_FOCUS_JS, null)
                view.requestFocus()
            }

            override fun onReceivedError(
                view: WebView, request: WebResourceRequest, error: WebResourceError
            ) {
                if (request.isForMainFrame) showError()
            }

            override fun onReceivedHttpError(
                view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse
            ) {
                // A 401 on the main dashboard means the TV token is missing/expired → (re)pair.
                if (request.isForMainFrame && errorResponse.statusCode == 401) {
                    Config.clearTvToken(this@MainActivity)
                    startPairing()
                }
            }
        }

        loadHome()
    }

    /**
     * @description Loads the dashboard, first attaching the pairing token as a cookie. With no
     *              token yet, launches device pairing instead.
     * @returns Unit.
     */
    private fun loadHome() {
        val base = Config.getBaseUrl(this)
        val token = Config.getTvToken(this)
        if (token.isEmpty()) {
            startPairing()
            return
        }
        setAuthCookie(base, token)
        errorView.visibility = View.GONE
        progress.visibility = View.VISIBLE
        web.loadUrl(Config.homeUrl(this))
    }

    /** Sets the signed pairing token as the [Config.TV_COOKIE] cookie so every request carries it. */
    private fun setAuthCookie(base: String, token: String) {
        val cm = CookieManager.getInstance()
        cm.setAcceptCookie(true)
        cm.setAcceptThirdPartyCookies(web, true)
        cm.setCookie(base, "${Config.TV_COOKIE}=$token; Path=/; Secure; SameSite=Lax")
        cm.flush()
    }

    /** Opens the pairing screen (modal); the launcher reloads the dashboard when it succeeds. */
    private fun startPairing() {
        pairingLauncher.launch(Intent(this, PairingActivity::class.java))
    }

    /** (Re)creates the TTS engine — a specific engine package, or the system default when null. */
    private fun initTts(engine: String?) {
        tts = if (engine != null) TextToSpeech(this, this, engine) else TextToSpeech(this, this)
    }

    /** TextToSpeech init callback — sets US English, speaks a short "ready" so audio is confirmed,
     *  and falls back to the system default engine once if the chosen one fails. */
    override fun onInit(status: Int) {
        if (status == TextToSpeech.SUCCESS) {
            val lang = tts?.setLanguage(java.util.Locale.US)
            val langOk = lang != TextToSpeech.LANG_MISSING_DATA && lang != TextToSpeech.LANG_NOT_SUPPORTED
            if (langOk) {
                ttsReady = true
                android.util.Log.i("OshalTTS", "TTS ready (lang=$lang)")
            } else if (!ttsFallbackTried) {
                retryWithDefault()
            }
        } else if (!ttsFallbackTried) {
            android.util.Log.w("OshalTTS", "TTS init failed (status=$status) — trying default engine")
            retryWithDefault()
        }
    }

    private fun retryWithDefault() {
        ttsFallbackTried = true
        tts?.shutdown()
        initTts(null)
    }

    override fun onDestroy() {
        tts?.stop()
        tts?.shutdown()
        super.onDestroy()
    }

    /** JS bridge exposed to the web view as `OshalTTS` so the Jarvis TV view can speak answers. */
    inner class TtsBridge {
        @JavascriptInterface
        fun speak(text: String) {
            if (!ttsReady || text.isBlank()) return
            runOnUiThread { tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "jarvis") }
        }
    }

    private fun showError() {
        progress.visibility = View.GONE
        errorView.visibility = View.VISIBLE
    }

    /**
     * @description Routes Fire TV remote keys: MENU → settings, BACK → web history then exit.
     *              Other keys (D-pad, CENTER) fall through to the WebView for in-page focus.
     * @param keyCode the pressed key code.
     * @param event the key event.
     * @returns true if handled here, otherwise defers to the default handler.
     */
    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_MENU -> {
                startActivity(Intent(this, SettingsActivity::class.java))
                return true
            }
            KeyEvent.KEYCODE_BACK -> {
                if (web.canGoBack()) {
                    web.goBack()
                    return true
                }
            }
        }
        return super.onKeyDown(keyCode, event)
    }

    private companion object {
        /**
         * Injected after each page load so the Fire TV remote can drive the web dashboard:
         *  - tags clickable elements (buttons, scene tiles, toggles, cards) as D-pad focusable,
         *  - draws a visible focus ring,
         *  - maps CENTER/ENTER to a click on the focused element,
         *  - re-applies on DOM changes (the dashboard renders devices asynchronously).
         */
        const val DPAD_FOCUS_JS = """
        (function(){
          if (window.__oshalTv) return; window.__oshalTv = true;
          var SEL = '.btn,.scene,.sw,.card,a,button,input,select,textarea,[onclick]';
          function tag(){
            document.querySelectorAll(SEL).forEach(function(el){
              if(!el.hasAttribute('tabindex')) el.setAttribute('tabindex','0');
            });
          }
          var st = document.createElement('style');
          st.textContent = ':focus{outline:3px solid #7c6cff !important;outline-offset:2px;border-radius:10px;}';
          document.documentElement.appendChild(st);
          tag();
          if (document.body) new MutationObserver(tag).observe(document.body,{childList:true,subtree:true});
          document.addEventListener('keydown', function(e){
            if (e.key === 'Enter' || e.keyCode === 13 || e.keyCode === 23) {
              var a = document.activeElement;
              if (a && a.tagName !== 'INPUT' && a.tagName !== 'TEXTAREA' && a.tagName !== 'SELECT') {
                a.click(); e.preventDefault();
              }
            }
          });
        })();
        """
    }
}
