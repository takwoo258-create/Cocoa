package com.sandsalt.cocoa

import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private val channelName = "cocoa/native"

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
                            manager.enqueue(request)
                            result.success(true)
                        } catch (_: Exception) {
                            result.success(false)
                        }
                    }
                    else -> result.notImplemented()
                }
            }
    }
}
