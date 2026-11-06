package com.sandsalt.cocoa

import android.app.Activity
import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.io.FileOutputStream

class MainActivity : FlutterActivity() {
    private val channelName = "cocoa/native"
    private var fontResult: MethodChannel.Result? = null
    private val fontRequest = 1201
    private var downloadId: Long = -1
    private var downloadReceiverRegistered = false
    private val downloadReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != DownloadManager.ACTION_DOWNLOAD_COMPLETE) return
            val id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1)
            if (downloadId <= 0 || id != downloadId) return
            try {
                val dm = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
                val uri = dm.getUriForDownloadedFile(id)
                if (uri == null) return
                val install = Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(uri, "application/vnd.android.package-archive")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                startActivity(install)
            } catch (_: Exception) {
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun registerDownloadReceiver() {
        if (downloadReceiverRegistered) return
        val filter = IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE)
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(downloadReceiver, filter, Context.RECEIVER_EXPORTED)
        } else {
            registerReceiver(downloadReceiver, filter)
        }
        downloadReceiverRegistered = true
    }

    override fun onDestroy() {
        if (downloadReceiverRegistered) {
            try {
                unregisterReceiver(downloadReceiver)
            } catch (_: Exception) {
            }
            downloadReceiverRegistered = false
        }
        super.onDestroy()
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "openUrl" -> {
                        val url = call.argument<String>("url")
                        if (url.isNullOrBlank()) {
                            result.success(false)
                            return@setMethodCallHandler
                        }
                        try {
                            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            startActivity(intent)
                            result.success(true)
                        } catch (_: Exception) {
                            result.success(false)
                        }
                    }
                    "downloadApk" -> {
                        val url = call.argument<String>("url")
                        val filename = call.argument<String>("filename") ?: "cocoa-update.apk"
                        if (url.isNullOrBlank()) {
                            result.success(false)
                            return@setMethodCallHandler
                        }
                        try {
                            val request = DownloadManager.Request(Uri.parse(url))
                                .setTitle(filename)
                                .setDescription("Cocoa 更新下载")
                                .setMimeType("application/vnd.android.package-archive")
                                .setNotificationVisibility(
                                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED
                                )
                            val manager =
                                getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
                            registerDownloadReceiver()
                            downloadId = manager.enqueue(request)
                            result.success(true)
                        } catch (_: Exception) {
                            result.success(false)
                        }
                    }
                    "pickFont" -> {
                        try {
                            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                                addCategory(Intent.CATEGORY_OPENABLE)
                                type = "*/*"
                                putExtra(
                                    Intent.EXTRA_MIME_TYPES,
                                    arrayOf(
                                        "font/ttf",
                                        "font/otf",
                                        "application/x-font-ttf",
                                        "application/octet-stream"
                                    )
                                )
                            }
                            fontResult = result
                            startActivityForResult(intent, fontRequest)
                        } catch (_: Exception) {
                            fontResult = null
                            result.success(null)
                        }
                    }
                    else -> result.notImplemented()
                }
            }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != fontRequest) return
        val result = fontResult
        fontResult = null
        if (resultCode != Activity.RESULT_OK || data?.data == null) {
            result?.success(null)
            return
        }
        try {
            val uri = data.data!!
            val dir = File(filesDir, "fonts").apply { mkdirs() }
            val name = "imported_" + System.currentTimeMillis() + ".ttf"
            val out = File(dir, name)
            contentResolver.openInputStream(uri)?.use { input ->
                FileOutputStream(out).use { output -> input.copyTo(output) }
            }
            result?.success(out.absolutePath)
        } catch (_: Exception) {
            result?.success(null)
        }
    }
}
