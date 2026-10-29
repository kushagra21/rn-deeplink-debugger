import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";

export type KeyFingerprint = { fingerprint: string } | { error: string };

/** A keystore from a Gradle signing config, with its SHA-256 fingerprint or why it couldn't be read. */
export interface SigningKey {
  /** Signing config name, e.g. "debug" or "release". */
  name: string;
  /** Keystore path relative to the project root. */
  keystore: string;
  result: KeyFingerprint;
}

export interface AndroidSigning {
  keys: SigningKey[];
  /** The signing config the release build type uses, when Gradle names one. */
  releaseConfig?: string;
  /** Signing configs that couldn't be read, and why. */
  notes: string[];
}

export interface GradleSigningConfig {
  name: string;
  storeFile?: string;
  storePassword?: string;
  keyAlias?: string;
  /** Settings whose value comes from somewhere this tool can't see, e.g. a CI secret. */
  unresolved: string[];
}

export type ReadKeystore = (file: string, password: string, alias?: string) => KeyFingerprint;

const ANDROID_STUDIO_JBR = [
  "/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/keytool",
  "C:\\Program Files\\Android\\Android Studio\\jbr\\bin\\keytool.exe",
  "/opt/android-studio/jbr/bin/keytool",
];

/** keytool from JAVA_HOME, then Android Studio's bundled JDK, then PATH. */
function findKeytool(): string {
  const javaHome = process.env.JAVA_HOME && join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "keytool.exe" : "keytool");
  return [javaHome, ...ANDROID_STUDIO_JBR].find((path): path is string => !!path && existsSync(path)) ?? "keytool";
}

/** SHA-256 fingerprint of a keystore entry. The password goes through an environment variable, not the command line. */
export const keystoreFingerprint: ReadKeystore = (file, password, alias) => {
  try {
    const output = execFileSync(findKeytool(), ["-list", "-v", "-keystore", file, "-storepass:env", "RN_DEEPLINK_STOREPASS", ...(alias ? ["-alias", alias] : [])], {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, RN_DEEPLINK_STOREPASS: password },
    });
    const match = /SHA-?256:\s*((?:[0-9A-F]{2}:){31}[0-9A-F]{2})/i.exec(output);
    return match ? { fingerprint: match[1]!.toUpperCase() } : { error: "keytool didn't print a SHA-256 fingerprint" };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === "ENOENT" || /Unable to locate a Java Runtime/i.test(err.stderr ?? "")) {
      return { error: "keytool needs a Java runtime; install a JDK or set JAVA_HOME" };
    }
    if (/password was incorrect|Keystore was tampered/i.test(err.stderr ?? "")) return { error: "the keystore password is wrong" };
    if (/Alias <.*> does not exist/i.test(err.stderr ?? "")) return { error: `the keystore has no key named "${alias}"` };
    return { error: "keytool couldn't open it" };
  }
};

/** key=value pairs from gradle.properties files; later files win, as Gradle's user-home file does. */
export function readGradleProperties(files: string[]): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^\s*([^#!=:\s][^=:]*?)\s*[=:]\s*(.*?)\s*$/.exec(line);
      if (m) properties[m[1]!] = m[2]!;
    }
  }
  return properties;
}

