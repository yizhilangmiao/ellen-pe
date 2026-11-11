plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// 拆包开关：-PellenAbiSplit=true 时按 ABI 出两个包（真机省 36 MB）。
// ndk.abiFilters 与 splits.abi 不能共存，同时写会报 Conflicting configuration。
val abiSplit = (project.findProperty("ellenAbiSplit") as String?) == "true"

android {
    namespace = "cn.ellen.companion2"
    compileSdk = 36

    defaultConfig {
        applicationId = "cn.ellen.companion2"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "0.3.0-m7"
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

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = false
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
