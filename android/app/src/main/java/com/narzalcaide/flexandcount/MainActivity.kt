package com.narzalcaide.flexandcount

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

// A thin shell around the live web app, like the Time Log Android app:
// every web update shows up here without a new APK.
class MainActivity : ComponentActivity() {
    private lateinit var web: WebView
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingCamera: PermissionRequest? = null

    private val askCamera = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val request = pendingCamera ?: return@registerForActivityResult   // asked at launch: nothing waiting yet
        pendingCamera = null
        if (granted) {
            request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
        } else {
            request.deny()
            Toast.makeText(this, R.string.camera_needed, Toast.LENGTH_LONG).show()
        }
    }

    private val pickFile = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data))
        fileCallback = null
    }

    private val back = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
            if (web.canGoBack()) web.goBack() else finish()
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        // Full screen like a camera app: the camera runs behind where the bars would be.
        // Swipe from an edge to bring the bars back for a moment.
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
        WindowCompat.setDecorFitsSystemWindows(window, false)
        // Don't let the screen sleep in the middle of a set.
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        // Debug builds can be inspected from chrome://inspect on the Mac.
        WebView.setWebContentsDebuggingEnabled(applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
        web = findViewById(R.id.web)
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.mediaPlaybackRequiresUserGesture = false
        web.addJavascriptInterface(Files(), "FlexAndCountAndroid")
        web.webViewClient = Client()
        web.webChromeClient = Chrome()
        onBackPressedDispatcher.addCallback(this, back)

        if (savedInstanceState == null || web.restoreState(savedInstanceState) == null) web.loadUrl(START_URL)

        // Ask for the camera up front, so the first tap on "Turn on camera" works straight away
        // (asking in the middle of the page's camera request left it hanging on first run).
        if (savedInstanceState == null && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            askCamera.launch(Manifest.permission.CAMERA)
        }
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
    }

    override fun onPause() {
        web.onPause()
        super.onPause()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    // Save logs: the page hands over a CSV and the app puts it in Downloads.
    // Only the Flex & Count page may call it.
    inner class Files {
        @JavascriptInterface
        fun saveFile(name: String, text: String) {
            runOnUiThread {
                if (isDestroyed) return@runOnUiThread
                val url = web.url?.let { Uri.parse(it) }
                if (url?.host != HOST) return@runOnUiThread
                val safeName = name.replace(Regex("[^A-Za-z0-9._-]"), "_").ifEmpty { "flex-and-count-logs.csv" }
                val saved = runCatching { writeToDownloads(safeName, text) }.getOrDefault(false)
                Toast.makeText(
                    this@MainActivity,
                    if (saved) getString(R.string.logs_saved, safeName) else getString(R.string.logs_not_saved),
                    Toast.LENGTH_LONG,
                ).show()
            }
        }
    }

    private fun writeToDownloads(name: String, text: String): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, "text/csv")
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            }
            val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return false
            contentResolver.openOutputStream(uri)?.use { it.write(text.toByteArray()) } ?: return false
            return true
        }
        // Android 8–9: the app's own Downloads folder (no storage permission needed).
        val dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: return false
        java.io.File(dir, name).writeText(text)
        return true
    }

    private inner class Client : WebViewClient() {
        // Stay in the app for Flex & Count pages; open anything else (GitHub, etc.) in the browser.
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url
            if (url.host == HOST && url.path.orEmpty().startsWith(PATH)) return false
            try {
                startActivity(Intent(Intent.ACTION_VIEW, url))
            } catch (_: ActivityNotFoundException) {
            }
            return true
        }
    }

    private inner class Chrome : WebChromeClient() {
        // The page asks for the camera: ask Android once, then pass the answer to the page.
        override fun onPermissionRequest(request: PermissionRequest) {
            runOnUiThread {
                val wantsCamera = request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)
                if (!wantsCamera || request.origin.host != HOST) {
                    request.deny()
                    return@runOnUiThread
                }
                if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                } else {
                    pendingCamera = request
                    askCamera.launch(Manifest.permission.CAMERA)
                }
            }
        }

        // "Use a video": open the phone's picker.
        override fun onShowFileChooser(
            webView: WebView,
            callback: ValueCallback<Array<Uri>>,
            params: FileChooserParams,
        ): Boolean {
            fileCallback?.onReceiveValue(null)
            fileCallback = callback
            return try {
                pickFile.launch(params.createIntent())
                true
            } catch (_: ActivityNotFoundException) {
                fileCallback = null
                false
            }
        }
    }

    companion object {
        private const val HOST = "naarrzz.github.io"
        private const val PATH = "/pose-estimation-bicep-curl-counter"
        private const val START_URL = "https://$HOST$PATH/"
    }
}
