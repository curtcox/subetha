plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "org.subetha.sample.doorbell"
    compileSdk = 35

    defaultConfig {
        applicationId = "org.subetha.sample.doorbell"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    buildFeatures { compose = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("org.subetha:subetha:0.1.0")
    // The Rust core (edge transports, signatures, E2EE) through UniFFI/JNA. The app runs without
    // libsubetha_core.so in src/main/jniLibs; the Edge tab then explains how to add it.
    implementation("org.subetha:subetha-core:0.1.0") { exclude(group = "net.java.dev.jna", module = "jna") }
    implementation("net.java.dev.jna:jna:5.15.0@aar")
    implementation("androidx.core:core-ktx:1.15.0")

    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
}
