plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
}

val apiUrl = providers.gradleProperty("uic.apiUrl")
val releaseApiUrl = apiUrl.orElse(providers.gradleProperty("uic.releaseApiUrl"))

android {
    namespace = "com.usaindiacfo.uicrecorder"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.usaindiacfo.uicrecorder"
        minSdk = 26
        targetSdk = 37
        versionCode = 2
        versionName = "0.2.0"
        // Set in ~/.gradle/gradle.properties or with -P; the web OAuth client ID is the token audience.
        buildConfigField("String", "GOOGLE_WEB_CLIENT_ID", "\"${providers.gradleProperty("uic.googleWebClientId").getOrElse("")}\"")
    }

    // Release key lives outside the repo; path + password come from ~/.gradle/gradle.properties.
    val keystorePath = providers.gradleProperty("uic.keystore").orNull
    val keystorePassword = providers.gradleProperty("uic.keystorePassword").orNull
    signingConfigs {
        if (keystorePath != null && keystorePassword != null) {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = keystorePassword
                keyAlias = "uic"
                keyPassword = keystorePassword
            }
        }
    }
    buildTypes {
        debug {
            buildConfigField("String", "API_URL", "\"${apiUrl.getOrElse("http://localhost:8000")}\"")
        }
        release {
            buildConfigField("String", "API_URL", "\"${releaseApiUrl.getOrElse("")}\"")
            signingConfig = signingConfigs.findByName("release")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        // Release-like build for :baselineprofile (Macrobenchmark). Debug-signed, never distributed.
        create("benchmark") {
            initWith(getByName("release"))
            signingConfig = signingConfigs.getByName("debug")
            matchingFallbacks += "release"
            isDebuggable = false
            proguardFiles("benchmark-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

// Release builds must point at an https server; the http fallback is debug-only.
tasks.matching { it.name == "preReleaseBuild" }.configureEach {
    val url = releaseApiUrl.orNull
    doFirst {
        if (url == null || !url.startsWith("https://")) {
            throw GradleException("Release builds need -Puic.apiUrl=https://... (got: ${url ?: "nothing"})")
        }
    }
}

ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
}

dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons)
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.navigation.compose)
    implementation(libs.paging.runtime)
    implementation(libs.paging.compose)
    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    implementation(libs.room.paging)
    ksp(libs.room.compiler)
    implementation(libs.work.runtime)
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.datasource.okhttp)
    implementation(libs.media3.transformer)
    implementation(libs.credentials)
    implementation(libs.credentials.play)
    implementation(libs.googleid)
    implementation(libs.datastore)
    implementation(libs.okhttp)
    implementation(libs.serialization.json)
    implementation(libs.profileinstaller)
    implementation(libs.tink.android)
    // Only to migrate tokens from the old EncryptedSharedPreferences file (TokenStore.migrateLegacy).
    implementation(libs.security.crypto)
    debugImplementation(libs.compose.ui.tooling)
    testImplementation(libs.junit)
    testImplementation(libs.okhttp.mockwebserver)
}
