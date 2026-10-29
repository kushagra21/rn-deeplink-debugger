// Schemes registered by SDKs rather than by the app's own deep linking. They are shown in the
// scan table but excluded from cross-platform mismatch warnings, since each SDK sets them up
// differently per platform.
const KNOWN_SCHEMES: [RegExp, string][] = [
  [/^fb\d+$/, "Facebook SDK"],
  [/^com\.googleusercontent\.apps\./, "Google Sign-In"],
  [/^exp\+/, "Expo dev client"],
  [/^msauth\./, "Microsoft Authentication"],
];

export function thirdPartyScheme(scheme: string): string | undefined {
  return KNOWN_SCHEMES.find(([pattern]) => pattern.test(scheme))?.[1];
}
