#!/usr/bin/env python3
"""Wire TradeSight's optional floating overlay into the generated Capacitor Android project."""
from pathlib import Path
import re
import shutil
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
ANDROID = ROOT / "android"
NATIVE = ROOT / "android-native"
JAVA = ANDROID / "app/src/main/java/com/tradesight/app"
MANIFEST = ANDROID / "app/src/main/AndroidManifest.xml"

if not ANDROID.exists() or not MANIFEST.exists():
    raise SystemExit("Generated Android project or manifest is missing.")
JAVA.mkdir(parents=True, exist_ok=True)
for name in ("TradeSightOverlayPlugin.java", "TradeSightOverlayService.java"):
    shutil.copy2(NATIVE / name, JAVA / name)

activity = JAVA / "MainActivity.java"
if not activity.exists():
    matches = list((ANDROID / "app/src/main/java").rglob("MainActivity.java"))
    if not matches:
        raise SystemExit("Could not find Capacitor MainActivity.java")
    activity = matches[0]
src = activity.read_text(encoding="utf-8")
if "TradeSightOverlayPlugin" not in src:
    src = re.sub(r"(import com\\.getcapacitor\\.BridgeActivity;)",
                 r"\\1\\nimport com.tradesight.app.TradeSightOverlayPlugin;", src)
    src = re.sub(r"(public class MainActivity extends BridgeActivity \\{)",
                 r"\\1\\n    @Override\\n    public void onCreate(android.os.Bundle savedInstanceState) {\\n        registerPlugin(TradeSightOverlayPlugin.class);\\n        super.onCreate(savedInstanceState);\\n    }", src)
activity.write_text(src, encoding="utf-8")

ET.register_namespace("android", "http://schemas.android.com/apk/res/android")
ns = "{http://schemas.android.com/apk/res/android}"
tree = ET.parse(MANIFEST)
root = tree.getroot()
permissions = {
    "android.permission.SYSTEM_ALERT_WINDOW",
    "android.permission.FOREGROUND_SERVICE",
    "android.permission.FOREGROUND_SERVICE_SPECIAL_USE",
}
existing = {p.get(ns+"name") for p in root.findall("uses-permission")}
for permission in permissions - existing:
    ET.SubElement(root, "uses-permission", {ns+"name": permission})
app = root.find("application")
if app is None:
    raise SystemExit("Manifest application element missing.")
services = [s for s in app.findall("service") if s.get(ns+"name") == ".TradeSightOverlayService"]
if not services:
    service = ET.SubElement(app, "service", {
        ns+"name": ".TradeSightOverlayService",
        ns+"exported": "false",
        ns+"foregroundServiceType": "specialUse",
    })
    prop = ET.SubElement(service, "property", {
        ns+"name": "android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE",
        ns+"value": "User-enabled floating trading information panel displayed over other apps.",
    })
tree.write(MANIFEST, encoding="utf-8", xml_declaration=True)
print("TradeSight overlay plugin, service and Android permissions configured.")
