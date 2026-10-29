# Changelog

## 0.1.0

First release.

- `scan`: reads iOS (Info.plist, entitlements per build configuration, Xcode project), Android (AndroidManifest.xml, Gradle) and Expo (app.json, app.config via `expo config`) link config, with a fix for every problem found.
- `verify`: checks `apple-app-site-association` and `assetlinks.json`: serving, contents, app IDs, fingerprints, path coverage, and Apple's CDN copy.
- `test`: explains whether a URL opens the app on each platform, and names the closest pattern when it doesn't.
- `open`: opens a URL on the booted iOS simulator and Android emulators or devices, reporting which app handled it and the App Link verification state.
- `links`: shared test links in `.deeplinks.json`, with `test --all` and `open --all`.
