/*
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial: Robolectric JVM unit tests for Config — the default production host, the Jarvis-TV landing path, base-URL trimming, and the TV-token round-trip/clear. Runs off-device via `gradle testDebugUnitTest`.
 */
package com.oshal.firetv

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Verifies the persisted-config behavior the surface depends on, without a device. */
@RunWith(RobolectricTestRunner::class)
class ConfigTest {
    private val ctx: Context = ApplicationProvider.getApplicationContext()

    @After
    fun reset() {
        Config.setBaseUrl(ctx, "")
        Config.clearTvToken(ctx)
    }

    @Test
    fun defaultsToProductionHostWhenUnset() {
        assertEquals("https://oshal.agenticfederal.us", Config.getBaseUrl(ctx))
    }

    @Test
    fun homeUrlTargetsTheJarvisTvSurface() {
        assertTrue(Config.homeUrl(ctx).endsWith("/api/jarvis/tv"))
    }

    @Test
    fun setBaseUrlTrimsTrailingSlash() {
        Config.setBaseUrl(ctx, "https://lan.test:5000/")
        assertEquals("https://lan.test:5000", Config.getBaseUrl(ctx))
    }

    @Test
    fun tvTokenRoundTripsAndClears() {
        Config.setTvToken(ctx, "v1.payload.sig")
        assertEquals("v1.payload.sig", Config.getTvToken(ctx))
        Config.clearTvToken(ctx)
        assertEquals("", Config.getTvToken(ctx))
    }
}
