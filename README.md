# rn-deeplink

Find out why a deep link or universal/app link does not open your React Native app, and test links quickly on simulators, emulators and devices.

> Work in progress — commands are being built in the order listed in [CLAUDE.md](CLAUDE.md).

```bash
npx rn-deeplink scan            # read iOS / Android / Expo link config
npx rn-deeplink verify example.com   # check AASA and assetlinks.json
npx rn-deeplink open myapp://home    # fire a link at a booted device
npx rn-deeplink test https://example.com/product/42
```

`scan` works on bare React Native and Expo projects. For Expo it reads `app.json` directly. A dynamic
`app.config.(ts|js)` is evaluated with the project's own `expo config --json`, so install the project's
dependencies first. If an Expo project also has `ios/` or `android/`, those folders are what the build
uses, and `scan` warns when they are missing links that the Expo config sets up (run `npx expo prebuild`).

`verify` with no domain checks every domain the project uses. It reads the expected team ID,
bundle IDs, package names and Android paths from the project. It checks:
- HTTPS, status 200, no redirects, JSON and Content-Type, and the 128 KB AASA limit
- that the file lists your app ID or package with the right relation
- that the paths Android opens are also covered by the AASA rules (add more with `--path`)
- that Apple's CDN copy matches your server
- that your release fingerprint (`--sha256`) and debug keystore fingerprint are included

```bash
npx rn-deeplink verify                         # every domain in the project
npx rn-deeplink verify example.com --path /product/42 --sha256 AB:CD:...
```

`open` sends a URL to the booted iOS simulator and the running Android emulator or device. If
several are running, it asks which one to use, or you can pass `--device`. On Android it acts like a
link tapped in a browser: it reports which app actually handled the link, and for https links it
shows the App Link verification state (`pm get-app-links`).

```bash
npx rn-deeplink open myapp://product/42
npx rn-deeplink open https://example.com/product/42 --platform android --reverify
npx rn-deeplink open https://example.com/product/42 --direct   # skip verification, straight to the app
```

`test` works offline and explains, for each platform, whether a URL opens the app. It matches the
URL the way iOS and Android do (Android schemes are case-sensitive, wildcard hosts match subdomains
only, and Android uses its own `pathPattern` glob syntax). When nothing matches, it names the closest
pattern and the part that didn't match. iOS paths are decided by the AASA file, so check them with
`--online`, or with `--aasa <file>` for a local copy.

```bash
npx rn-deeplink test https://example.com/product/42
npx rn-deeplink test https://example.com/product/42 --online
```

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
