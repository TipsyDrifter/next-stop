import java.io.File
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 36
    namespace = "app.shitetsu.nextstop"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "app.shitetsu.nextstop"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }

    // ── v1.1.0 D-1.1-8：release 自簽 keystore ──────────────────────────────
    // 私鑰檔與密碼由主人保管在 repo 之外（%LOCALAPPDATA%\Android\keystore\），**不進版控**；
    // 這裡按序找 keystore.properties：① 本模組同目錄（已在 gen/android/.gitignore）
    // ② %LOCALAPPDATA%\Android\keystore\（正本所在，Windows 主機）③ ~/.android/keystore/（他機備援）。
    // 找不到、或 storeFile 指到的檔不在 → release 退回 debug 簽章**而不是讓 build 炸掉**：
    // CI 與「只想確認編得過」的驗證跑得動，正式發版才需要真憑證（APK 能不能上機自己看得出來）。
    val keystorePropFile: File? = listOf(
        file("keystore.properties"),
        File(System.getenv("LOCALAPPDATA") ?: "", "Android/keystore/keystore.properties"),
        File(System.getProperty("user.home"), ".android/keystore/keystore.properties"),
    ).firstOrNull { it.exists() }

    val keystoreProperties = Properties().apply {
        keystorePropFile?.inputStream()?.use { load(it) }
    }
    val releaseStoreFile: File? = keystoreProperties.getProperty("storeFile")
        ?.let { file(it) }
        ?.takeIf { it.exists() }

    signingConfigs {
        create("release") {
            if (releaseStoreFile != null) {
                storeFile = releaseStoreFile
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            // 憑證在＝真簽章；不在＝退回 debug 簽章（見上面 signingConfigs 的理由）
            signingConfig = if (releaseStoreFile != null) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")