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

## Vendored bundles must be added to `.prettierignore`

**Mistake:** Staged `packages/browser/public/retro/spectrum/jsspeccy.js` and
`jsspeccy-worker.js` (upstream JSSpeccy build output). lint-staged ran
`prettier --check` on them, they failed, and husky reverted the whole commit.

**Rule:** Whenever a new `.js`/`.json`/`.md` file is vendored or generated,
add its glob to `.prettierignore` _in the same change, before `git add`_.
Never reformat upstream artifacts to satisfy the hook.

**Check before committing:**

```sh
git diff --cached --name-only --diff-filter=ACMR \
  | grep -E '\.(js|jsx|ts|tsx|md|json)$' \
  | xargs node ./node_modules/prettier/bin/prettier.cjs --config prettier.config.js --check
```

## Verify network heuristics against the live service before calling it done

**What went wrong:** I reordered the Wikipedia cover lookup to try the platform cover
category before the game's article, reasoned about why that was better, shipped it with
unit tests over the pure helpers, and reported it working. The first game the user tried
(`Pirates [Side B].d64`) found nothing. Three further bugs only showed up once I actually
ran the lookup against Wikipedia:

- `lookup_article_cover` only ran its `"{title} video game"` fallback when the plain search
  returned **zero** hits. A generic name like "Pirates" always returns hits -- the wrong
  ones -- so the fallback was dead code exactly when it was needed.
- `titles_similar`'s `a.contains(&q)` shortcut matched "Shadow of the Beast II" for
  "Shadow of the Beast", handing a sequel's box art to the original.
- `is_video_game_page` required the literal words "video game"; the 1989 Shadow of the
  Beast article calls itself a "platform game", so the right article was skipped in favour
  of the 2016 remake.

None of these were visible from reading the code, and all three were obvious within two
minutes of calling the real API.

**The rule:** when a change depends on what a remote service actually returns -- a search
ranking, a category's contents, the wording of a summary -- probe the live endpoint with
`curl` first to establish ground truth, and add a runnable example so the whole chain can
be exercised end to end. Unit tests over pure helpers prove the helpers, not the lookup.

`cargo run -q -p metadata_integrations --example cover_lookup -- "Pirates" c64`

Check a batch, not one title, and always include a known true negative (Zamzara has no
Wikipedia cover) so a "fix" that starts inventing matches is caught.
