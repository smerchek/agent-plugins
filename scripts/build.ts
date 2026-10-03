// Generates every host-specific file from each plugin's canonical
// plugins/<name>/plugin.json (Agent Plugins 1.0):
//   .claude-plugin/marketplace.json           Claude Code catalog, every plugin
//   plugins/<name>/.claude-plugin/plugin.json Claude Code manifest
//   .agents/plugins/marketplace.json          open catalog, plugins that ship skills/
// A plugin with no skills/ (a Claude Code mod, say) has nothing another host
// can run, so it stays out of the open catalog.
// `--check` fails on drift or an invalid manifest instead of writing.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import schema from "./schemas/plugin-1.0.0.schema.json";

const root = resolve(import.meta.dir, "..");
const isCheck = process.argv.includes("--check");
const CLAUDE = "com.anthropic.claude-code";
const OPENAI = "com.openai";
const OWNER = { name: "Scott Smerchek", url: "https://github.com/smerchek" };
let isFailing = false;

// Implements the keywords the pinned 1.0.0 schema uses; no network in CI.
function validate(value: any, rule: any, path: string): string[] {
  const errors: string[] = [];
  if (rule.type) {
    const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    if (type !== rule.type) return [`${path}: expected ${rule.type}, got ${type}`];
  }
  if (typeof value === "string") {
    if (rule.minLength !== undefined && value.length < rule.minLength) errors.push(`${path}: too short`);
    if (rule.maxLength !== undefined && value.length > rule.maxLength) errors.push(`${path}: too long`);
    if (rule.pattern && !new RegExp(rule.pattern).test(value)) errors.push(`${path}: does not match ${rule.pattern}`);
  }
  if (Array.isArray(value) && rule.items) value.forEach((item, i) => errors.push(...validate(item, rule.items, `${path}[${i}]`)));
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of rule.required ?? []) if (!(key in value)) errors.push(`${path}: missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      const child = rule.properties?.[key] ?? rule.additionalProperties;
      if (child === false) errors.push(`${path}: unknown field ${key}`);
      else if (child && typeof child === "object") errors.push(...validate(item, child, `${path}.${key}`));
    }
  }
  return errors;
}

function emit(path: string, data: unknown | undefined) {
  const file = resolve(root, path);
  const current = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  const text = data === undefined ? undefined : JSON.stringify(data, null, 2) + "\n";
  if (text === current) return;
  if (isCheck) {
    console.error(`Out of date: ${path} (run bun run build)`);
    isFailing = true;
    return;
  }
  if (text === undefined) rmSync(file);
  else {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  console.log(`${text === undefined ? "Removed" : "Updated"} ${path}`);
}

const plugins = readdirSync(resolve(root, "plugins"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map(({ name }) => {
    const manifest = JSON.parse(readFileSync(resolve(root, "plugins", name, "plugin.json"), "utf8"));
    const errors = validate(manifest, schema, `plugins/${name}/plugin.json`);
    if (manifest.name !== name) errors.push(`plugins/${name}/plugin.json: name differs from folder`);
    errors.forEach((error) => console.error(error));
    if (errors.length) isFailing = true;
    return { manifest, isPortable: existsSync(resolve(root, "plugins", name, "skills")) };
  })
  .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));

for (const { manifest } of plugins) {
  const { $schema, extensions, ...identity } = manifest;
  const { category, ...claude } = extensions?.[CLAUDE] ?? {};
  emit(`plugins/${manifest.name}/.claude-plugin/plugin.json`, { ...identity, ...claude });
}

emit(".claude-plugin/marketplace.json", {
  name: "smerchek",
  owner: OWNER,
  metadata: { description: "Scott Smerchek's small plugins for coding agents." },
  plugins: plugins.map(({ manifest }) => ({
    name: manifest.name,
    displayName: manifest.extensions?.[CLAUDE]?.displayName,
    source: `./plugins/${manifest.name}`,
    description: manifest.description,
    category: manifest.extensions?.[CLAUDE]?.category ?? "productivity",
  })),
});

const portable = plugins.filter((p) => p.isPortable);
emit(
  ".agents/plugins/marketplace.json",
  portable.length === 0
    ? undefined
    : {
        name: "smerchek",
        interface: { displayName: "Scott Smerchek" },
        plugins: portable.map(({ manifest }) => ({
          name: manifest.name,
          source: { source: "local", path: `./plugins/${manifest.name}` },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: manifest.extensions?.[OPENAI]?.interface?.category ?? "Productivity",
        })),
      },
);

if (isFailing) process.exit(1);