/** The `{ … }` body that opens at `open`, matching nested braces. */
function blockBody(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

/** Named child blocks of a Gradle block: `release { … }`, `create("release") { … }`, `getByName("debug") { … }`. */
function childBlocks(body: string): { name: string; body: string }[] {
  const children: { name: string; body: string }[] = [];
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "}") depth--;
    if (body[i] !== "{") continue;
    if (depth === 0) {
      const header = body.slice(0, i).split(/[\n;}]/).at(-1)!.trim();
      const name = /^(?:(?:create|getByName|register|named|maybeCreate)\(\s*["'](\w+)["']\s*\)|(\w+))$/.exec(header);
      if (name) children.push({ name: (name[1] ?? name[2])!, body: blockBody(body, i) });
    }
    depth++;
  }
  return children;
}

function findBlock(text: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*\\{`).exec(text);
  return m ? blockBody(text, m.index + m[0].length - 1) : undefined;
}

/**
 * Resolve a Gradle value expression: a quoted string, a property name, project.property("X"),
 * findProperty("X"), properties["X"] or System.getenv("X"). Returns undefined when it can't.
 */
export function resolveGradleValue(expression: string, properties: Record<string, string>, env: NodeJS.ProcessEnv): string | undefined {
  const value = expression.trim().replace(/\s+as\s+String$/, "").replace(/\.toString\(\)$/, "").trim();
  const quoted = /^(["'])(.*)\1$/.exec(value);
  if (quoted) {
    const text = quoted[2]!;
    if (!/\$/.test(text)) return text;
    const interpolated = text.replace(/\$\{?(\w+)\}?/g, (whole, name: string) => properties[name] ?? whole);
    return /\$/.test(interpolated) ? undefined : interpolated;
  }
  const property = /^(?:(?:project|rootProject)\.)?(?:property|findProperty)\(\s*["'](\w+)["']\s*\)$/.exec(value) ?? /^(?:(?:project|rootProject)\.)?properties\[\s*["'](\w+)["']\s*\]$/.exec(value);
  if (property) return properties[property[1]!];
  const envVar = /^System\.getenv\(\s*["'](\w+)["']\s*\)$/.exec(value);
  if (envVar) return env[envVar[1]!];
  if (/^\w+$/.test(value)) return properties[value];
  return undefined;
}

/** Signing configs from an app module's build.gradle(.kts), resolved against Gradle properties and the environment. */
export function parseSigningConfigs(gradle: string, properties: Record<string, string>, env: NodeJS.ProcessEnv = process.env): GradleSigningConfig[] {
  const body = findBlock(gradle, "signingConfigs");
  if (!body) return [];
  return childBlocks(body).map(({ name, body: config }) => {
    const setting = (key: string, pattern: RegExp) => {
      const expression = pattern.exec(config)?.[1];
      if (expression === undefined) return { value: undefined, unresolved: false };
      const value = resolveGradleValue(expression, properties, env);
      return { value, unresolved: value === undefined };
    };
    const storeFile = setting("storeFile", /\bstoreFile\s*=?\s*(?:rootProject\.|project\.)?file\((.*)\)\s*$/m);
    const storePassword = setting("storePassword", /\bstorePassword\s*=?\s*([^\n;]+)/);
    const keyAlias = setting("keyAlias", /\bkeyAlias\s*=?\s*([^\n;]+)/);
    return {
      name,
      storeFile: storeFile.value,
      storePassword: storePassword.value,
      keyAlias: keyAlias.value,
      unresolved: [storeFile.unresolved && "storeFile", storePassword.unresolved && "storePassword", keyAlias.unresolved && "keyAlias"].filter(
        (s): s is string => !!s,
      ),
    };
  });
}

/** The signing config the release build type uses, e.g. "release", or "debug" in the React Native template. */
export function releaseSigningConfig(gradle: string): string | undefined {
  const buildTypes = findBlock(gradle, "buildTypes");
  const release = buildTypes && childBlocks(buildTypes).find((b) => b.name === "release");
  return release && /\bsigningConfig\s*=?\s*signingConfigs\.(?:getByName\(\s*["'](\w+)["']\s*\)|(\w+))/.exec(release.body)?.slice(1).find(Boolean);
}

/**
 * Fingerprints of the keystores the Android app is signed with, read from android/app/build.gradle,
 * gradle.properties (the project's, then ~/.gradle's) and the environment. Returns null without an
 * Android app module.
 */
export function androidSigning(root: string, readKey: ReadKeystore = keystoreFingerprint, home = homedir()): AndroidSigning | null {
  const appDir = join(root, "android", "app");
  const gradleFile = ["build.gradle", "build.gradle.kts"].map((f) => join(appDir, f)).find(existsSync);
  if (!gradleFile) return null;
  const gradle = readFileSync(gradleFile, "utf8");
  const properties = readGradleProperties([join(root, "android", "gradle.properties"), join(home, ".gradle", "gradle.properties")]);
  const configs = parseSigningConfigs(gradle, properties);
  // The template's debug keystore exists even when no signing config is declared for it.
  if (!configs.some((c) => c.name === "debug") && existsSync(join(appDir, "debug.keystore"))) {
    configs.unshift({ name: "debug", storeFile: "debug.keystore", storePassword: "android", keyAlias: "androiddebugkey", unresolved: [] });
  }

  const keys: SigningKey[] = [];
  const notes: string[] = [];
  for (const config of configs) {
    if (!config.storeFile) {
      if (config.unresolved.length) notes.push(`The ${config.name} signing config reads its keystore from somewhere rn-deeplink can't see (for example a CI secret).`);
      continue;
    }
    const file = resolve(appDir, config.storeFile);
    const keystore = relative(root, file);
    if (!existsSync(file)) {
      notes.push(`The ${config.name} signing config points to ${keystore}, which isn't on this machine.`);
      continue;
    }
    const password = config.storePassword ?? (config.name === "debug" ? "android" : undefined);
    if (password === undefined) {
      notes.push(`The ${config.name} keystore's password isn't in gradle.properties or the environment, so its fingerprint wasn't read.`);
      continue;
    }
    keys.push({ name: config.name, keystore, result: readKey(file, password, config.keyAlias) });
  }
  return { keys, releaseConfig: releaseSigningConfig(gradle), notes };
}
