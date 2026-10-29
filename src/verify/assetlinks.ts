import { isDict } from "../parsers/ios.js";
import type { Check } from "../types.js";
import { unique } from "../util/fs.js";
import { servedChecks, type FetchedFile } from "./fetch.js";
import type { AndroidSigning } from "./signing.js";

export interface AssetlinksExpectations {
  packageNames: string[];
  /** Fingerprints that must be listed: --sha256 and android.sha256 in .deeplinks.json (e.g. the Play App Signing key). */
  fingerprints: string[];
  /** Keystores the project signs the app with, from Gradle. */
  signing?: AndroidSigning | null;
}

export const HANDLE_ALL_URLS = "delegate_permission/common.handle_all_urls";
const FINGERPRINT_RE = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const EXAMPLE =
  '[{ "relation": ["delegate_permission/common.handle_all_urls"], "target": { "namespace": "android_app", "package_name": "com.example.app", "sha256_cert_fingerprints": ["AB:CD:…"] } }]';

/** Uppercase, colon-separated form of a SHA-256 fingerprint; other input is returned uppercased. */
export function normalizeFingerprint(fingerprint: string): string {
  const hex = fingerprint.replace(/[^0-9a-f]/gi, "").toUpperCase();
  return hex.length === 64 ? hex.match(/../g)!.join(":") : fingerprint.trim().toUpperCase();
}

const short = (fingerprint: string) => `${fingerprint.slice(0, 11)}…${fingerprint.slice(-5)}`;
const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

export function checkAssetlinks(file: FetchedFile, expected: AssetlinksExpectations): Check[] {
  const served = servedChecks(file, "Android");
  const checks = served.checks;
  if (!served.usable) return checks;

  if (!Array.isArray(file.json)) {
    checks.push({ level: "error", message: "The file must be a JSON array of statements.", fix: `Use this shape: ${EXAMPLE}` });
    return checks;
  }
  const statements = file.json.flatMap((s) => {
    if (!isDict(s) || !isDict(s.target) || s.target.namespace !== "android_app") return [];
    return [{ packageName: String(s.target.package_name ?? ""), relations: strings(s.relation), fingerprints: strings(s.target.sha256_cert_fingerprints) }];
  });
  if (statements.length === 0) {
    checks.push({ level: "error", message: 'The file has no statements for Android apps (target.namespace "android_app").', fix: `Use this shape: ${EXAMPLE}` });
    return checks;
  }

  for (const fingerprint of unique(statements.flatMap((s) => s.fingerprints))) {
    if (FINGERPRINT_RE.test(fingerprint)) continue;
    const pairs = fingerprint.replace(/[^0-9a-f]/gi, "").length / 2;
    if (FINGERPRINT_RE.test(normalizeFingerprint(fingerprint))) {
      checks.push({
        level: "warning",
        message: `Fingerprint "${fingerprint}" isn't in the standard format.`,
        fix: `Write it as uppercase hex pairs separated by colons: "${normalizeFingerprint(fingerprint)}".`,
      });
    } else {
      checks.push({
        level: "error",
        message:
          pairs === 20
            ? `"${fingerprint}" is a SHA-1 fingerprint, but assetlinks.json needs SHA-256.`
            : `"${fingerprint}" is not a valid SHA-256 fingerprint (it should be 32 colon-separated hex pairs).`,
        fix: "Copy the SHA-256 value from Play Console → Test and release → App integrity → App signing, or from `./gradlew signingReport`.",
      });
    }
  }

  const listed = unique(statements.map((s) => s.packageName));
  let targets = statements;
  if (expected.packageNames.length) {
    targets = statements.filter((s) => expected.packageNames.includes(s.packageName));
    if (targets.length === 0) {
      checks.push({
        level: "error",
        message: `The file doesn't list your package (${expected.packageNames.join(", ")}). It lists: ${listed.join(", ")}.`,
        fix: `Add a statement with "package_name": "${expected.packageNames[0]}". Shape: ${EXAMPLE}`,
      });
      return checks;
    }
  } else {
    checks.push({ level: "info", message: `Lists ${listed.join(", ")}. Run this in your project, or pass --package, to check it's your app.` });
  }

  const verified = targets.filter((s) => s.relations.includes(HANDLE_ALL_URLS));
  const packages = unique(targets.map((s) => s.packageName)).join(", ");
  if (verified.length === 0) {
    checks.push({
      level: "error",
      message: `The statement for ${packages} doesn't include the "${HANDLE_ALL_URLS}" relation, so it doesn't verify App Links.`,
      fix: `Add "${HANDLE_ALL_URLS}" to its "relation" array.`,
    });
    return checks;
  }
  checks.push({
    level: "pass",
    message: expected.packageNames.length ? `Lists ${packages} with the handle_all_urls relation` : "Has the handle_all_urls relation",
  });

  const fingerprints = new Set(verified.flatMap((s) => s.fingerprints.map(normalizeFingerprint)));
  if (fingerprints.size === 0) {
    checks.push({
      level: "error",
      message: `The statement for ${packages} has no sha256_cert_fingerprints, so no build of the app can verify.`,
      fix: "Add the SHA-256 fingerprint of the key that signs the app (Play Console → Test and release → App integrity → App signing).",
    });
    return checks;
  }

  for (const fingerprint of expected.fingerprints.map(normalizeFingerprint)) {
    checks.push(
      fingerprints.has(fingerprint)
        ? { level: "pass", message: `Includes fingerprint ${short(fingerprint)}` }
        : {
            level: "error",
            message: `It doesn't include the fingerprint ${fingerprint}, so builds signed with that key won't verify.`,
            fix: `Add "${fingerprint}" to sha256_cert_fingerprints.`,
          },
    );
  }

  checks.push(...signingChecks(fingerprints, expected));
  return checks;
}

