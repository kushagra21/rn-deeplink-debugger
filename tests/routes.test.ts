import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRoutes, type RoutesReport } from "../src/commands/routes.js";
import { runTest } from "../src/commands/test.js";
import { parseLinkUrl } from "../src/match.js";
import { readExpoRouter } from "../src/routes/expo-router.js";
import { matchRoute, navigationPath, parseReactNavigationPath, readRoutes, samplePath, type Route } from "../src/routes/index.js";
import { readReactNavigation } from "../src/routes/react-navigation.js";
import type { TestReport } from "../src/types.js";

const fixture = (name: string) => join(import.meta.dirname, "..", "fixtures", name);
const paths = (routes: Route[]) => routes.map((r) => `${r.path} → ${r.screen}`);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rn-deeplink-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Write a project from { path: contents }. */
const project = (files: Record<string, string>) => {
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), contents);
  }
  return dir;
};

describe("Expo Router", () => {
  it("reads routes from app/, skipping groups, layouts, special files and API routes", () => {
    const info = readExpoRouter(fixture("expo-router-app"));
    expect(paths(info.routes)).toEqual(["/ → /", "/settings → /settings", "/about → /about", "/blog/*slug → /blog/[...slug]", "/product/:id → /product/[id]"]);
    expect(info.routes.find((r) => r.path === "/about")!.source).toBe("app/about.tsx");
    expect(info.hasNotFound).toBe(true);
  });

  it("uses src/app and explains a missing folder", () => {
    project({ "src/app/index.tsx": "", "src/app/[user]/posts.tsx": "" });
    expect(paths(readExpoRouter(dir).routes)).toEqual(["/:user/posts → /[user]/posts", "/ → /"]);
    rmSync(join(dir, "src"), { recursive: true });
    expect(readExpoRouter(dir).notes).toEqual([expect.stringContaining("has no app/ or src/app/ folder")]);
  });
});

describe("React Navigation", () => {
  it("reads a linking config held in a variable, with nested navigators", () => {
    const info = readReactNavigation(fixture("react-navigation-app"));
    expect(info.source).toBe("src/navigation/linking.ts");
    expect(paths(info.routes)).toEqual([
      "/feed → HomeTabs > Feed",
      "/settings → HomeTabs > Settings",
      "/product/:id → Product",
      "/user/:id? → Profile",
      "/legacy → Legacy",
      "/* → NotFound",
    ]);
    expect(info.unknownScreens).toEqual([{ name: "Legacy", path: "legacy", source: "src/navigation/linking.ts" }]);
    expect(info.unlinkedScreens).toEqual(["Checkout"]);
    expect(info.notes).toEqual([]);
  });

  it("follows path, exact and nested paths, and a config imported from another file", () => {
    project({
      "src/linkingConfig.ts": `export const screensConfig = {
        screens: {
          Home: { path: "home", screens: { Feed: "feed", Post: { path: "/post/:id", exact: true } } },
          Settings: \`settings\`,
          Dynamic: buildPath("x"),
        },
      };`,
      "App.tsx": `import { screensConfig } from "./src/linkingConfig";
        const linking = { prefixes: ["app://"], config: screensConfig };
        export default () => <NavigationContainer linking={linking}><Stack.Navigator><Stack.Screen name="Home" component={H} /></Stack.Navigator></NavigationContainer>;`,
    });
    const info = readReactNavigation(dir);
    expect(paths(info.routes)).toEqual(["/home → Home", "/home/feed → Home > Feed", "/post/:id → Home > Post", "/settings → Settings"]);
    expect(info.notes).toEqual(['The path for "Dynamic" in App.tsx is computed at runtime, so it wasn\'t read.']);
  });

  it("reads the static API, with explicit and automatic paths", () => {
    project({
      "App.tsx": `
        const HomeTabs = createBottomTabNavigator({ screens: { Feed: FeedScreen, Inbox: { screen: InboxScreen } } });
        const RootStack = createNativeStackNavigator({
          screens: {
            Home: { screen: HomeTabs },
            Profile: { screen: ProfileScreen, linking: { path: "user/:id" } },
            Settings: { screen: SettingsScreen, linking: "prefs" },
          },
        });
        const Navigation = createStaticNavigation(RootStack);
        export default () => <Navigation linking={{ prefixes: ["app://"], enabled: "auto" }} />;`,
    });
    const info = readReactNavigation(dir);
    expect(paths(info.routes)).toEqual(["/ → Home > Feed", "/inbox → Home > Inbox", "/user/:id → Profile", "/prefs → Settings"]);
    expect(info.unknownScreens).toEqual([]);
  });

  it("explains a project without a linking config", () => {
    project({ "App.tsx": "export default () => <NavigationContainer><Stack.Screen name=\"Home\" /></NavigationContainer>;" });
    const info = readReactNavigation(dir);
    expect(info.routes).toEqual([]);
    expect(info.notes).toEqual([expect.stringContaining("No linking config with `prefixes` was found")]);
  });

  it("skips files it can't parse", () => {
    project({ "App.tsx": "const linking = { prefixes: ['app://'], config: { screens: { Home: 'home' } } };", "src/broken.ts": "const = ;;; {" });
    expect(paths(readReactNavigation(dir).routes)).toEqual(["/home → Home"]);
  });
});

