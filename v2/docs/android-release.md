# TradeSight 2.0 Android release

The v2 Android release is built by **TradeSight 2.0 Android Release**. This workflow builds from the `v2/` application, integrates the v2 native plugins and launcher icon, signs the APK with the permanent TradeSight release key, and verifies the signature and Android application ID before uploading it.

## Required GitHub Actions secrets

Configure these under **Repository Settings → Secrets and variables → Actions**:

- `ANDROID_KEYSTORE_BASE64`: the permanent release keystore encoded as Base64
- `ANDROID_KEYSTORE_PASSWORD`: keystore password
- `ANDROID_KEY_ALIAS`: alias of the release key
- `ANDROID_KEY_PASSWORD`: private-key password

The release workflow intentionally fails when any secret is missing. Do not commit the keystore, passwords, or private key into the repository. Use the same permanent keystore that must sign future TradeSight v2 updates; changing the signing certificate can prevent Android from installing an update over an existing signed installation.

## Build a release APK

1. Open GitHub **Actions**.
2. Select **TradeSight 2.0 Android Release**.
3. Choose **Run workflow** and select the desired branch.

The workflow produces `v2/android/app/build/outputs/apk/release/app-release.apk` and uploads it as the `TradeSight-v2-Android-release` artifact for 14 days.

A tagged release can also be created by pushing a tag named `tradesight-v2-v2.0.1` (replace the version as appropriate). The workflow uses the tag suffix as the Android version name and publishes the signed APK to the corresponding GitHub Release.

## Verification performed by the workflow

- Builds the current v2 web bundle and Capacitor Android project
- Copies the TradeSight native monitoring and secure-credential plugins
- Configures the permanent signing key without storing secrets in source
- Verifies the APK signature with Android `apksigner`
- Confirms the APK certificate matches the configured permanent keystore
- Confirms the application ID is `com.tradesight.mobile`
- Confirms the Android version code matches the GitHub Actions run number

The normal v2 CI workflow continues to build an unsigned debug APK for development and pull-request verification. A debug APK is not a substitute for the signed release artifact.
