# Home screen arrangement

Each user can show, hide, and reorder their own home groups from Personal → Appearance. Empty groups are not rendered. A new Last played games group lists games newest-first from when that user opened the retro player.

Web and desktop only (shared `packages/browser`). Expo stays hardcoded.

## Decisions

- Groups, in the default order:
  1. Continue reading (`IN_PROGRESS_BOOKS`)
  2. Last played games (`LAST_PLAYED_GAMES`)
  3. Your next read (`ON_DECK`)
  4. Recently added books (`RECENTLY_ADDED_BOOKS`)
  5. Recently added series (`RECENTLY_ADDED_SERIES`)
- Visibility is a preference. Emptiness is runtime. A hidden group stays hidden even when it later has items. A visible group with zero items renders nothing (no heading, no dashed empty card).
- The editor always lists these five. Drag to reorder, eye to show/hide. No add, delete, rename, or custom filters. Lock works like navigation: stored `locked: true` by default; edits are rejected until unlocked.
- Last played is one row per user and game, updated when `RetroPlayerScene` has a retro media id the user can access (including a disk switch to another retro id). It is not a reading session, not a save-state timestamp, and does not put games into Continue reading.
- Last played cards open the retro player (`paths.bookReader` with `isRetro`), not the book overview.
- Zero libraries still shows `NoLibraries` and ignores arrangement.
- If every visible group is empty, show one short fallback, not five empty groups. Link it to `/settings/preferences`.
- Recently added books still includes retro files. A game may appear in both Recently added and Last played.

## Out of scope

- Expo home and any Expo editor.
- Custom, library, or smart-list home groups.
- Filtering games out of Continue reading or Recently added.
- OPDS catalog groups.
- Play history (multiple rows per game) and recording plays from Expo or REST.

## Data

Do not add `OnDeck` or `LastPlayedGames` to the shared untagged `ArrangementConfig`. That enum cannot tell those apart from `InProgressBooks` on read-back, and navigation stores the same JSON shape.

Add a home-only model, still stored in `user_preferences.home_arrangement`:

- `HomeArrangement { locked, sections }`
- `HomeSection { kind, visible }`
- `kind` is an internally tagged enum: `IN_PROGRESS_BOOKS | LAST_PLAYED_GAMES | ON_DECK | RECENTLY_ADDED_BOOKS | RECENTLY_ADDED_SERIES`

`HomeArrangement::normalize` accepts the new shape and the current untagged shape:

- `entity: BOOKS` → recently added books; `entity: SERIES` → recently added series; name/links only → continue reading; `variant` or anything else → drop.
- Insert any missing built-in kind once, visible, at its default index.
- A saved row that already contains a kind keeps that kind’s `visible` and relative order. Do not resurrect a hidden group.

`default_home()` returns the five-kind list above, `locked: true`. Use it when the column is null. Writes always persist the tagged shape. Navigation arrangement is unchanged.

GraphQL, on `UserPreferences` / viewer mutations (same auth as navigation arrangement):

- Change `homeArrangement` from `Arrangement` to `HomeArrangement`. Nothing in this repo queries it today.
- `updateHomeArrangement(input)` and `updateHomeArrangementLock(locked)`. Reject section updates while locked. Input must be exactly the five kinds, each once.
- `lastPlayedGames(pagination)` — same access and `deleted_at` rules as `keepReading` (`media::Entity::apply_for_user`). Order by `last_played_at DESC`. Offset pagination, page size 20, same cursor limitation as `keepReading` if cursor is unsupported there.
- `recordMediaPlay(id: ID!)` — current user only; media must be visible to them and have a retro extension; upsert `last_played_at`. Do not create a reading session.

New table `media_last_played`, modeled on `media_save_states`:

- `id` text PK, `user_id`, `media_id`, `last_played_at` timestamptz
- FKs to users and media, cascade delete
- unique `(user_id, media_id)`
- Register the migration in `crates/migrations/src/lib.rs` and the entity beside `media_save_state`

`RetroPlayerScene` calls `recordMediaPlay` once per retro media id it opens. Failure is logged and does not block playback. On success, invalidate the last-played query key.

## Home rendering

`HomeScene` loads `numberOfLibraries` and `me.preferences.homeArrangement`.

- `numberOfLibraries === 0`: `NoLibraries` only.
- Otherwise render visible kinds in stored order. Each existing section component returns `null` when its list is empty. Remove those empty-state branches.
- Add `LastPlayedGames` using the same horizontal card list as recently added books, with the retro player link and a “last played” relative time if the card subtitle already has a place for it. Do not show page progress.
- Prefetch only the visible sections in `usePrefetchHomeScene`.

## Settings UI

In `AppearanceSettingsScene`, add a Home card under Layout and arrangement (do not bury it inside the navigation card).

Copy `navigation-arrangement/`: sheet, `@dnd-kit` reorder, eye toggle, lock/unlock. Section ids are the five kinds. Labels from `en-US.json` (`homeScene.*` titles plus a new last-played title, and settings strings next to `navigationArrangement`). Other locales fall back to en-US; do not translate them.

Refetch the home arrangement query and the home scene query after a successful save or lock change.

## Failure modes

- Legacy three-section JSON must still show Your next read. That group exists in the UI today and is missing from `Arrangement::default_home()`.
- Unknown or duplicate kinds must not crash the home page or the settings sheet.
- A locked arrangement cannot be reordered or hidden via the mutation, including a direct GraphQL call.
- `recordMediaPlay` for another user’s media, a missing id, or a non-retro file returns an error and writes nothing.
- Player open still works if the play mutation fails.
- Deleting a user or media removes their last-played rows via FK cascade.

## Validation

- Unit tests for `normalize`: old default JSON becomes the five-kind default; a tagged arrangement with On deck hidden stays hidden; unknown kinds are dropped; duplicates collapse.
- Unit or query test: two opens of the same game keep one row and move it to the front; a second game stays behind; another user’s row is not returned.
- `cargo fmt --manifest-path=core/Cargo.toml` is not the right manifest if only `crates/models`, `crates/graphql`, or `crates/migrations` change — format those crates’ manifests. Run `cargo dump-schema`, then `packages/graphql` codegen and `packages/browser` codegen so the new operations typecheck.
- Format touched `*.{ts,tsx,json}` with `node ./node_modules/prettier/bin/prettier.cjs --config prettier.config.js --write <files>`.
