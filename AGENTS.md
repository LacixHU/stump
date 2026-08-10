# Agent notes

## Pre-commit (husky + lint-staged)

Commits fail if staged files are not formatted. Always format before committing:

- **Rust (`*.rs`)**: `cargo fmt --manifest-path=core/Cargo.toml` (also server/desktop manifests if those crates changed). Do not leave import/line wraps that rustfmt would rewrite.
- **JS/TS/JSON/MD (`*.{js,jsx,ts,tsx,md,json}` and mdx as applicable)**: `npx prettier --config prettier.config.js --write <files>` on changed files.

lint-staged runs `prettier --check` and `cargo fmt --check` only — it does not auto-fix. Fix formatting, re-stage, then commit.

npm warnings about unknown project config (`strict-peer-dependencies`, `node-linker`, `min-release-age`) come from `.npmrc` (pnpm-oriented keys) and are unrelated to the commit failure.
