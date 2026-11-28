const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const androidRoot = path.join(root, "android");
const appRoot = path.join(androidRoot, "app");
const javaRoot = path.join(appRoot, "src", "main", "java");
const manifestPath = path.join(appRoot, "src", "main", "AndroidManifest.xml");
const packagePath = path.join(javaRoot, "com", "tradesight", "mobile");
const nativeSource = path.join(root, "native", "android");
const pluginClasses = ["MarketMonitorPlugin", "SecureCredentialsPlugin"];

function fail(message) {
  console.error("[TradeSight Android]", message);
  process.exitCode = 1;
}

if (!fs.existsSync(androidRoot) || !fs.existsSync(manifestPath)) {
  fail("Android platform not found. Run npm run cap:add:android first.");
  return;
}

fs.mkdirSync(packagePath, { recursive: true });
for (const filename of [...pluginClasses.map((name) => name + ".java"), "MarketMonitorService.java"]) {
  fs.copyFileSync(path.join(nativeSource, filename), path.join(packagePath, filename));
}

let manifest = fs.readFileSync(manifestPath, "utf8");
const permissions = [
  "android.permission.FOREGROUND_SERVICE",
  "android.permission.FOREGROUND_SERVICE_DATA_SYNC",
  "android.permission.POST_NOTIFICATIONS",
  "android.permission.WAKE_LOCK",
];
for (const permission of permissions) {
  const declaration = '<uses-permission android:name="' + permission + '" />';
  if (!manifest.includes('android:name="' + permission + '"')) {
    manifest = manifest.replace("</manifest>", "    " + declaration + "\n</manifest>");
  }
}

if (!manifest.includes("com.tradesight.mobile.MarketMonitorService")) {
  const service = [
    "        <service",
    '            android:name="com.tradesight.mobile.MarketMonitorService"',
    '            android:enabled="true"',
    '            android:exported="false"',
    '            android:foregroundServiceType="dataSync" />',
  ].join("\n");
  manifest = manifest.replace("</application>", service + "\n    </application>");
}
// Generate native launcher icons from the TradeSight brand mark on every
// fresh Capacitor Android project. Capacitor's default placeholder icon is
// otherwise retained when the Android platform is generated in CI.
const resRoot = path.join(appRoot, "src", "main", "res");
const drawableRoot = path.join(resRoot, "drawable");
const mipmapAnyDpi = path.join(resRoot, "mipmap-anydpi");
const mipmapV21 = path.join(resRoot, "mipmap-anydpi-v21");
const mipmapAdaptive = path.join(resRoot, "mipmap-anydpi-v26");
const valuesRoot = path.join(resRoot, "values");
const densityMipmaps = ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"]
  .map((density) => path.join(resRoot, "mipmap-" + density));
for (const directory of [
  drawableRoot, mipmapAnyDpi, mipmapV21, mipmapAdaptive, valuesRoot, ...densityMipmaps,
]) {
  fs.mkdirSync(directory, { recursive: true });
}

const launcherForeground = `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:fillColor="#00000000"
        android:strokeColor="#8B5CF6"
        android:strokeWidth="4.2"
        android:strokeLineCap="round"
        android:strokeLineJoin="round"
        android:pathData="M13,72 C20,49 45,30 69,31 C83,31 94,41 88,54 C82,68 64,78 50,81" />
    <path
        android:fillColor="#F8F7FF"
        android:pathData="M16,24 H69 V36 H49 V79 H36 V36 H16 Z" />
    <path android:fillColor="#19D58A" android:pathData="M66,52 H74 V67 H66 Z" />
    <path android:fillColor="#19D58A" android:pathData="M69,44 H71 V73 H69 Z" />
    <path android:fillColor="#FF5267" android:pathData="M76,47 H84 V61 H76 Z" />
    <path android:fillColor="#FF5267" android:pathData="M79,40 H81 V68 H79 Z" />
    <path android:fillColor="#19D58A" android:pathData="M86,55 H94 V68 H86 Z" />
    <path android:fillColor="#19D58A" android:pathData="M89,43 H91 V75 H89 Z" />
</vector>
`;

const launcherLegacy = `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path android:fillColor="#080A14"
        android:pathData="M12,0 H96 Q108,0 108,12 V96 Q108,108 96,108 H12 Q0,108 0,96 V12 Q0,0 12,0 Z" />
    <path android:fillColor="#00000000" android:strokeColor="#8B5CF6"
        android:strokeWidth="4.2" android:strokeLineCap="round" android:strokeLineJoin="round"
        android:pathData="M13,72 C20,49 45,30 69,31 C83,31 94,41 88,54 C82,68 64,78 50,81" />
    <path android:fillColor="#F8F7FF" android:pathData="M16,24 H69 V36 H49 V79 H36 V36 H16 Z" />
    <path android:fillColor="#19D58A" android:pathData="M66,52 H74 V67 H66 Z" />
    <path android:fillColor="#19D58A" android:pathData="M69,44 H71 V73 H69 Z" />
    <path android:fillColor="#FF5267" android:pathData="M76,47 H84 V61 H76 Z" />
    <path android:fillColor="#FF5267" android:pathData="M79,40 H81 V68 H79 Z" />
    <path android:fillColor="#19D58A" android:pathData="M86,55 H94 V68 H86 Z" />
    <path android:fillColor="#19D58A" android:pathData="M89,43 H91 V75 H89 Z" />
</vector>
`;

