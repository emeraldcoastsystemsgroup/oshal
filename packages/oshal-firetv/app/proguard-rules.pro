# WebView + JS bridge: keep nothing special is required for this app (no @JavascriptInterface
# classes are exposed to the page). Default Android optimizations are safe.
# If a JS bridge is added later, keep its methods:
# -keepclassmembers class com.oshal.firetv.** {
#     @android.webkit.JavascriptInterface <methods>;
# }
