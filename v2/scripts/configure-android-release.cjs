const fs = require("node:fs");
const path = require("node:path");

function fail(message) {
  console.error("[TradeSight Android release]", message);
  process.exit(1);
}

function findBlock(source, name, fromIndex = 0) {
  const pattern = new RegExp("\\b" + name + "\\s*\\{", "m");
  const match = pattern.exec(source.slice(fromIndex));
  if (!match) return null;
  const absoluteStart = fromIndex + match.index;
  const openBrace = source.indexOf("{", absoluteStart);
  return { start: absoluteStart, openBrace };
}

function matchingBrace(source, openBrace) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = openBrace; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error("Unbalanced Gradle block; refusing to modify the generated Android project.");
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) throw new Error("Missing required environment variable " + name + ".");
  return value.trim();
}

try {
  const root = path.resolve(__dirname, "..");
  const gradlePath = path.join(root, "android", "app", "build.gradle");
  if (!fs.existsSync(gradlePath)) {
    throw new Error("Generated Android app/build.gradle was not found. Run Capacitor Android generation first.");
  }

  const keystorePath = requiredEnv("ANDROID_KEYSTORE_PATH");
  if (!fs.existsSync(keystorePath)) throw new Error("The decoded Android release keystore does not exist.");

  const storePassword = requiredEnv("ANDROID_KEYSTORE_PASSWORD");
  const keyAlias = requiredEnv("ANDROID_KEY_ALIAS");
  const keyPassword = requiredEnv("ANDROID_KEY_PASSWORD");
  const versionCode = Number(requiredEnv("ANDROID_VERSION_CODE"));
  if (!Number.isSafeInteger(versionCode) || versionCode < 1) {
    throw new Error("ANDROID_VERSION_CODE must be a positive integer.");
  }

  let versionName = process.env.ANDROID_VERSION_NAME?.trim();
  if (!versionName) {
    const tagPrefix = "tradesight-v2-v";
    const tag = process.env.GITHUB_REF_NAME || "";
    versionName = tag.startsWith(tagPrefix)
      ? tag.slice(tagPrefix.length)
      : "2.0." + versionCode;
  }
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(versionName)) {
    throw new Error("ANDROID_VERSION_NAME contains unsupported characters.");
  }

  let gradle = fs.readFileSync(gradlePath, "utf8");
  const androidBlock = findBlock(gradle, "android");
  if (!androidBlock) throw new Error("Could not find the Android Gradle configuration block.");

  const androidEnd = matchingBrace(gradle, androidBlock.openBrace);
  const androidBody = gradle.slice(androidBlock.openBrace + 1, androidEnd);
  const defaultConfig = findBlock(androidBody, "defaultConfig");
  const buildTypes = findBlock(androidBody, "buildTypes");
  if (!defaultConfig || !buildTypes) {
    throw new Error("Generated Gradle file is missing defaultConfig or buildTypes.");
  }

  const defaultOpen = androidBlock.openBrace + 1 + defaultConfig.openBrace;
  const defaultEnd = matchingBrace(gradle, defaultOpen);
  let defaultBody = gradle.slice(defaultOpen + 1, defaultEnd);
  let versionCodeChanged = false;
  let versionNameChanged = false;
  defaultBody = defaultBody.replace(/^([\t ]*)versionCode\s+\d+\s*$/m, (_line, indent) => {
    versionCodeChanged = true;
    return indent + "versionCode " + versionCode;
  });
  defaultBody = defaultBody.replace(/^([\t ]*)versionName\s+["'][^"']*["']\s*$/m, (_line, indent) => {
    versionNameChanged = true;
    return indent + 'versionName "' + versionName + '"';
  });
  if (!versionCodeChanged || !versionNameChanged) {
    throw new Error("Could not safely locate versionCode and versionName inside defaultConfig.");
  }
  gradle = gradle.slice(0, defaultOpen + 1) + defaultBody + gradle.slice(defaultEnd);

  // Re-scan after the defaultConfig replacement so offsets remain correct.
  const updatedAndroid = findBlock(gradle, "android");
  const updatedAndroidEnd = matchingBrace(gradle, updatedAndroid.openBrace);
  const updatedAndroidBody = gradle.slice(updatedAndroid.openBrace + 1, updatedAndroidEnd);
  const updatedBuildTypes = findBlock(updatedAndroidBody, "buildTypes");
  const buildTypesOpen = updatedAndroid.openBrace + 1 + updatedBuildTypes.openBrace;
  const buildTypesEnd = matchingBrace(gradle, buildTypesOpen);
  const buildTypesBody = gradle.slice(buildTypesOpen + 1, buildTypesEnd);
  const releaseBlock = findBlock(buildTypesBody, "release");
  if (!releaseBlock) throw new Error("Could not find the release build type in generated Gradle configuration.");
  const releaseOpen = buildTypesOpen + 1 + releaseBlock.openBrace;
  const releaseEnd = matchingBrace(gradle, releaseOpen);
  const releaseBody = gradle.slice(releaseOpen + 1, releaseEnd);

  if (!/signingConfig\s+signingConfigs\.release/.test(releaseBody)) {
    gradle = gradle.slice(0, releaseOpen + 1) +
      "\n            signingConfig signingConfigs.release" +
      gradle.slice(releaseOpen + 1);
  }

  const releaseSigningLines = [
    "release {",
    '    storeFile file(System.getenv("ANDROID_KEYSTORE_PATH"))',
    '    storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")',
    '    keyAlias System.getenv("ANDROID_KEY_ALIAS")',
    '    keyPassword System.getenv("ANDROID_KEY_PASSWORD")',
    "}",
  ];

  const signingConfigsBlock = findBlock(gradle, "signingConfigs");
  if (signingConfigsBlock) {
    const signingConfigsOpen = signingConfigsBlock.openBrace;
    const signingConfigsEnd = matchingBrace(gradle, signingConfigsOpen);
    const signingConfigsBody = gradle.slice(signingConfigsOpen + 1, signingConfigsEnd);
    const existingReleaseSigning = findBlock(signingConfigsBody, "release");
    if (existingReleaseSigning) {
      const existingOpen = signingConfigsOpen + 1 + existingReleaseSigning.openBrace;
      const existingStart = signingConfigsOpen + 1 + existingReleaseSigning.start;
      const existingEnd = matchingBrace(gradle, existingOpen);
      const replacementBlock = releaseSigningLines
        .map((line, index) => index === 0 ? line : index === releaseSigningLines.length - 1 ? "        }" : "        " + line)
        .join("\n");
      gradle = gradle.slice(0, existingStart) + replacementBlock + gradle.slice(existingEnd + 1);
    } else {
      const addition = "\n" + releaseSigningLines
        .map((line, index) => index === 0 || index === releaseSigningLines.length - 1
          ? "        " + line
          : "            " + line)
        .join("\n") + "\n";
      gradle = gradle.slice(0, signingConfigsEnd) + addition + gradle.slice(signingConfigsEnd);
    }
  } else {
    const block = [
      "",
      "    signingConfigs {",
      "        release {",
      '            storeFile file(System.getenv("ANDROID_KEYSTORE_PATH"))',
      '            storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")',
      '            keyAlias System.getenv("ANDROID_KEY_ALIAS")',
      '            keyPassword System.getenv("ANDROID_KEY_PASSWORD")',
      "        }",
      "    }",
      "",
    ].join("\n");
    const currentAndroid = findBlock(gradle, "android");
    const currentBuildTypes = findBlock(
      gradle.slice(currentAndroid.openBrace + 1, matchingBrace(gradle, currentAndroid.openBrace)),
      "buildTypes",
    );
    const insertionPoint = currentAndroid.openBrace + 1 + currentBuildTypes.start;
    gradle = gradle.slice(0, insertionPoint) + block + gradle.slice(insertionPoint);
  }

  fs.writeFileSync(gradlePath, gradle);
  console.log("[TradeSight Android release] Signing configured; application version " +
    versionName + " (" + versionCode + ").");
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
