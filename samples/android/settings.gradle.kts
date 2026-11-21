pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "subetha-doorbell"
include(":app")

// Use the SDK from this repo: org.subetha:subetha resolves to sdk/kotlin/subetha.
includeBuild("../../sdk/kotlin")
