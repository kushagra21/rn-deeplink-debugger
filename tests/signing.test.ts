import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { androidSigning, parseSigningConfigs, readGradleProperties, releaseSigningConfig, resolveGradleValue, type ReadKeystore } from "../src/verify/signing.js";

// The signing setup from the React Native template, after following its "signed APK" guide.
const TEMPLATE = `
android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
        release {
            if (project.hasProperty('MYAPP_UPLOAD_STORE_FILE')) {
                storeFile file(MYAPP_UPLOAD_STORE_FILE)
                storePassword MYAPP_UPLOAD_STORE_PASSWORD
                keyAlias MYAPP_UPLOAD_KEY_ALIAS
                keyPassword MYAPP_UPLOAD_KEY_PASSWORD
            }
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            signingConfig signingConfigs.release
            minifyEnabled enableProguardInReleaseBuilds
        }
    }
}
`;

const KOTLIN = `
android {
    signingConfigs {
        create("release") {
            storeFile = file(System.getenv("UPLOAD_STORE_FILE"))
            storePassword = System.getenv("UPLOAD_STORE_PASSWORD")
            keyAlias = project.property("UPLOAD_KEY_ALIAS") as String
        }
    }
    buildTypes {
        getByName("release") {
            signingConfig = signingConfigs.getByName("release")
        }
    }
}
`;

const PROPERTIES = { MYAPP_UPLOAD_STORE_FILE: "my-upload-key.keystore", MYAPP_UPLOAD_STORE_PASSWORD: "s3cret", MYAPP_UPLOAD_KEY_ALIAS: "upload" };

describe("Gradle signing configs", () => {
  it("reads the React Native template's debug and release configs", () => {
    expect(parseSigningConfigs(TEMPLATE, PROPERTIES, {})).toEqual([
      { name: "debug", storeFile: "debug.keystore", storePassword: "android", keyAlias: "androiddebugkey", unresolved: [] },
      { name: "release", storeFile: "my-upload-key.keystore", storePassword: "s3cret", keyAlias: "upload", unresolved: [] },
    ]);
    expect(releaseSigningConfig(TEMPLATE)).toBe("release");
  });

  it("notes values it can't resolve", () => {
    expect(parseSigningConfigs(TEMPLATE, {}, {})[1]).toEqual({
      name: "release",
      storeFile: undefined,
      storePassword: undefined,
      keyAlias: undefined,
      unresolved: ["storeFile", "storePassword", "keyAlias"],
    });
  });

  it("reads Kotlin DSL configs with environment variables", () => {
    expect(parseSigningConfigs(KOTLIN, { UPLOAD_KEY_ALIAS: "upload" }, { UPLOAD_STORE_FILE: "/ci/upload.jks", UPLOAD_STORE_PASSWORD: "pw" })).toEqual([
      { name: "release", storeFile: "/ci/upload.jks", storePassword: "pw", keyAlias: "upload", unresolved: [] },
    ]);
    expect(releaseSigningConfig(KOTLIN)).toBe("release");
  });

  it("spots the template default of signing release builds with the debug key", () => {
    expect(releaseSigningConfig(TEMPLATE.replace("signingConfig signingConfigs.release", "signingConfig signingConfigs.debug"))).toBe("debug");
  });

  it("resolves the value expressions Gradle files use", () => {
    const props = { A: "a", B: "b" };
    expect(resolveGradleValue("'x'", props, {})).toBe("x");
    expect(resolveGradleValue('"${A}-${B}"', props, {})).toBe("a-b");
    expect(resolveGradleValue("A", props, {})).toBe("a");
    expect(resolveGradleValue('findProperty("B")', props, {})).toBe("b");
    expect(resolveGradleValue("project.properties['A']", props, {})).toBe("a");
    expect(resolveGradleValue('System.getenv("E")', props, { E: "e" })).toBe("e");
    expect(resolveGradleValue("keystoreProperties['storePassword']", props, {})).toBeUndefined();
  });
});

describe("androidSigning", () => {
  let root: string;
  let home: string;
  const reads: { file: string; password: string; alias?: string }[] = [];
  const readKey: ReadKeystore = (file, password, alias) => {
    reads.push({ file: file.slice(root.length + 1), password, alias });
    return { fingerprint: file.endsWith("debug.keystore") ? "DEBUG" : "UPLOAD" };
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rn-deeplink-"));
    home = mkdtempSync(join(tmpdir(), "rn-deeplink-home-"));
    reads.length = 0;
    mkdirSync(join(root, "android", "app"), { recursive: true });
    mkdirSync(join(home, ".gradle"));
    writeFileSync(join(root, "android", "app", "build.gradle"), TEMPLATE);
    writeFileSync(join(root, "android", "app", "debug.keystore"), "");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("reads both keystores, with passwords from ~/.gradle/gradle.properties", () => {
    writeFileSync(join(root, "android", "app", "my-upload-key.keystore"), "");
    writeFileSync(join(root, "android", "gradle.properties"), "MYAPP_UPLOAD_STORE_FILE=my-upload-key.keystore\nMYAPP_UPLOAD_KEY_ALIAS=upload\n");
    writeFileSync(join(home, ".gradle", "gradle.properties"), "# secrets\nMYAPP_UPLOAD_STORE_PASSWORD = s3cret\n");
    const signing = androidSigning(root, readKey, home);
    expect(signing).toEqual({
      keys: [
        { name: "debug", keystore: join("android", "app", "debug.keystore"), result: { fingerprint: "DEBUG" } },
        { name: "release", keystore: join("android", "app", "my-upload-key.keystore"), result: { fingerprint: "UPLOAD" } },
      ],
      releaseConfig: "release",
      notes: [],
    });
    expect(reads[1]).toEqual({ file: join("android", "app", "my-upload-key.keystore"), password: "s3cret", alias: "upload" });
  });

  it("explains a release keystore it can't use", () => {
    writeFileSync(join(root, "android", "gradle.properties"), "MYAPP_UPLOAD_STORE_FILE=missing.keystore\n");
    expect(androidSigning(root, readKey, home)!.notes).toEqual([`The release signing config points to ${join("android", "app", "missing.keystore")}, which isn't on this machine.`]);
    writeFileSync(join(root, "android", "app", "missing.keystore"), "");
    expect(androidSigning(root, readKey, home)!.notes).toEqual([
      "The release keystore's password isn't in gradle.properties or the environment, so its fingerprint wasn't read.",
    ]);
  });

  it("returns null without an Android app module", () => {
    rmSync(join(root, "android"), { recursive: true });
    expect(androidSigning(root, readKey, home)).toBeNull();
  });

  it("reads gradle.properties, letting later files win", () => {
    const a = join(root, "a.properties");
    const b = join(root, "b.properties");
    writeFileSync(a, "X=1\nY: 2\n! comment\n");
    writeFileSync(b, "X=3\n");
    expect(readGradleProperties([a, b, join(root, "none")])).toEqual({ X: "3", Y: "2" });
  });
});
