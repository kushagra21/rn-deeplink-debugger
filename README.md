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

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT
