# hills

A Claude Code mod that shows a hillclimb as hills: one per metric, with a climber marking how far from the baseline toward the top you are.

It needs no log file or format. After each turn it forks the session's own transcript (`$.model.fork`, served mostly from the prompt cache) and asks which metrics are being climbed, with their baseline, rounds, reverts and any stated target. A second call (`$.model.complete`, no session history) gives an outside read on each hill:

- **still climbing**: steady gains
- **leveling off**: gains shrinking toward this approach's ceiling
- **at the top of this hill**: this approach is done
- **higher hills past this one**: a different approach could go much further, with up to three ideas

That read also estimates a ceiling, which becomes the summit when there is no target or the target has been passed. A blue ridge behind the hill means there is more to climb past it.

## Use

- `/hills` opens the pane and reads the climb now
- `/hills assess` asks for a fresh outside read
- `/hills off` stops reading after each turn

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
