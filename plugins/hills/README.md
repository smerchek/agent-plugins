# hills

A Claude Code mod that shows a hillclimb as a row of tiny hills above the prompt, one per metric. The climbed part of each hill is solid green and the rest is a grey outline, so you can see at a glance how far up each one is. A faint blue rise after a hill means there is more to climb past it. Each hill has a short label (`img`, `boot`, `cov`). Hover a hill for its details: baseline to now, target or estimated ceiling, rounds tried and reverted, and the outside read.

It needs no log file or format. After each turn it forks the session's own transcript (`$.model.fork`, served mostly from the prompt cache) and asks which metrics are being climbed, with their baseline, rounds, reverts and any stated target. A second call (`$.model.complete`, no session history) gives an outside read on each hill:

- **Still climbing**: steady gains
- **Leveling off**: gains shrinking toward this approach's ceiling
- **At the top of this hill**: this approach is done
- **Higher hills past this one**: a different approach could go much further, with up to three ideas

That read also estimates a ceiling, which becomes the summit when there is no target or the target has been passed.

The agent sees each new outside read too. It rides along with your next prompt as context the model reads and you do not, framed as a second opinion from a reviewer that saw only the numbers. Each read goes once, and a later read of the same hill goes again when it changes. `/hills private` keeps the reads on hover only.

Hover needs a surface that reports the pointer: the desktop app or the terminal's fullscreen layout.

## Use

- `/hills` reads the climb now and shows the band
- `/hills assess` asks for a fresh outside read
- `/hills private` / `/hills share` keeps outside reads from the agent, or hands them over again (the default)
- `/hills off` hides the band and stops reading after each turn

Tracking also turns on by itself when a prompt mentions hillclimbing, optimizing, slimming or reducing a size or time. It reads at most once a minute.

## Install

```
/plugin marketplace add smerchek/agent-plugins
/plugin install hills@smerchek
```

To work on it, load the folder directly; saving a file reloads the mod:

```bash
claude --plugin-dir plugins/hills
```

`/plugin-types plugins/hills/.claude/types` writes the engine's type declarations so `tsc -p plugins/hills` type-checks the module.
