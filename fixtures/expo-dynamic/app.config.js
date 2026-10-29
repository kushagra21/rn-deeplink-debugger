module.exports = ({ config }) => ({
  ...config,
  name: "Dynamic",
  slug: "dynamic",
  scheme: process.env.APP_SCHEME ?? "dynamic",
  ios: { bundleIdentifier: "com.example.dynamic", associatedDomains: ["applinks:dynamic.example.com"] },
  android: {
    package: "com.example.dynamic",
    intentFilters: [
      {
        action: "VIEW",
        autoVerify: true,
        data: [{ scheme: "https", host: "dynamic.example.com" }],
        category: ["BROWSABLE", "DEFAULT"],
      },
    ],
  },
});
