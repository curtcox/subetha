import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    kotlin("jvm")
    `java-library`
    `maven-publish`
}

java {
    sourceCompatibility = JavaVersion.VERSION_11
    targetCompatibility = JavaVersion.VERSION_11
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_11) }
}

dependencies {
    api(project(":subetha"))
    // Android apps should depend on "net.java.dev.jna:jna:5.15.0@aar" instead (see README).
    api("net.java.dev.jna:jna:5.15.0")

    testImplementation(kotlin("test"))
    testImplementation(platform("org.junit:junit-bom:5.11.3"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

// The tests load libsubetha_core from the Cargo target dir (build it with
// `cargo build -p subetha-core --features uniffi`, or sdk/core/scripts/gen-bindings.sh).
// Override with -Psubetha.core.lib=/path/to/dir. Without the library the tests are skipped.
val repoRoot = rootDir.resolve("../..").canonicalFile
val coreLibDir = (findProperty("subetha.core.lib") as String?) ?: repoRoot.resolve("target/debug").path

tasks.test {
    useJUnitPlatform()
    systemProperty("jna.library.path", coreLibDir)
    systemProperty("subetha.vectors", repoRoot.resolve("spec/vectors").path)
    testLogging {
        events("failed", "skipped")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}

publishing {
    publications {
        create<MavenPublication>("maven") {
            artifactId = "subetha-core"
            from(components["java"])
        }
    }
}
