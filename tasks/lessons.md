# Lessons

Patterns to avoid repeating. Reviewed at the start of a session.

## Format every file before reporting work as done

**What went wrong:** I finished a task leaving `tasks/todo.md` unformatted. The husky
`pre-commit` hook runs `npx lint-staged`, which runs prettier with `--check` (not
`--write`), so the commit was blocked and the user had to come back and ask for a fix.

**The rule:** after the last edit of a task, format everything touched — including files I
authored myself, like notes and todo entries — then re-stage.

- `*.{js,jsx,ts,tsx,md,json}`:
  `node ./node_modules/prettier/bin/prettier.cjs --config prettier.config.js --write <files>`
  (`.mdx` is not in the lint-staged glob, but format it anyway)
- `*.rs`: `cargo fmt`. The hook checks three separate manifests, so verify all three:
  `core/Cargo.toml`, `apps/server/Cargo.toml`, `apps/desktop/src-tauri/Cargo.toml`
