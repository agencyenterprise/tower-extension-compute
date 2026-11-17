# Changelog

What changed in each release of Compute, newest first. A version is `extension.json`'s `version`, `major.minor` as
the tower reads it, and each is tagged `v<version>`, the tag's message carrying its section below. A **major** changes
the contract other extensions want (`contract.json`: a verb, read, fact or field removed, renamed or changed in
meaning); every other release is a **minor**, fixes included. How to cut one:
[the release skill](.claude/skills/release/SKILL.md).

## [Unreleased]

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

[Unreleased]: https://github.com/agencyenterprise/tower-extension-compute/compare/v1.1...HEAD
[1.1]: https://github.com/agencyenterprise/tower-extension-compute/compare/v1.0...v1.1
[1.0]: https://github.com/agencyenterprise/tower-extension-compute/releases/tag/v1.0
