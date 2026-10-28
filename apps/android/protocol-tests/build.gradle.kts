plugins {
    kotlin("jvm") version "2.0.21"
    kotlin("plugin.serialization") version "2.0.21"
}
repositories { mavenCentral() }
kotlin { jvmToolchain(17) }

// Compile the production protocol/state sources directly. This standalone target
// intentionally excludes Android/Compose so lifecycle tests can run without an SDK.
sourceSets {
    main {
        kotlin.srcDir("../app/src/main/java")
        kotlin.include("**/ResourceRequests.kt", "**/Dtos.kt", "**/Artifacts.kt", "**/ArtifactController.kt")
    }
    test {
        kotlin.srcDir("../app/src/test/java")
        kotlin.include("**/ResourceRequestsTest.kt", "**/ArtifactControllerTest.kt")
    }
}
dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
}
