# rn-deeplink

[![npm](https://img.shields.io/npm/v/rn-deeplink)](https://www.npmjs.com/package/rn-deeplink)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Find out why a deep link, universal link or App Link doesn't open your React Native app, and test links on simulators, emulators and devices.**

It reads your iOS, Android and Expo config, checks the association files on your domain, maps URLs to your Expo Router or React Navigation screens, explains why a given URL does or doesn't open the app, and fires links at running devices. Every problem it reports says what's wrong and how to fix it.

![rn-deeplink scan finding problems in a project's link config](docs/media/scan.gif)

```bash
npx rn-deeplink scan          # run in your React Native or Expo project
```

## Why

Debugging deep links usually means guessing. Is it `apple-app-site-association`, `assetlinks.json`, the entitlements, the intent filter, or the URL? You end up typing long `xcrun simctl` and `adb` commands by hand. `rn-deeplink` puts the whole flow in one place, for bare React Native and Expo, on macOS, Linux and Windows.

## Commands

| Command | What it does | Network |
| --- | --- | --- |
| [`scan`](#scan) | Lists every link the app claims on iOS and Android, with warnings | no |
| [`test <url>`](#test) | Explains whether a URL opens the app on each platform, which screen it opens, and why not | no (optional) |
| [`verify [domains]`](#verify) | Checks `apple-app-site-association` and `assetlinks.json` against the app's IDs, signing keys and paths | yes |
| [`routes`](#routes) | Lists Expo Router / React Navigation routes, which links reach them, and links that land nowhere | no |
| [`open <url>`](#open) | Opens a URL on the booted simulator and/or Android emulator or device | no |
| [`links`](#saved-links) | Manages the team's shared test links in `.deeplinks.json` | no |

Every command takes `--json` for machine-readable output and exits with code 1 when it finds an error, so they work in CI.

### scan

Run it in the project root, or pass `--cwd <dir>`. It reads:

- **iOS:** URL schemes from `Info.plist`, and associated domains from the `.entitlements` files. It reads them for each build configuration using the Xcode project's app targets, then resolves bundle and team IDs, including build variables such as `$(PRODUCT_NAME:rfc1034identifier)`.
- **Android:** every `VIEW` intent filter in `AndroidManifest.xml` (schemes, hosts, paths, `autoVerify`, categories, `exported`), plus the package name from Gradle.
- **Expo:** `scheme`, `ios.associatedDomains` and `android.intentFilters` from `app.json`. A dynamic `app.config.(ts|js)` is evaluated with the project's own `expo config --json`, so install dependencies first. When `ios/` or `android/` exist too, those folders are what gets built, and `scan` warns when they're missing links the Expo config sets up (run `npx expo prebuild`).

Some of the mistakes it catches:

- universal links set up for Debug but not Release builds, or an `.entitlements` file no build uses
- `myapp://` written as a scheme, or `applinks:https://example.com` as a domain
- intent filters missing `BROWSABLE`, `DEFAULT` or `autoVerify`, activities with `exported="false"`, paths without a leading `/`, and uppercase schemes (Android matches them case-sensitively)
- Expo `intentFilters` using `"android.intent.action.VIEW"` (Expo adds the prefix itself, so the filter never matches), or unknown `data` keys such as `pathprefix`
- schemes or domains that are set up on only one platform

### test

![rn-deeplink test explaining why a URL doesn't open on Android](docs/media/test.gif)

```bash
npx rn-deeplink test https://example.com/product/42
npx rn-deeplink test https://example.com/product/42 --online   # also check the AASA paths
```

`test` works offline and matches the URL the way each platform does:
- **Android:** schemes are case-sensitive, a `*.` host wildcard matches subdomains only, and `pathPattern` uses Android's own glob syntax.
- **iOS:** universal links are https-only and need an exact port.

When nothing matches, `test` names the closest pattern and the part that failed. It also flags matches a real tap can't reach, such as a filter without `BROWSABLE`. iOS paths come from the AASA file on your server, so `--online` fetches it, or `--aasa <file>` checks a local copy.

In Expo Router and React Navigation apps, `test` also shows the screen the URL opens, with its params. For example, `Opens app/product/[id].tsx with {"id":"42"}` or `Opens Profile with {"id":"9"}`. It warns when no route matches, or when only a catch-all route does.

### verify

```bash
npx rn-deeplink verify                      # every domain the project uses
npx rn-deeplink verify example.com --sha256 AB:CD:... --path /product/42
```

The expected app IDs, packages, signing keys and paths come from the project. It checks:

- HTTPS, status 200, no redirects (Apple and Google don't follow them), JSON and its Content-Type, and the AASA's 128 KB limit
- single-page-app fallbacks that serve `index.html` instead of the file
- that the AASA lists your `TEAMID.bundle.id` from the entitlements and Xcode project (it names a team ID mismatch)
- that its `components` / `paths` open the paths your Android filters handle and the https links saved in `.deeplinks.json`, using iOS's matching rules: first rule wins, `exclude`, wildcards
- **Apple's CDN copy**, which is what devices actually read, so you know when it's missing or out of date
- that `assetlinks.json` lists your package with `handle_all_urls`, with well-formed SHA-256 fingerprints (SHA-1 is flagged)
- **the keys your app is signed with.** It reads every signing config in `android/app/build.gradle` (Groovy or Kotlin DSL), with passwords from `gradle.properties` (the project's or `~/.gradle`) or environment variables. It then checks each keystore's fingerprint (debug, and the release/upload key) is listed, and flags release builds that are still signed with the debug key.
- the Play App Signing key, and any other fingerprint that must be listed: pass it with `--sha256`, or save it in `.deeplinks.json` so every run and CI checks it:

```json
{
  "links": [],
  "android": { "sha256": ["AB:CD:…"] },
  "ios": { "teamId": "ABCDE12345" }
}
```

> **Tip:** with Play App Signing, Google re-signs your app, so the fingerprint `assetlinks.json` needs is the *app signing key* from Play Console → Test and release → App integrity, not your upload key. `ios.teamId` is for projects whose Xcode project doesn't set a team.

### routes

![rn-deeplink routes showing React Navigation routes and problems](docs/media/routes.gif)

```bash
npx rn-deeplink routes
```

`routes` lists every route the app's navigation handles, the screen it opens, and which links reach it on each platform. It reads:

- **Expo Router** from `app/` (or `src/app/`). Groups like `(tabs)` don't add to the path, `[id]` is a parameter and `[...slug]` a catch-all, and layouts, `+not-found` and API routes are skipped.
- **React Navigation** from your source, without running it. It reads the `linking` config passed to `NavigationContainer` (`prefixes` plus `config.screens`, nested navigators, `path` / `exact`, also when `config` is a variable or comes from another file) and the static API (`create…Navigator({ screens })` with per-screen `linking` or `enabled: 'auto'`). It collects the declared screens from `<X.Screen name="…">`.

It reports:

- **links that land nowhere:** saved links and Android intent filter paths that open the app, but match no route (or only a catch-all like `*` / `+not-found`)
- **React Navigation config drift:** `linking.config` entries for screens no navigator declares, and screens with no deep link path
- **routes App Links don't reach:** routes that open in the browser on Android because no https intent filter covers them

Anything built at runtime (computed paths, configs from packages) is reported as not read, never guessed.

### open

```bash
npx rn-deeplink open myapp://product/42
npx rn-deeplink open https://example.com/product/42 --platform android --reverify
```

`open` finds the booted iOS simulator and the running Android emulator or device. If several are running, it asks which one to use (or pass `--device`).

On Android it sends the link the way a browser tap does, then reports which app actually handled it. "Opened in com.android.chrome instead of com.example.app" is the classic unverified App Link. For https links it also shows the verification state from `pm get-app-links` and the build's signing fingerprint.

`--reverify` re-runs verification first. `--direct` skips verification and sends the link straight to your app.

### Saved links

![rn-deeplink links init and test --all](docs/media/links.gif)

Keep your team's test URLs in a committed `.deeplinks.json`:

```bash
npx rn-deeplink links init                    # one example per pattern the app declares
npx rn-deeplink links add https://example.com/product/42 --name "Product page"
npx rn-deeplink links add myapp://settings --platform ios
npx rn-deeplink links                         # list; remove with: links remove <number|url|name>

npx rn-deeplink test --all                    # offline check of every link, and the screen it opens
npx rn-deeplink open --all                    # fire each at the running devices (--step: one at a time)
```

`verify` also checks saved https links against the AASA rules, and `routes` checks they land on a real screen.

```json
{
  "links": [
    { "name": "Product page", "url": "https://example.com/product/42" },
    { "name": "Settings", "url": "myapp://settings", "platform": "ios" }
  ]
}
```

## CI

`test --all` needs no devices or network, so it's a cheap guard against a change to an intent filter or entitlements file breaking a link:

```yaml
# .github/workflows/deep-links.yml
name: Deep links
on: [pull_request]
jobs:
  links:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx rn-deeplink scan
      - run: npx rn-deeplink routes
      - run: npx rn-deeplink test --all
```

For Expo projects with an `app.config.ts`, run `npm ci` first so `scan` can evaluate it.

## Requirements

- Node.js 22.12 or newer
- `open` on iOS needs macOS with Xcode. On Android it needs `adb` (Android Studio or SDK Platform-Tools), found through `ANDROID_HOME` or the default SDK location.
- Reading keystore fingerprints in `verify` needs a JDK (Android Studio's bundled one works). Keystore passwords are passed to `keytool` through an environment variable, never on the command line.

`rn-deeplink` never changes your project files. The only file it writes is `.deeplinks.json`, and only when you run a `links` command.

## Roadmap

- `verify` and `routes` checking universal link paths against the live AASA per route
- A local web UI (`rn-deeplink ui`) with one-click "open on device"
- An MCP server, so AI coding agents can call `scan`, `verify` and `open`

## Development

```bash
npm install
npm test           # vitest, with fixture projects under fixtures/
npm run build      # tsup → dist/cli.js
npm run demos      # re-record the GIFs in docs/media (needs agg: brew install agg)
```

## License

[MIT](LICENSE)
