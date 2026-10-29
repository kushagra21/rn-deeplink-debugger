import type { LinkingOptions } from "@react-navigation/native";
import type { RootStackParamList } from "./types";

const config = {
  screens: {
    HomeTabs: {
      screens: {
        Feed: "feed",
        Settings: "settings",
      },
    },
    Product: "product/:id",
    Profile: { path: "user/:id?" },
    Legacy: "legacy",
    NotFound: "*",
  },
} as const;

export const linking: LinkingOptions<RootStackParamList> = {
  prefixes: ["bareapp://", "https://example.com"],
  config,
};
