package com.example.smartwaste;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.util.Log;
import android.webkit.ConsoleMessage;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;
import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewFeature;

public class MainActivity extends AppCompatActivity {

    private static final String TAG = "CivicSweep";
    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;

    /** JS-accessible storage (SharedPreferences bridge) */
    @SuppressWarnings("unused")
    public static class NativeStore {
        private final SharedPreferences prefs;
        public NativeStore(Context ctx) {
            //noinspection SpellCheckingInspection
            prefs = ctx.getSharedPreferences("civicsweep_store", MODE_PRIVATE);
        }

        @JavascriptInterface
        public String getItem(String key) {
            return prefs.getString(key, null);
        }

        @JavascriptInterface
        public void setItem(String key, String value) {
            prefs.edit().putString(key, value).apply();
        }

        @JavascriptInterface
        public void removeItem(String key) {
            prefs.edit().remove(key).apply();
        }

        @JavascriptInterface
        public void clear() {
            prefs.edit().clear().apply();
        }
    }

    /** JS-accessible logger for Logcat */
    @SuppressWarnings("unused")
    public static class NativeLog {
        @JavascriptInterface
        public void log(String msg) {
            Log.e(TAG, "JS: " + msg);
        }
    }

    // Location permission launcher
    private final ActivityResultLauncher<String> permissionLauncher =
            registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
                if (granted && webView != null) webView.reload();
            });

    // File chooser launcher (for <input type="file">)
    private final ActivityResultLauncher<Intent> fileChooserLauncher =
            registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
                if (filePathCallback == null) return;
                Uri[] uris = null;
                if (result.getData() != null && result.getResultCode() == RESULT_OK) {
                    Uri uri = result.getData().getData();
                    if (uri != null) uris = new Uri[]{uri};
                }
                filePathCallback.onReceiveValue(uris);
                filePathCallback = null;
            });

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        webView = findViewById(R.id.web);

        // ---- WebView setup ----
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setBuiltInZoomControls(false);
        s.setSupportZoom(false);

        // Smooth dark mode integration
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            // Use app-controlled theming instead of WebView auto-darkening
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(s, false);
        }

        // JS bridge for persistence
        webView.addJavascriptInterface(new NativeStore(this), "NativeStore");
        webView.addJavascriptInterface(new NativeLog(), "NativeLog");

        // Prevent redirects opening external browsers
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return shouldBlockNavigation(request.getUrl());
            }
        });

        // Handle camera/location/file inputs
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                boolean hasPerm = ContextCompat.checkSelfPermission(
                        MainActivity.this, Manifest.permission.ACCESS_FINE_LOCATION
                ) == PackageManager.PERMISSION_GRANTED;

                if (!hasPerm) {
                    permissionLauncher.launch(Manifest.permission.ACCESS_FINE_LOCATION);
                }
                callback.invoke(origin, hasPerm, false);
            }

            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback,
                                             FileChooserParams fileChooserParams) {
                MainActivity.this.filePathCallback = filePathCallback;
                Intent intent = fileChooserParams.createIntent();
                fileChooserLauncher.launch(intent);
                return true;
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage consoleMessage) {
                Log.e(TAG, "JS console: " + consoleMessage.message()
                        + " @ " + consoleMessage.sourceId() + ":" + consoleMessage.lineNumber());
                return true;
            }
        });

        // ---- Load animated splash first ----
        webView.loadUrl("file:///android_asset/splash.html");

        // ---- Then auto-navigate to main UI (index.html) after delay ----
        new Handler().postDelayed(() -> {
            if (webView != null) {
                webView.loadUrl("file:///android_asset/index.html");
            }
        }, 2500); // 2.5 seconds splash

        // Handle back navigation with OnBackPressedDispatcher
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView != null && webView.canGoBack()) {
                    webView.goBack();
                } else {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                }
            }
        });
    }

    private boolean shouldBlockNavigation(Uri uri) {
        if (uri == null) return false;
        String scheme = uri.getScheme();
        if ("about".equalsIgnoreCase(scheme)) return false;
        if ("file".equalsIgnoreCase(scheme)) {
            String path = uri.getPath();
            return !(path != null && path.startsWith("/android_asset/"));
        }
        return true;
    }
}