const PLAY_SIGNING_FIX =
  'Copy the "App signing key certificate" SHA-256 from Play Console → Test and release → App integrity, add it to sha256_cert_fingerprints, and save it in .deeplinks.json as "android": { "sha256": ["…"] } so verify always checks it.';

/** Compare the listed fingerprints with the keystores the project signs the app with. */
function signingChecks(listed: Set<string>, expected: AssetlinksExpectations): Check[] {
  const checks: Check[] = [];
  const signing = expected.signing;
  const playKnown = expected.fingerprints.length > 0;

  for (const key of signing?.keys ?? []) {
    const label = key.name === "debug" ? "debug keystore" : `${key.name} keystore (${key.keystore})`;
    if ("error" in key.result) {
      checks.push({ level: "info", message: `Couldn't read the ${label}: ${key.result.error}.` });
      continue;
    }
    const fingerprint = key.result.fingerprint;
    if (listed.has(fingerprint)) {
      checks.push({ level: "pass", message: `Includes your ${label}'s fingerprint, so builds signed with it verify` });
    } else if (key.name === "debug") {
      checks.push({
        level: "info",
        message: `It doesn't include your debug keystore's fingerprint (${short(fingerprint)}), so App Links won't verify in debug builds. That's fine for production.`,
        fix: `To test App Links in debug builds, add "${fingerprint}" to sha256_cert_fingerprints.`,
      });
    } else {
      // With Play App Signing, Play re-signs the app, so the upload key needn't be listed.
      checks.push({
        level: playKnown ? "info" : "warning",
        message: `It doesn't include the fingerprint of your ${label} (${short(fingerprint)}). ${
          playKnown
            ? "That's fine if this is your Play upload key, since Play re-signs the app with the app signing key you listed; builds you distribute yourself won't verify."
            : "If you use Play App Signing that's expected, but then the app signing key from Play Console must be listed instead, and rn-deeplink doesn't know it yet."
        }`,
        fix: playKnown ? `To verify builds you distribute yourself, add "${fingerprint}" to sha256_cert_fingerprints.` : PLAY_SIGNING_FIX,
      });
    }
  }

  if (signing?.releaseConfig === "debug") {
    checks.push({
      level: "warning",
      message: "Release builds are signed with the debug keystore (the React Native template's default), so they can't go to Google Play, and App Links in them only verify if the debug fingerprint is listed.",
      fix: "Create an upload keystore and a release signing config: https://reactnative.dev/docs/signed-apk-android",
    });
  }
  for (const note of signing?.notes ?? []) checks.push({ level: "info", message: note });

  if (!playKnown && !signing?.keys.some((k) => k.name !== "debug")) {
    checks.push({ level: "info", message: "Fingerprints weren't checked against your release or Play App Signing key.", fix: PLAY_SIGNING_FIX });
  }
  return checks;
}
