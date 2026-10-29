import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type DebugKeystore = { fingerprint: string } | { error: string };

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

/**
 * SHA-256 fingerprint of the React Native template's debug keystore (password "android").
 * Returns null when the project has no android/app/debug.keystore.
 */
export function debugKeystoreFingerprint(root: string): DebugKeystore | null {
  const keystore = join(root, "android", "app", "debug.keystore");
  if (!existsSync(keystore)) return null;
  try {
    const output = execFileSync(findKeytool(), ["-list", "-v", "-keystore", keystore, "-storepass", "android"], {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const match = /SHA-?256:\s*((?:[0-9A-F]{2}:){31}[0-9A-F]{2})/i.exec(output);
    return match ? { fingerprint: match[1]!.toUpperCase() } : { error: "keytool didn't print a SHA-256 fingerprint" };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === "ENOENT" || /Unable to locate a Java Runtime/i.test(err.stderr ?? "")) {
      return { error: "keytool needs a Java runtime; install a JDK or set JAVA_HOME" };
    }
    return { error: "keytool couldn't open it (it may not use the default password)" };
  }
}