describe("route matching", () => {
  const routes = (...defs: string[]): Route[] =>
    defs.map((path) => ({ path, segments: parseReactNavigationPath(path), screen: path, source: "x" }));

  it("prefers static segments over params and catch-alls", () => {
    const all = routes("*", "product/:id", "product/new", "product/:id/reviews");
    expect(matchRoute(all, "/product/new")?.route.path).toBe("product/new");
    expect(matchRoute(all, "/product/42")).toMatchObject({ route: { path: "product/:id" }, params: { id: "42" } });
    expect(matchRoute(all, "/product/42/reviews")?.route.path).toBe("product/:id/reviews");
    expect(matchRoute(all, "/anything/else")).toMatchObject({ route: { path: "*" }, params: { "*": ["anything", "else"] } });
  });

  it("handles optional params, decoding and query params", () => {
    const all = routes("user/:id?");
    expect(matchRoute(all, "/user")).toMatchObject({ params: {} });
    expect(matchRoute(all, "/user/a%20b", "tab=posts")).toMatchObject({ params: { id: "a b", tab: "posts" } });
    expect(matchRoute(all, "/user/a/b")).toBeNull();
  });

  it("reads custom scheme URLs with the host as the first segment", () => {
    expect(navigationPath(parseLinkUrl("shop://product/42")!)).toBe("/product/42");
    expect(navigationPath(parseLinkUrl("shop://")!)).toBe("/");
    expect(navigationPath(parseLinkUrl("https://example.com/product/42/")!)).toBe("/product/42");
  });

  it("builds sample paths", () => {
    expect(samplePath(routes("user/:id?/posts/:post")[0]!)).toBe("/user/posts/example");
  });
});

describe("routes command", () => {
  const report = (name: string): RoutesReport => {
    const result = runRoutes({ cwd: fixture(name) });
    if ("error" in result) throw new Error(result.error);
    return result;
  };
  const messages = (r: RoutesReport, level: string) => r.findings.filter((f) => f.level === level).map((f) => f.message);

  it("shows which links reach each Expo Router route", () => {
    const result = report("expo-router-app");
    expect(result.routes.find((r) => r.path === "/product/:id")).toEqual({
      path: "/product/:id",
      screen: "app/product/[id].tsx",
      ios: ["shop://", "https://shop.example.com (AASA)"],
      android: ["shop://", "https://shop.example.com"],
    });
  });

  it("reports links that land on no route, and routes App Links don't reach", () => {
    const result = report("expo-router-app");
    expect(messages(result, "warning")).toEqual([
      'Saved link "Old page" (https://shop.example.com/old/thing) opens the app, but no route matches /old/thing, so Expo Router shows app/+not-found.',
      'Saved link "Missing" (shop://missing/page) opens the app, but no route matches /missing/page, so Expo Router shows app/+not-found.',
      "The Android filter for https://shop.example.com/old* (app.json → android.intentFilters[0]) opens the app, but no route matches /old/example, so Expo Router shows app/+not-found.",
    ]);
    expect(messages(result, "info")).toEqual([expect.stringContaining("these 4 routes, so https links to them open in the browser on Android: /, /settings, /about, /blog/*slug")]);
  });

  it("reports React Navigation config entries for missing screens, unlinked screens and catch-all landings", () => {
    const result = report("react-navigation-app");
    expect(messages(result, "warning")).toEqual([
      expect.stringContaining('maps "Legacy" to /legacy, but no navigator has a screen called "Legacy"'),
      'Saved link "Cart" (bareapp://cart) opens the app, but only the catch-all route /* matches /cart, so it lands on NotFound.',
    ]);
    expect(messages(result, "info")).toEqual([
      "1 screen has no deep link path, so links can't open it directly: Checkout.",
      expect.stringContaining("these 3 routes, so https links to them open in the browser on Android: /feed, /settings, /user/:id?"),
    ]);
  });

  it("explains a project with neither router", () => {
    expect(runRoutes({ cwd: fixture("bare-rn") })).toEqual({ error: expect.stringContaining("No Expo Router or React Navigation found") });
    expect(readRoutes(fixture("bare-rn"))).toBeNull();
  });
});

describe("test: the screen a URL opens", () => {
  const screen = async (url: string, name: string) => {
    const result = await runTest(url, { cwd: fixture(name) });
    if ("error" in result) throw new Error(result.error);
    return (result as TestReport).screen!;
  };

  it("names the Expo Router route and its params", async () => {
    expect(await screen("shop://blog/2026/hello", "expo-router-app")).toEqual({
      router: "Expo Router",
      checks: [{ level: "pass", message: 'Opens app/blog/[...slug].tsx with {"slug":["2026","hello"]}' }],
    });
    expect((await screen("shop://nope", "expo-router-app")).checks[0]).toMatchObject({ level: "warning", message: "No Expo Router route matches /nope, so Expo Router shows app/+not-found." });
  });

  it("names the React Navigation screen, and flags missing screens", async () => {
    expect((await screen("https://example.com/user/9", "react-navigation-app")).checks).toEqual([{ level: "pass", message: 'Opens Profile with {"id":"9"}' }]);
    expect((await screen("bareapp://legacy", "react-navigation-app")).checks[0]).toMatchObject({ level: "error" });
  });

  it("leaves the screen out for projects without a router", async () => {
    const result = await runTest("bareapp://x", { cwd: fixture("bare-rn") });
    expect("error" in result || result.screen).toBeFalsy();
  });
});
