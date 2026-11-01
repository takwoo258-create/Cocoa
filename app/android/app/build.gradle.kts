import java.util.Properties

// Android 7.0+（API 24）：Flutter 3.47 与 image_picker_android / shared_preferences_android /
// flutter_plugin_android_lifecycle 均要求 minSdk ≥ 24，与 Flutter 默认值一致。
val cocoaMinSdk = 24

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
