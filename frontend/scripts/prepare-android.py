#!/usr/bin/env python3
"""Prepare TradeSight Android launcher icons and the no-icon native launch theme."""
from pathlib import Path
import re
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ANDROID = ROOT / "android"
RES = ANDROID / "app" / "src" / "main" / "res"
SOURCE = ROOT / "public" / "tradesight-app-icon-512.png"
BACKGROUND = "#020B15"

if not ANDROID.exists():
    raise SystemExit("Android project not found. Run 'npx cap add android' first.")
if not SOURCE.exists():
    raise SystemExit(f"Missing launcher artwork: {SOURCE}")

artwork = Image.open(SOURCE).convert("RGBA")
densities = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}

for density, legacy_size in densities.items():
    folder = RES / f"mipmap-{density}"
    folder.mkdir(parents=True, exist_ok=True)
    legacy = artwork.resize((legacy_size, legacy_size), Image.Resampling.LANCZOS)
    legacy.save(folder / "ic_launcher.png", optimize=True)
    legacy.save(folder / "ic_launcher_round.png", optimize=True)
    adaptive_size = int(legacy_size * 2.25)
    safe_size = int(adaptive_size * 0.66)
    foreground = Image.new("RGBA", (adaptive_size, adaptive_size), (0, 0, 0, 0))
    safe_art = artwork.resize((safe_size, safe_size), Image.Resampling.LANCZOS)
    foreground.alpha_composite(safe_art, ((adaptive_size-safe_size)//2, (adaptive_size-safe_size)//2))
    foreground.save(folder / "ic_launcher_foreground.png", optimize=True)

adaptive = RES / "mipmap-anydpi-v26"
adaptive.mkdir(parents=True, exist_ok=True)
adaptive_xml = """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/tradesight_icon_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
"""
(adaptive / "ic_launcher.xml").write_text(adaptive_xml, encoding="utf-8")
(adaptive / "ic_launcher_round.xml").write_text(adaptive_xml, encoding="utf-8")

values = RES / "values"
values.mkdir(parents=True, exist_ok=True)
colors = values / "colors.xml"
if colors.exists():
    color_text = colors.read_text(encoding="utf-8")
    if "tradesight_icon_background" not in color_text:
        color_text = color_text.replace(
            "</resources>",
            f'    <color name="tradesight_icon_background">{BACKGROUND}</color>\n</resources>',
        )
else:
    color_text = f'''<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="tradesight_icon_background">{BACKGROUND}</color>
</resources>
'''
colors.write_text(color_text, encoding="utf-8")

drawable = RES / "drawable"
drawable.mkdir(parents=True, exist_ok=True)
(drawable / "tradesight_splash_blank.xml").write_text("""<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="1dp" android:height="1dp"
    android:viewportWidth="1" android:viewportHeight="1">
    <path android:fillColor="#00000000" android:pathData="M0,0h1v1h-1z" />
</vector>
""", encoding="utf-8")

styles = values / "styles.xml"
if not styles.exists():
    raise SystemExit("Capacitor styles.xml was not generated.")
style_text = styles.read_text(encoding="utf-8")
launch_style = f'''<style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">
        <item name="android:background">{BACKGROUND}</item>
        <item name="windowSplashScreenBackground">{BACKGROUND}</item>
        <item name="windowSplashScreenAnimatedIcon">@drawable/tradesight_splash_blank</item>
        <item name="postSplashScreenTheme">@style/AppTheme.NoActionBar</item>
    </style>'''
pattern = r'<style name="AppTheme\.NoActionBarLaunch"[^>]*>.*?</style>'
if re.search(pattern, style_text, flags=re.S):
    style_text = re.sub(pattern, launch_style, style_text, count=1, flags=re.S)
else:
    style_text = style_text.replace("</resources>", f"    {launch_style}\n</resources>")
styles.write_text(style_text, encoding="utf-8")

v31 = RES / "values-v31"
v31.mkdir(parents=True, exist_ok=True)
(v31 / "styles.xml").write_text(f'''<?xml version="1.0" encoding="utf-8"?>
<resources>
    <style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">
        <item name="android:background">{BACKGROUND}</item>
        <item name="android:windowBackground">{BACKGROUND}</item>
        <item name="windowSplashScreenBackground">{BACKGROUND}</item>
        <item name="windowSplashScreenAnimatedIcon">@drawable/tradesight_splash_blank</item>
        <item name="postSplashScreenTheme">@style/AppTheme.NoActionBar</item>
        <item name="android:windowSplashScreenBackground">{BACKGROUND}</item>
        <item name="android:windowSplashScreenAnimatedIcon">@drawable/tradesight_splash_blank</item>
    </style>
</resources>
''', encoding="utf-8")

manifest = ANDROID / "app" / "src" / "main" / "AndroidManifest.xml"
manifest_text = manifest.read_text(encoding="utf-8")
manifest_text = re.sub(r'android:icon="[^"]+"', 'android:icon="@mipmap/ic_launcher"', manifest_text)
if 'android:roundIcon=' in manifest_text:
    manifest_text = re.sub(r'android:roundIcon="[^"]+"', 'android:roundIcon="@mipmap/ic_launcher_round"', manifest_text)
else:
    manifest_text = manifest_text.replace(
        'android:icon="@mipmap/ic_launcher"',
        'android:icon="@mipmap/ic_launcher" android:roundIcon="@mipmap/ic_launcher_round"', 1,
    )
manifest.write_text(manifest_text, encoding="utf-8")
print("TradeSight Android icon and transparent launch theme prepared.")
