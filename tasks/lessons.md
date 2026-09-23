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

## `relative="path"` in react-router does not resolve against the URL

**What went wrong:** a pathless guard route under a `:id/*` layout redirected with
`<Navigate to=".." />` and landed on the collection root (`/series`) instead of the entity.
I "fixed" it with `relative="path"`, reasoning that path-relative `..` would pop one URL
segment off `/series/:id/settings` and give `/series/:id`. It gives `/series` too. I only
caught it because I ran the resolver instead of trusting the reasoning.

`resolveTo` in `@remix-run/router` only falls back to `locationPathname` when `to` has **no
pathname at all** (a search- or hash-only `to`). Whenever `to` has a pathname, `from` is the
last path-contributing match's `pathnameBase` — for both `relative="route"` and
`relative="path"`. All the flag changes is whether leading `..` segments pop _routes_ before
that. And `getPathContributingMatches` filters pathless routes out, so a guard rendered in
one resolves as if it were its parent layout.

**The rule:** for a redirect out of a pathless guard, `to="."` is the parent layout's path
(`/series/:id`) and `to=".."` is one above it (`/series`) — never reach for `relative="path"`
to mean "one URL segment up". When a relative destination matters, check it before building:

```js
const R = require('./node_modules/@remix-run/router/dist/router.cjs.js')
const m = R.matchRoutes(routes, '/series/abc/settings', '/series')
// feed the path-contributing pathnameBases into R.resolveTo and read the answer
```

This is also why guards that sit on `/:id/settings` need an explicit destination rather than
a relative one: `LibraryAdminLayout` renders under nested settings paths, so any relative
form either loops or overshoots.

## DOS mouse fixes: prove them in a real game, not a test program

Two rounds of "touch cursor fixed" failed on the phone. Unit tests passed and a tiny
mode-13h COM test showed the INT 33h cursor moving, yet Indiana Jones never moved at all:
its bundled `dosbox.conf` set `autolock=true`, which makes DOSBox drop all mouse motion until
a click captures the mouse. Desktop worked only because the first click did that capture.

**The rule:** for DOS input bugs, check the bundle's `dosbox.conf` first, since later `-conf`
files override js-dos options. Then verify in the actual game the user plays, using the
headless harness (`drive-dos-from-headless-chrome` memory). Also try a real mouse in the same
session: if the mouse fails too, the bug is below the touch layer.
