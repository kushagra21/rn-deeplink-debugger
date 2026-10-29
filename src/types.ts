export type Platform = "ios" | "android";

/**
 * - `scheme`: a custom URL scheme such as `myapp://`
 * - `universal`: an iOS associated domain (`applinks:`); paths come from the AASA file
 * - `app-link`: an Android http(s) intent filter
 */
export type LinkKind = "scheme" | "universal" | "app-link";

export type AndroidPathType = "path" | "pathPrefix" | "pathPattern" | "pathAdvancedPattern" | "pathSuffix";

export interface LinkPattern {
  platform: Platform;
  kind: LinkKind;
  scheme: string;
  host?: string;
  path?: string;
  pathType?: AndroidPathType;
  /** Android only: whether the intent filter has android:autoVerify="true". */
  autoVerify?: boolean;
  /** Set when the scheme belongs to an SDK (e.g. Facebook Login) rather than the app's own links. */
  thirdParty?: string;
  note?: string;
  /** File the pattern was read from, relative to the project root. */
  source: string;
}

export type FindingLevel = "error" | "warning" | "info";

export interface Finding {
  level: FindingLevel;
  /** What is wrong, in plain words. */
  message: string;
  /** How to fix it. */
  fix?: string;
  source?: string;
}

export interface ScanResult {
  root: string;
  /** Set for Expo projects; `configFile` is app.json or app.config.*. */
  expo: { configFile: string } | null;
  ios: { bundleIds: string[]; teamIds: string[] } | null;
  android: { packageNames: string[] } | null;
  patterns: LinkPattern[];
  findings: Finding[];
}
