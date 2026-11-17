---
name: release
description: Ship a change to Compute, or cut a release of it. Use when asked to release, bump the version, tag, write the changelog, "commit, PR and merge", or "pull and restart" the user's copy. Covers the checks, the changelog entry, the version bump and the contract, the PR, the annotated tag with its notes, and moving the user's tower onto the release.
---

# Releasing Compute

Compute is a tower extension: `extension.json`, the server (`server.ts` over the pure `compute.ts`) and the Compute
page (`renderer/`), which ship together. A release is a number in `extension.json`'s `version`, a section in
`CHANGELOG.md`, a merge on `main` and an annotated tag `v<version>` whose message is that section. The steps run in
this order; skip the ones the user didn't ask for, and say which you skipped.

## 1. Check the change

```sh
npm ci
npm run types && npm run typecheck && npm test && npm run check
```

Then on a tower checkout's sandbox, never the user's tower: `npm run sandbox -- up` there, point the sandbox config's
`extensions.compute.path` (and `renderers.compute.root`, for the page) at your clone, and drive it with
`npm run -s sandbox -- run …` and `npm run drive -- <url>/r/compute/ --shot …`. A page change gets light, dark and a
narrow width (about 700px); read every shot, and put the ones that back what you report in the PR. The page's foot
should say the version you are about to release.

The user's tower serves the extension and the page straight from their clone: never switch that clone's branch to
work. Clone to the scratchpad, branch there, push from there.

## 2. Write the changelog entry

Under `## [Unreleased]` in `CHANGELOG.md`, while the change is made, in a user's words for what they see or can do:
`### Added` for a new verb, read, setting or something on the page, `### Changed` for what behaves differently,
`### Removed` for what is gone, `### Fixed` for a bug. Name a contributor's PR and handle: `(#3, thanks @name)`. Say
what a worker or the user notices, not which function changed.

## 3. Bump the version

The tower reads versions as `major.minor`, and other extensions want Compute at one (`"wants": { "compute": "1.0" }`
is met by 1.0 and any later 1.x). So:

- **major** (`1.4` → `2.0`) when the contract breaks: a name in `contract.json` removed or renamed, or a verb, read,
  fact or field that keeps its name but changes in meaning. The PR says why, and what a dependent uses instead.
- **minor** (`1.1` → `1.2`) for everything else: a new verb, read, setting, page feature, or a fix.

Change:

- `extension.json`: `version`.
- `contract.json`: after any change to the manifest's names, `tower extensions freeze .` rewrites it; commit what it
  writes. A major also resets what is held there.
- `CHANGELOG.md`: rename `## [Unreleased]` to `## [<version>] - <YYYY-MM-DD>`, put a fresh empty `## [Unreleased]`
  above it, and update the compare links at the foot (`[Unreleased]` from the new tag; the new version from the
  previous tag).
- `README.md`: the `wants` example under "For other extensions" on a major.

The bump can ride in the same PR as the change, as its own commit (`Compute <version>`), when the user asks for both.

## 4. Commit, PR, merge

- Branch from `origin/main` (`git fetch` first).
- Commit only what you mean to ship: never `.tower/`, `node_modules/` or scratch screenshots.
- `gh pr create --base main`: what changes, then what you checked and what you didn't. End with the attribution line.
- CI runs `npm test`: wait for it (`gh pr checks <n> --watch`).
- Merge (`gh pr merge --merge`) only when the user said to. Then `git fetch` and confirm
  `git show origin/main:extension.json | grep '"version"'`.

## 5. Tag, with the notes

The tag goes on the merge commit on `origin/main`, annotated, its message the title line `Compute <version>`, a blank
line, then the version's changelog section without its heading:

```sh
v=$(git show origin/main:extension.json | node -e 'process.stdin.on("data", (d) => console.log(JSON.parse(d).version))')
{ printf 'Compute %s\n\n' "$v"; git show origin/main:CHANGELOG.md | awk -v h="## [$v]" 'index($0, h) == 1 { on = 1; next } /^## |^\[/ { on = 0 } on'; } > "$TMPDIR/notes-$v"
cat "$TMPDIR/notes-$v"                      # read it before tagging
git tag -a "v$v" -F "$TMPDIR/notes-$v" origin/main --cleanup=whitespace
git push origin "v$v"
git tag -l -n99 "v$v"                       # what the tag says
```

`--cleanup=whitespace` trims the blank lines around the notes and keeps the `### Added` lines, which git's default
cleanup would drop as comments. Tags are published: never move or re-push one that is out unless the user asks.

## 6. Move the user's tower onto it

Only when the user asks ("pull and restart"). Their clone is the one their config's `extensions.compute.path` names:
look before touching it.

```sh
cd <the user's clone>
git status --short --branch                 # clean and on main, or stop and ask
git pull --ff-only
npm ci                                      # when package-lock.json changed
tower extensions restart compute
tower extensions | grep compute             # Compute <version> · running
```

The page needs no restart, only a reload: its foot should now say `Compute <version>`. After a major, an extension
that wants Compute at the old one (the lab) runs without it, its `run` refused, until its own release wants the new
major: release both together.