const adaptiveIcon = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/tradesight_launcher_background" />
    <foreground android:drawable="@drawable/tradesight_launcher_foreground" />
</adaptive-icon>
`;

fs.writeFileSync(path.join(drawableRoot, "tradesight_launcher_foreground.xml"), launcherForeground);
fs.writeFileSync(path.join(drawableRoot, "tradesight_launcher_legacy.xml"), launcherLegacy);
fs.writeFileSync(
  path.join(valuesRoot, "tradesight_launcher_colors.xml"),
  `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="tradesight_launcher_background">#080A14</color>
</resources>
`,
);
for (const filename of ["ic_launcher.xml", "ic_launcher_round.xml"]) {
  // Adaptive icons are used by Android 8+; the same brand mark is used as
  // the vector fallback on Android 5–7 and on unqualified any-density devices.
  fs.writeFileSync(path.join(mipmapAdaptive, filename), adaptiveIcon);
  fs.writeFileSync(path.join(mipmapV21, filename), launcherLegacy);
  fs.writeFileSync(path.join(mipmapAnyDpi, filename), launcherLegacy);
}

// Capacitor ships density-specific PNGs named ic_launcher.png. Android picks
// those over an anydpi XML resource, which silently leaves its blue X in place.
// Replace every density-specific launcher PNG with our TradeSight vector XML.
for (const directory of densityMipmaps) {
  for (const staleFilename of [
    "ic_launcher.png",
    "ic_launcher_round.png",
    "ic_launcher_foreground.png",
  ]) {
    const stalePath = path.join(directory, staleFilename);
    if (fs.existsSync(stalePath)) fs.unlinkSync(stalePath);
  }
  fs.writeFileSync(path.join(directory, "ic_launcher.xml"), launcherLegacy);
  fs.writeFileSync(path.join(directory, "ic_launcher_round.xml"), launcherLegacy);
}

// Fail the Android build if any Capacitor density-specific placeholder survives.
for (const directory of densityMipmaps) {
  for (const filename of ["ic_launcher.xml", "ic_launcher_round.xml"]) {
    if (!fs.existsSync(path.join(directory, filename))) {
      fail("TradeSight launcher icon is missing: " + path.relative(resRoot, path.join(directory, filename)));
      return;
    }
  }
  for (const filename of ["ic_launcher.png", "ic_launcher_round.png", "ic_launcher_foreground.png"]) {
    if (fs.existsSync(path.join(directory, filename))) {
      fail("Default Capacitor launcher asset was not removed: " + path.relative(resRoot, path.join(directory, filename)));
      return;
    }
  }
}

const applicationTag = manifest.match(/<application\b[^>]*>/);
if (!applicationTag) {
  fail("Could not locate the Android application manifest element to set the launcher icon.");
  return;
}
let applicationAttributes = applicationTag[0];
for (const [name, value] of [
  ["android:icon", "@mipmap/ic_launcher"],
  ["android:roundIcon", "@mipmap/ic_launcher_round"],
]) {
  const attribute = new RegExp(" " + name + '="[^"]*"');
  if (attribute.test(applicationAttributes)) {
    applicationAttributes = applicationAttributes.replace(attribute, " " + name + '="' + value + '"');
  } else {
    applicationAttributes = applicationAttributes.replace(/>$/, " " + name + '="' + value + '">');
  }
}
manifest = manifest.replace(applicationTag[0], applicationAttributes);
fs.writeFileSync(manifestPath, manifest);

function findMainActivity(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = findMainActivity(full);
      if (found) return found;
    } else if (entry.name === "MainActivity.java" || entry.name === "MainActivity.kt") {
      return full;
    }
  }
  return null;
}

const mainActivityPath = findMainActivity(javaRoot);
if (!mainActivityPath) {
  fail("Could not locate generated MainActivity.java. Register native TradeSight plugins manually.");
  return;
}

let activity = fs.readFileSync(mainActivityPath, "utf8");
if (!activity.includes("extends BridgeActivity")) {
  fail("Generated MainActivity is not a Java BridgeActivity; register native TradeSight plugins manually.");
  return;
}

const packageLine = activity.match(/^package\s+[^;]+;/m);
for (const pluginName of pluginClasses) {
  const importLine = "import com.tradesight.mobile." + pluginName + ";";
  if (packageLine && !activity.includes(importLine)) {
    activity = activity.replace(packageLine[0], packageLine[0] + "\n\n" + importLine);
  }
}

const missingRegistrations = pluginClasses.filter((name) => !activity.includes(name + ".class"));
if (missingRegistrations.length > 0) {
  const registrations = missingRegistrations
    .map((name) => "        registerPlugin(" + name + ".class);")
    .join("\n");
  const onCreatePattern = /onCreate\(Bundle savedInstanceState\)\s*\{/;
  if (onCreatePattern.test(activity)) {
    activity = activity.replace(onCreatePattern, (match) => match + "\n" + registrations);
  } else {
    activity = activity.replace(
      /extends BridgeActivity\s*\{/,
      "extends BridgeActivity {\n    @Override\n    public void onCreate(android.os.Bundle savedInstanceState) {\n" +
        registrations + "\n        super.onCreate(savedInstanceState);\n    }"
    );
  }
}
fs.writeFileSync(mainActivityPath, activity);

console.log("[TradeSight Android] Foreground monitor and secure credential plugins integrated.");
