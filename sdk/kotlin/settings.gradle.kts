rootProject.name = "subetha-kotlin"

pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositories {
        mavenCentral()
    }
}

// org.subetha:subetha       pure-Kotlin client (JVM + Android), no native code
// org.subetha:subetha-core  UniFFI bindings to the Rust core (JNA + libsubetha_core)
include("subetha", "subetha-core")
