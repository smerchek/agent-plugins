# agent-plugins

Small plugins for coding agents. MIT licensed.

## Install

Claude Code:

```
/plugin marketplace add smerchek/agent-plugins
/plugin install hills@smerchek
```

Hosts that read the open `.agents/plugins/marketplace.json` catalog (Codex, ChatGPT) can import this repo too. That catalog lists only plugins that ship portable `skills/`. Plugins built on one host's own APIs, like the Claude Code mods, appear only in that host's catalog.

## Plugins

| Plugin | Hosts | What it does |
|---|---|---|
| [hills](plugins/hills) | Claude Code | Draws each metric a session is hillclimbing as a hill, with how far up it is and an outside read on whether there is more to climb |

## Layout

```
plugins/<name>/plugin.json         # canonical manifest (Agent Plugins 1.0); edit this
plugins/<name>/.claude-plugin/     # generated Claude Code manifest
.claude-plugin/marketplace.json    # generated Claude Code catalog
.agents/plugins/marketplace.json   # generated open catalog, when any plugin ships skills/
```

Host-specific manifest fields go under `extensions` in the canonical manifest, keyed by host (`com.anthropic.claude-code`, `com.openai`). After editing one:

```bash
bun run build
```

`bun run check` (run in CI) fails if the generated files are out of date or a manifest does not match the schema. `bun run validate:claude` runs `claude plugin validate` on every plugin.
