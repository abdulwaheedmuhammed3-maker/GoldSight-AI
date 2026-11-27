const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const androidRoot = path.join(root, "android");
const appRoot = path.join(androidRoot, "app");
const javaRoot = path.join(appRoot, "src", "main", "java");
const manifestPath = path.join(appRoot, "src", "main", "AndroidManifest.xml");
const packagePath = path.join(javaRoot, "com", "tradesight", "mobile");
const nativeSource = path.join(root, "native", "android");

function fail(message) {
  console.error("[TradeSight Android]", message);
  process.exitCode = 1;
}

if (!fs.existsSync(androidRoot) || !fs.existsSync(manifestPath)) {
  fail("Android platform not found. Run npm run cap:add:android first.");
  return;
}

fs.mkdirSync(packagePath, { recursive: true });
for (const filename of ["MarketMonitorPlugin.java", "MarketMonitorService.java"]) {
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
    '        <service',
    '            android:name="com.tradesight.mobile.MarketMonitorService"',
    '            android:enabled="true"',
    '            android:exported="false"',
    '            android:foregroundServiceType="dataSync" />',
  ].join("\n");
  manifest = manifest.replace("</application>", service + "\n    </application>");
}
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
  fail("Could not locate generated MainActivity.java. Add MarketMonitorPlugin to registerPlugin() manually.");
  return;
}

let activity = fs.readFileSync(mainActivityPath, "utf8");
if (!activity.includes("MarketMonitorPlugin.class")) {
  const packageLine = activity.match(/^package\s+[^;]+;/m);
  if (packageLine && !activity.includes("import com.tradesight.mobile.MarketMonitorPlugin;")) {
    activity = activity.replace(packageLine[0], packageLine[0] + "\n\nimport com.tradesight.mobile.MarketMonitorPlugin;");
  }
  if (activity.includes("extends BridgeActivity")) {
    if (activity.includes("void onCreate(")) {
      activity = activity.replace(
        /void onCreate\(Bundle savedInstanceState\)\s*\{/,
        "void onCreate(Bundle savedInstanceState) {\n        registerPlugin(MarketMonitorPlugin.class);"
      );
    } else {
      activity = activity.replace(
        /extends BridgeActivity\s*\{/,
        "extends BridgeActivity {\n    @Override\n    public void onCreate(android.os.Bundle savedInstanceState) {\n        registerPlugin(MarketMonitorPlugin.class);\n        super.onCreate(savedInstanceState);\n    }"
      );
    }
  } else {
    fail("Generated MainActivity is not a Java BridgeActivity; register MarketMonitorPlugin manually.");
    return;
  }
  fs.writeFileSync(mainActivityPath, activity);
}

console.log("[TradeSight Android] Foreground market-monitor service integrated.");
