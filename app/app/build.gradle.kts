import java.io.File
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// 拆包开关：-PellenAbiSplit=true 时按 ABI 出两个包（真机省 36 MB）。
// ndk.abiFilters 与 splits.abi 不能共存，同时写会报 Conflicting configuration。
val abiSplit = (project.findProperty("ellenAbiSplit") as String?) == "true"

// 正式签名：口令写在 _build\keystore\keystore.properties（不在 git 里）。
// 没有这个文件时退回 debug 签名 —— 换台机器 / 别人 clone 下来照样能构建，不会因为缺密钥直接失败。
val keystoreDir = rootProject.file("../_build/keystore")
val keystorePropsFile = File(keystoreDir, "keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.exists()) keystorePropsFile.inputStream().use { load(it) }
}

android {
    namespace = "cn.ellen.companion2"
    compileSdk = 36

    defaultConfig {
        applicationId = "cn.ellen.companion2"
        minSdk = 24
        targetSdk = 36
        versionCode = 2
        versionName = "0.3.1"
        if (!abiSplit) {
            ndk {
                abiFilters += listOf("arm64-v8a", "x86_64")
            }
        }
    }

    splits {
        abi {
            isEnable = abiSplit
            reset()
            include("arm64-v8a", "x86_64")
            isUniversalApk = false
        }
    }

    signingConfigs {
        if (keystorePropsFile.exists()) {
            create("release") {
                storeFile = File(keystoreDir, keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = false
            // 有正式签名就用它；没有就退回 debug，保证任何环境都能出包
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }

    kotlinOptions {
        jvmTarget = "21"
    }

    androidResources {
        // sherpa-onnx 走 AAssetManager 拿文件描述符，onnx 被 aapt 压过就读不了
        noCompress += listOf("onnx")
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.11.0")
    implementation("androidx.fragment:fragment-ktx:1.8.9")
    implementation("com.capacitorjs:core:8.6.0")
    implementation("com.capacitorjs:app:8.1.1")
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("androidx.work:work-runtime-ktx:2.10.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    // 离线语音识别（streaming zipformer 中文 14M int8）
    implementation(files("libs/sherpa-onnx-2.0.1.aar"))
}
