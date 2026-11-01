import java.util.Properties

// 产品要求 minSdk 23；Flutter 3.47 默认 24，且 flutter tool 会把字面量 `minSdk = 23` 重写为
// `flutter.minSdkVersion`，这里用脚本变量绕开该迁移（Gradle 校验器 error 阈值为 <23，23 仅告警）。
val cocoaMinSdk = 23

// cocoa-keystore：从 android/key.properties（不入库）读取 release 签名；文件缺失时回落 debug 签名
val cocoaKeyProps = Properties().apply {
    val f = rootProject.file("key.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
val cocoaKeystoreFile: java.io.File? = cocoaKeyProps.getProperty("storeFile")?.let { file(it) }
val hasCocoaKeystore = cocoaKeystoreFile?.exists() == true

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    signingConfigs {
        if (hasCocoaKeystore) {
            create("cocoa") {
                storeFile = cocoaKeystoreFile
                storePassword = cocoaKeyProps.getProperty("storePassword")
                keyAlias = cocoaKeyProps.getProperty("keyAlias")
                keyPassword = cocoaKeyProps.getProperty("keyPassword")
            }
        }
    }

    namespace = "com.sandsalt.cocoa"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "com.sandsalt.cocoa"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = cocoaMinSdk
        targetSdk = 35
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    buildTypes {
        release {
            // TODO: Add your own signing config for the release build.
            // Signing with the debug keys for now, so `flutter run --release` works.
            signingConfig = if (hasCocoaKeystore) signingConfigs.getByName("cocoa") else signingConfigs.getByName("debug")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
