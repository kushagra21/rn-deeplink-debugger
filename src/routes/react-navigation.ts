import { readFileSync, statSync } from "node:fs";
import { relative, sep } from "node:path";
import { parse } from "@babel/parser";
import { walk } from "../util/fs.js";
import { formatPath, parseReactNavigationPath, type Route, type RouterInfo } from "./routes.js";

type Node = { type: string; [key: string]: unknown };

/** A screen entry in a linking config, with its full path when it has one. */
interface ConfigEntry {
  name: string;
  chain: string[];
  path?: string;
  source: string;
}

/** A navigator from the static API: createXNavigator({ screens: { … } }). */
interface StaticNavigator {
  screens: { name: string; linking?: string; nested?: string }[];
}

const SKIPPED_DIRS = /(^|\/)(ios|android|dist|coverage|web-build|\.expo|__tests__|__mocks__)(\/|$)/;
const MAX_FILE_BYTES = 512 * 1024;

const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && typeof (value as Node).type === "string";

function visit(node: unknown, fn: (node: Node) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) visit(child, fn);
    return;
  }
  if (!isNode(node)) return;
  fn(node);
  for (const key in node) {
    if (key === "loc" || key.endsWith("Comments") || key === "extra") continue;
    const value = node[key];
    if (typeof value === "object" && value !== null) visit(value, fn);
  }
}

/** Strip TypeScript and Flow wrappers: `x as const`, `x satisfies T`, `(x)`. */
function unwrap(node: unknown): Node | undefined {
  let current = isNode(node) ? node : undefined;
  while (current && ["TSAsExpression", "TSSatisfiesExpression", "TSNonNullExpression", "ParenthesizedExpression", "TypeCastExpression"].includes(current.type)) {
    current = isNode(current.expression) ? current.expression : undefined;
  }
  return current;
}

const properties = (object: Node) => (object.properties as Node[]).filter((p) => p.type === "ObjectProperty");

function keyName(property: Node): string | undefined {
  if (property.computed) return undefined;
  const key = property.key as Node;
  return key.type === "Identifier" ? (key.name as string) : key.type === "StringLiteral" ? (key.value as string) : undefined;
}

const getProperty = (object: Node, name: string) => unwrap(properties(object).find((p) => keyName(p) === name)?.value);

function stringValue(node: Node | undefined): string | undefined {
  if (node?.type === "StringLiteral") return node.value as string;
  if (node?.type === "TemplateLiteral" && (node.expressions as unknown[]).length === 0) return ((node.quasis as Node[])[0]!.value as { cooked: string }).cooked;
  return undefined;
}

const joinPath = (...parts: (string | undefined)[]) =>
  parts
    .map((p) => p?.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");

const kebab = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[\s_]+/g, "-").toLowerCase();

const PARSE_PLUGINS: Record<string, ("typescript" | "jsx" | "flow")[]> = {
  ".ts": ["typescript"],
  ".mts": ["typescript"],
  ".tsx": ["typescript", "jsx"],
  ".js": ["jsx", "flow"],
  ".jsx": ["jsx", "flow"],
  ".mjs": ["jsx"],
};

/**
 * Deep link routes from React Navigation, read statically: the `linking` object passed to the
 * navigation container (`prefixes` and `config.screens`, also when `config` is a variable in the
 * same or another file), or the static API's per-screen `linking`. Screen names come from
 * `<X.Screen name="…">` elements and `create…Navigator({ screens })` calls.
 */
