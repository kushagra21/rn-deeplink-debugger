# Changelog

## 0.2.0

- New `routes` command: lists Expo Router (`app/`) and React Navigation (`linking` config, static API) routes with the links that reach them. Reports saved links and intent filter paths that land on no route or only a catch-all, `linking.config` entries for screens that don't exist, screens without a deep link path, and routes Android App Links don't reach.
- `test` shows the screen a URL opens and its params; `test --all` gets a Screen column.
- `verify` reads the app's signing keys from Gradle (debug and release/upload keystores, Groovy or Kotlin DSL, passwords from `gradle.properties` or the environment) and checks their fingerprints are in `assetlinks.json`. It also flags release builds signed with the debug key.
- `verify` checks the https links saved in `.deeplinks.json` against the AASA rules.
- `.deeplinks.json` can hold `"android": { "sha256": [...] }` (e.g. the Play App Signing key) and `"ios": { "teamId": "..." }`, which `verify` always checks.

## 0.1.0

First release.

- `scan`: reads iOS (Info.plist, entitlements per build configuration, Xcode project), Android (AndroidManifest.xml, Gradle) and Expo (app.json, app.config via `expo config`) link config, with a fix for every problem found.
- `verify`: checks `apple-app-site-association` and `assetlinks.json`: serving, contents, app IDs, fingerprints, path coverage, and Apple's CDN copy.
- `test`: explains whether a URL opens the app on each platform, and names the closest pattern when it doesn't.
- `open`: opens a URL on the booted iOS simulator and Android emulators or devices, reporting which app handled it and the App Link verification state.
- `links`: shared test links in `.deeplinks.json`, with `test --all` and `open --all`.
