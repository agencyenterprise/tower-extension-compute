# Changelog

What changed in each release of Compute, newest first. A version is `extension.json`'s `version`, `major.minor` as
the tower reads it, and each is tagged `v<version>`, the tag's message carrying its section below. A **major** changes
the contract other extensions want (`contract.json`: a verb, read, fact or field removed, renamed or changed in
meaning); every other release is a **minor**, fixes included. How to cut one:
[the release skill](.claude/skills/release/SKILL.md).

## [Unreleased]

## [1.7] - 2026-11-18

### Fixed
- A card's CPU sparkline no longer shows a grey band spilling past the card's edge when pointed at near its end: each
  reading's band now runs halfway to its neighbours and stays inside the chart. Its readings show the tower's own
  tooltip, as everything else on the page does, instead of the browser's.

## [1.6] - 2026-11-18

### Added
- The Compute page groups the jobs by a tag: a **Group by** picker beside the filters, kept in the page's hash. Each
  value of the tag is a card: its CPU and memory now as bars against the machine's, the lanes it holds as lamps, its
  cap's slots, its CPU over the last minutes as a sparkline, and a dot per job in the colour of where it stands.
  Pressing a card's name shows only its jobs.
- With the lab running, the page groups by mission unless told otherwise: each open mission is a card, with its title,
  floor, playbook and coordinator, its phases as a stepper, a **Room** button to its room on the Lab page, and its
  crew. Its bars add its crew's processes to its jobs', in two colours, so the card shows what the whole mission uses
  now. A closed mission shows only while jobs of it do. Without the lab, nothing changes until you pick a tag.

### Changed
- The teal of Compute's jobs and, in the dark scheme, the blue of workers are a step stronger, so the two tell apart
  for every reader.

## [1.5] - 2026-11-18

### Changed
- Compute declares its page in its manifest (`renderers.compute`, the `renderer/` folder), so `/r/compute/` comes with
  the extension: delete `renderers.compute` from `~/.tower/config.json` and keep `extensions.compute.path`.
- Compute needs the tower 2.13, for a renderer declared in the manifest.

## [1.4] - 2026-11-18

### Added
- `tower x compute machine` (the read `compute/machine`): the machine's load, memory and disk, and every process's CPU
  and memory by owner: each worker, whatever its runtime, each compute job, other jobs, the tower's shells, the tower
  itself and everything else.
- The Compute page shows the machine over the queue, a band of tiles: CPU, memory and disk; who uses them; the
  heaviest workers and jobs; each floor's workers; and every job in the jobs daemon by who started it.

### Changed
- Compute needs the tower 2.10, for each job's `pid` on the board: a job's processes are found by its process group.

## [1.3] - 2026-11-17

### Fixed
- A job's screen draws at your terminal size, as the tower page's terminals do, not at about 6 px: its 120×40 cells
  get their full size in the card, which scrolls and follows the job's cursor. Its ground is the Lobby's graphite, not
  the core's green-black, and fills the card under its head.

## [1.2] - 2026-11-17

### Changed
- The page wears the Lobby look: the jobs in a card set into the window, the system face, Lobby's greys and blue
  accent in light and dark, sentence-case section heads, flat rows and quiet buttons, and the job's screen in a card
  of its own. A running job's lamp is amber and one that exited 0 green, as Lobby's working and done.
- A **Tower** button at the top left goes back to the tower page; the page's name is no longer the way back.

## [1.1] - 2026-11-17

### Added
- The Compute page at `/r/compute/` (declare `renderers.compute`): the lanes meter, your list, what runs, what waits and
  what ended in the last day, filters by floor and tag, a job's live screen, and Cancel, Withdraw and Seen.
- Compute's version at the page's foot, as the tower loaded it; pressing it copies a line for a bug report.
- `seen <n>`: takes a job off your list.
- The board carries `x.compute` (the resources, what is in use and the jobs), and a job no one could be told of
  joins your list.

### Changed
- A requester that isn't running when its job ends is resumed with the line as its first prompt, found on the board
  or in its floor's archive. One busy at a question or a Claude screen is told once it's back at its prompt. Only a
  requester gone for good, or a job queued from outside a worker, lands on your list.

## [1.0] - 2026-11-17

### Added
- Compute: a queue for long or heavy commands on the tower's machine. `run` queues a command within the machine's
  named resources, oldest first, in the tower's jobs daemon; `jobs` lists the queue; `cancel` withdraws or stops one.
- Tags and caps to group jobs and hold a group to a number running at once, and a cleanup command for what a job
  leaves outside itself.
- Whoever queued a job is told at their prompt once it's over.

[Unreleased]: https://github.com/agencyenterprise/tower-extension-compute/compare/v1.7...HEAD
[1.7]: https://github.com/agencyenterprise/tower-extension-compute/compare/v1.6...v1.7
[1.6]: https://github.com/agencyenterprise/tower-extension-compute/compare/v1.5...v1.6
[1.5]: https://github.com/agencyenterprise/tower-extension-compute/compare/v1.4...v1.5
[1.4]: https://github.com/agencyenterprise/tower-extension-compute/compare/v1.3...v1.4
[1.3]: https://github.com/agencyenterprise/tower-extension-compute/compare/v1.2...v1.3
[1.2]: https://github.com/agencyenterprise/tower-extension-compute/compare/v1.1...v1.2
[1.1]: https://github.com/agencyenterprise/tower-extension-compute/compare/v1.0...v1.1
[1.0]: https://github.com/agencyenterprise/tower-extension-compute/releases/tag/v1.0