export function readReactNavigation(root: string): RouterInfo {
  const info: RouterInfo = { router: "react-navigation", source: "", routes: [], unlinkedScreens: [], unknownScreens: [], notes: [] };
  const declarations = new Map<string, { node: Node; file: string }>();
  const linkingObjects: { node: Node; file: string }[] = [];
  const declaredScreens = new Set<string>();
  const navigators = new Map<string, StaticNavigator>();
  // Navigators by their create…Navigator() call, named later from the variable they're assigned to.
  const navigatorCalls = new WeakMap<Node, StaticNavigator>();
  let staticRoot: string | undefined;
  let unparsed = 0;

  const files = walk(root, 10).filter((file) => {
    const rel = relative(root, file).split(sep).join("/");
    const ext = /\.[^.]+$/.exec(file)?.[0] ?? "";
    return PARSE_PLUGINS[ext] && !file.endsWith(".d.ts") && !SKIPPED_DIRS.test(rel) && !/\.(test|spec)\.[jt]sx?$/.test(file) && statSync(file).size <= MAX_FILE_BYTES;
  });

  for (const file of files) {
    const rel = relative(root, file).split(sep).join("/");
    let ast: unknown;
    try {
      ast = parse(readFileSync(file, "utf8"), { sourceType: "unambiguous", plugins: PARSE_PLUGINS[/\.[^.]+$/.exec(file)![0]!], errorRecovery: true });
    } catch {
      unparsed++;
      continue;
    }
    visit(ast, (node) => {
      if (node.type === "VariableDeclarator" && (node.id as Node).type === "Identifier") {
        const init = unwrap(node.init);
        const name = (node.id as Node).name as string;
        if (init && !declarations.has(name)) declarations.set(name, { node: init, file: rel });
      }
      if (node.type === "ObjectExpression" && properties(node).some((p) => keyName(p) === "prefixes")) linkingObjects.push({ node, file: rel });

      // <Stack.Screen name="Home" … />
      if (node.type === "JSXOpeningElement" && (node.name as Node).type === "JSXMemberExpression" && ((node.name as Node).property as Node).name === "Screen") {
        const nameAttr = (node.attributes as Node[]).find((a) => a.type === "JSXAttribute" && (a.name as Node).name === "name");
        const value = nameAttr && unwrap(nameAttr.value);
        const screen = stringValue(value?.type === "JSXExpressionContainer" ? unwrap(value.expression) : value);
        if (screen) declaredScreens.add(screen);
      }

      if (node.type === "CallExpression" && (node.callee as Node).type === "Identifier") {
        const callee = (node.callee as Node).name as string;
        const [arg] = node.arguments as Node[];
        // Static API: createStaticNavigation(RootStack)
        if (callee === "createStaticNavigation" && unwrap(arg)?.type === "Identifier") staticRoot = unwrap(arg)!.name as string;
        const config = unwrap(arg);
        const screens = /^create\w*Navigator$/.test(callee) && config?.type === "ObjectExpression" ? getProperty(config, "screens") : undefined;
        if (screens?.type === "ObjectExpression") {
          const navigator: StaticNavigator = { screens: [] };
          for (const property of properties(screens)) {
            const name = keyName(property);
            if (!name) continue;
            declaredScreens.add(name);
            const value = unwrap(property.value);
            const linking = value?.type === "ObjectExpression" ? getProperty(value, "linking") : undefined;
            const screen = value?.type === "ObjectExpression" ? getProperty(value, "screen") : value;
            navigator.screens.push({
              name,
              linking: stringValue(linking) ?? (linking?.type === "ObjectExpression" ? stringValue(getProperty(linking, "path")) : undefined),
              nested: screen?.type === "Identifier" ? (screen.name as string) : undefined,
            });
          }
          navigatorCalls.set(node, navigator);
        }
      }
    });
  }
  for (const [name, { node }] of declarations) {
    const navigator = navigatorCalls.get(node);
    if (navigator) navigators.set(name, navigator);
  }
  if (unparsed) info.notes.push(`${unparsed} source file${unparsed === 1 ? "" : "s"} couldn't be parsed and ${unparsed === 1 ? "was" : "were"} skipped.`);

  const resolveValue = (node: Node | undefined): Node | undefined => (node?.type === "Identifier" ? declarations.get(node.name as string)?.node : node);

  const entries: ConfigEntry[] = [];
  const readScreens = (screens: Node, parent: string | undefined, chain: string[], file: string) => {
    for (const property of properties(screens)) {
      const name = keyName(property);
      if (!name) {
        info.notes.push(`A screen in the linking config in ${file} has a computed name, so it was skipped.`);
        continue;
      }
      const value = resolveValue(unwrap(property.value));
      let own = stringValue(value);
      let exact = false;
      let nested: Node | undefined;
      if (own === undefined && value?.type === "ObjectExpression") {
        own = stringValue(getProperty(value, "path"));
        exact = getProperty(value, "exact")?.value === true;
        const screensValue = resolveValue(getProperty(value, "screens"));
        if (screensValue?.type === "ObjectExpression") nested = screensValue;
      } else if (own === undefined) {
        info.notes.push(`The path for "${name}" in ${file} is computed at runtime, so it wasn't read.`);
      }
      const path = own === undefined ? undefined : exact ? joinPath(own) : joinPath(parent, own);
      entries.push({ name, chain: [...chain, name], path, source: file });
      if (nested) readScreens(nested, path ?? parent, [...chain, name], file);
    }
  };

  const linking = linkingObjects[0];
  if (linkingObjects.length > 1) info.notes.push(`Found ${linkingObjects.length} linking configs; using the one in ${linking!.file}.`);
  const config = linking && resolveValue(getProperty(linking.node, "config"));
  const configScreens = config?.type === "ObjectExpression" ? resolveValue(getProperty(config, "screens")) : undefined;

  if (linking && configScreens?.type === "ObjectExpression") {
    info.source = linking.file;
    readScreens(configScreens, undefined, [], linking.file);
  } else if (staticRoot && navigators.has(staticRoot)) {
    // Static API: paths come from each screen's `linking`, or from the name with enabled: 'auto'.
    const auto = linking ? stringValue(getProperty(linking.node, "enabled")) === "auto" : false;
    info.source = linking?.file ?? declarations.get(staticRoot)!.file;
    let firstLeaf = true;
    const readNavigator = (navigator: StaticNavigator, parent: string | undefined, chain: string[]) => {
      for (const screen of navigator.screens) {
        const nested = screen.nested ? navigators.get(screen.nested) : undefined;
        let own = screen.linking;
        if (own === undefined && auto && !nested) own = firstLeaf ? "" : kebab(screen.name);
        if (!nested) firstLeaf = false;
        const path = own === undefined ? undefined : joinPath(parent, own);
        entries.push({ name: screen.name, chain: [...chain, screen.name], path, source: info.source });
        if (nested) readNavigator(nested, path ?? parent, [...chain, screen.name]);
      }
    };
    readNavigator(navigators.get(staticRoot)!, undefined, []);
    if (auto) info.notes.push("Paths for screens without their own `linking` come from enabled: 'auto' (kebab-case screen names; the first screen gets the empty path).");
  } else if (linking) {
    info.source = linking.file;
    info.notes.push(`The linking config in ${linking.file} has no readable config.screens (it may be built at runtime or imported from a package), so its routes weren't read.`);
  } else {
    info.notes.push("No linking config with `prefixes` was found, so React Navigation doesn't handle deep links. Pass a `linking` prop to NavigationContainer.");
  }

  info.routes = entries
    .filter((e): e is ConfigEntry & { path: string } => e.path !== undefined)
    .map((e): Route => {
      const segments = parseReactNavigationPath(e.path);
      return { path: formatPath(segments), segments, screen: e.chain.join(" > "), source: e.source };
    });

  const mapped = new Set(entries.map((e) => e.name));
  if (declaredScreens.size) {
    info.unknownScreens = entries.filter((e) => !declaredScreens.has(e.name)).map((e) => ({ name: e.name, path: e.path, source: e.source }));
  } else if (entries.length) {
    info.notes.push("No navigator screens were found in the source, so linking config entries couldn't be checked against them.");
  }
  if (entries.length) info.unlinkedScreens = [...declaredScreens].filter((name) => !mapped.has(name)).sort();
  return info;
}
