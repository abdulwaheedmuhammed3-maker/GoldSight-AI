#!/usr/bin/env python3
"""Configure the generated Capacitor Android app for a signed release build."""
from pathlib import Path
import os
import re

gradle = Path("android/app/build.gradle")
if not gradle.exists():
    raise SystemExit(f"Missing generated Gradle file: {gradle}")

text = gradle.read_text(encoding="utf-8")

if not ("signingConfigs {" in text and "signingConfig signingConfigs.release" in text):
    signing_block = """
    signingConfigs {
        release {
            storeFile file(System.getenv("ANDROID_KEYSTORE_PATH"))
            storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")
            keyAlias System.getenv("ANDROID_KEY_ALIAS")
            keyPassword System.getenv("ANDROID_KEY_PASSWORD")
        }
    }

"""
    marker = re.search(r"(?m)^\s*buildTypes\s*\{", text)
    if not marker:
        raise SystemExit("Could not locate buildTypes block in generated app/build.gradle")
    text = text[:marker.start()] + signing_block + text[marker.start():]

# Find the release block specifically inside buildTypes, not signingConfigs.
build_types = re.search(r"(?m)^\s*buildTypes\s*\{", text)
if not build_types:
    raise SystemExit("Could not locate buildTypes block in generated app/build.gradle")
release_match = re.search(
    r"(?ms)(^\s*release\s*\{)(.*?)(^\s*\})",
    text[build_types.end():],
)
if not release_match:
    raise SystemExit("Could not locate release build type inside buildTypes")
body_start = build_types.end() + release_match.start(2)
body_end = build_types.end() + release_match.end(2)
body = text[body_start:body_end]
if "signingConfig signingConfigs.release" not in body:
    body = "\n            signingConfig signingConfigs.release" + body
    text = text[:body_start] + body + text[body_end:]

version_code = os.environ.get("ANDROID_VERSION_CODE")
if version_code:
    text, count = re.subn(
        r"(?m)(^\s*versionCode\s+)\d+",
        rf"\g<1>{int(version_code)}",
        text,
        count=1,
    )
    if count == 0:
        raise SystemExit("Could not find versionCode in generated app/build.gradle")

version_name = os.environ.get("ANDROID_VERSION_NAME")
if version_name:
    escaped = version_name.replace("\\", "\\\\").replace('"', '\\"')
    text, count = re.subn(
        r'(?m)(^\s*versionName\s+)[^\n]+',
        rf'\g<1>"{escaped}"',
        text,
        count=1,
    )
    if count == 0:
        raise SystemExit("Could not find versionName in generated app/build.gradle")

gradle.write_text(text, encoding="utf-8")
print("Configured signed Android release build.")
