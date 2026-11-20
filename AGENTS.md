# Project instructions

Read `CLAUDE.md` for architecture, commands and existing project conventions.

## Local overrides

If `local/AGENTS.md` exists in this checkout, read and follow its environment-specific rules
(such as execution/build host policies) as authoritative overrides.

## Hub execution host policy

By default, hub workers only receive generic working-directory rules. Operators who separate
coordination hosts from build/packaging hosts can configure `HUB_HOST_POLICY` (and optionally
`HUB_WORKDIR_RULE`) or export `LOCAL_HOST_POLICY` / `LOCAL_WORKDIR_RULE` from an untracked
`local/presets.mjs` module (see `src/local-loader.mjs` and `src/hub/runner.mjs`).
