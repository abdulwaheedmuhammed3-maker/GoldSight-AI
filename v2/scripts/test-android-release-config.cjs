const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tradesight-android-release-test-"));

try {
  const scriptsDir = path.join(tempRoot, "scripts");
  const androidAppDir = path.join(tempRoot, "android", "app");
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(androidAppDir, { recursive: true });

  const helperSource = path.join(__dirname, "configure-android-release.cjs");
  const helperCopy = path.join(scriptsDir, "configure-android-release.cjs");
  fs.copyFileSync(helperSource, helperCopy);

  const keystoreFixture = path.join(tempRoot, "fixture-release-key.jks");
  fs.writeFileSync(keystoreFixture, "not a real keystore; path-existence fixture only");

  const gradlePath = path.join(androidAppDir, "build.gradle");
  fs.writeFileSync(gradlePath, `plugins {
    id "com.android.application"
}

android {
    namespace "com.tradesight.mobile"

    defaultConfig {
        applicationId "com.tradesight.mobile"
        minSdkVersion 23
        targetSdkVersion 36
        versionCode 1
        versionName "1.0"
    }

    signingConfigs {
        debug {
            storeFile file("debug.keystore")
            storePassword "android"
            keyAlias "androiddebugkey"
            keyPassword "android"
        }
    }

    buildTypes {
        release {
            minifyEnabled false
        }
    }
}
`);

  const env = {
    ...process.env,
    ANDROID_KEYSTORE_PATH: keystoreFixture,
    ANDROID_KEYSTORE_PASSWORD: "fixture-store-password",
    ANDROID_KEY_ALIAS: "tradesight-release",
    ANDROID_KEY_PASSWORD: "fixture-key-password",
    ANDROID_VERSION_CODE: "314",
    ANDROID_VERSION_NAME: "2.0.314",
  };

  const firstRun = spawnSync(process.execPath, [helperCopy], {
    encoding: "utf8",
    env,
  });
  assert.equal(firstRun.status, 0, firstRun.stderr || firstRun.stdout);

  let gradle = fs.readFileSync(gradlePath, "utf8");
  assert.match(gradle, /versionCode 314/);
  assert.match(gradle, /versionName "2\.0\.314"/);
  assert.match(gradle, /debug\s*\{[\s\S]*?storePassword "android"/);
  assert.match(gradle, /release\s*\{[\s\S]*?storeFile file\(System\.getenv\("ANDROID_KEYSTORE_PATH"\)\)/);
  assert.match(gradle, /signingConfig signingConfigs\.release/);
  assert.match(gradle, /storePassword System\.getenv\("ANDROID_KEYSTORE_PASSWORD"\)/);

  // Re-running the helper must not duplicate release signing blocks or lines.
  const secondRun = spawnSync(process.execPath, [helperCopy], {
    encoding: "utf8",
    env,
  });
  assert.equal(secondRun.status, 0, secondRun.stderr || secondRun.stdout);
  gradle = fs.readFileSync(gradlePath, "utf8");
  assert.equal((gradle.match(/storeFile file\(System\.getenv\("ANDROID_KEYSTORE_PATH"\)\)/g) || []).length, 1);
  assert.equal((gradle.match(/signingConfig signingConfigs\.release/g) || []).length, 1);

  console.log("Android release signing helper fixture tests passed.");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
