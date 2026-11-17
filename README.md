# Compute

A queue for long or heavy commands on the machine [the tower](https://github.com/RegiByte/the-tower) runs on. Many
workers on many floors share one machine: compute starts each command in the tower's jobs daemon only once the
machine's named resources (lanes, a GPU…) have room for it, oldest first, and tells whoever queued it, at their
prompt, when it is over.

It is an extension of the tower: the tower's
[guide to extending it](https://github.com/RegiByte/the-tower/blob/main/docs/extending.md) explains the terms below
(verbs, reads, streams, the board, the jobs daemon). Why it exists and where it goes next:
[docs/design.md](docs/design.md).

## What it adds

### The `tower` command

Workers read its guidance in `tower x compute`, and its brief in `tower whoami`.

```text
$ tower x compute run --need lanes=2 --hours 3 --label "counted run" -- ./run_waves.sh
Queued #7 counted run, 1 ahead of it. It starts once the machine has room (`tower x compute jobs`), and you are told
at your prompt when it is over.

$ tower x compute jobs
lanes 3 of 4 in use · 1 queued
#6 running 41 min (job-15d672a7) · smoke · lanes 1 · BRUNO-08 on research · mission=boss-05-mwckzpdm
#7 running 12 min (job-7f6be1c7) · counted run · lanes 2 · BRUNO-08 on research
#8 queued, waits for 2 lanes (1 of 4 free) · rebuild · lanes 2 · VERA-18 on research
#5 over: exit 0 after 2 h 10 min · regen · lanes 1 · BRUNO-08 on research
```

- `run [--need <resource>=<units>]… [--hours <h>] [--tag <name>=<value>]… [--cap <tag>=<n>]… [--label <words>]
  [--cwd <dir>] [--cleanup <command>] -- <command…>` queues a command.
  - `--need`: what it holds while it runs, in units of the machine's resources. Left out, the settings'
    `defaultNeeds` (one lane).
  - `--hours`: how long you expect it to run. The queue says when it runs past it; a caller such as the lab can act
    on that.
  - `--tag name=value`: words to group your jobs by. Compute gives them no meaning; reads filter on them.
  - `--cap tag=n`: at most `n` jobs carrying this job's value of `tag` run at once, whatever room the machine has.
    The lab caps each mission this way.
  - `--cwd`: the folder it runs in, absolute or relative to your checkout; your checkout when left out.
  - `--cleanup`: a shell command run in that folder once the job is over, cancelled included, with `COMPUTE_JOB` set
    to the job's number. It is for what the job starts outside its own process group, which the jobs daemon doesn't
    stop with it: containers labelled with `$COMPUTE_JOB`, say.
  - It is refused up front when it could never start: a resource the machine doesn't name, more units than the machine
    has, a cap on a tag the job doesn't carry.
- `jobs [--tag <name>=<value>] [--all true]`: the machine's resources in use, and each job queued, running, or over
  within the last day, with where it stands and, for a queued one, what it waits for.
- `cancel <n>`: a queued job is withdrawn; a running one is cancelled in the jobs daemon (SIGTERM to its process group,
  SIGKILL 5 s later), then its cleanup runs and its requester is told.

When a job is over, its requester gets one line at its prompt, queued while it works:

```text
[compute] Your job #7 (counted run) is over: exit 0 after 2 h 10 min. Its screen: `tower job list` names it
(job-7f6be1c7), and the tower serves it at /job/job-7f6be1c7/screen while it keeps it.
```

### For other extensions

`compute/run`, `compute/cancel` and the read `compute/jobs` are its API. An extension that uses it declares it as
wanted, so it still loads where compute is off:

```json
{ "wants": { "compute": "1.0" } }
```

Then `ctx.deps.compute` is defined while compute runs, and a handler calls `call.call('compute/run', {...})` with its
caller's call, so compute knows who asked and tells them. Tags group the caller's jobs (`mission=<id>`), and caps hold
a group to a number of running jobs. [The lab](https://github.com/agencyenterprise/tower-extension-lab) is built this
way. `contract.json` lists the names held at major 1: they only grow within it.

## Add it

It needs the tower 2.0 or later and Node 24, and nothing else: it has no runtime dependencies.

```sh
git clone git@github.com:agencyenterprise/tower-extension-compute.git
```

Then name its folder in the tower's config (`~/.tower/config.json`), with the machine's resources:

```json
{
  "extensions": {
    "compute": {
      "path": "/Users/you/code/tower-extension-compute",
      "settings": { "resources": { "lanes": 6, "gpu": 1 }, "defaultNeeds": { "lanes": 1 } }
    }
  }
}
```

`tower config check` checks the edit, and `tower extensions` lists it once the tower has read it.

| Setting | Default | What it is |
| --- | --- | --- |
| `resources` | `{ "lanes": 4 }` | What the machine has room for, in units of named resources. A job starts only while the units it needs are free. Machine-wide: a floor's own value is not read. Lowering it never stops a running job. |
| `defaultNeeds` | `{ "lanes": 1 }` | What a job that says nothing of its needs holds while it runs. |

## How it works

- **Facts, not state.** `run` appends a `j` fact to compute's `queue` stream (system-wide, so every floor's jobs share
  one machine). The scheduler appends `o` when it starts a job in the jobs daemon (naming the daemon's job id), `f`
  when the daemon refuses it, `q` when a queued job is withdrawn, and `y` once a job is over and its requester was
  told. Jobs are numbered from 1 in the order they were queued. Where a started job stands, running, ended, cancelled
  or lost, is never stored: it is read from the board's `jobs`, which the jobs daemon's log holds.
- **The scheduler** runs every 5 s, and once at each `run`. It first tells the requesters of jobs that are over, after
  their cleanup, then starts the oldest queued jobs that fit: a job whose needs or cap don't fit is passed by younger
  ones that do. While the jobs daemon doesn't answer it does nothing, so a lost job is never taken for over while the
  daemon is down.
- **Telling** types one line at the requester's prompt (`tower/submit`, queued while it works). When it can't, the
  requester not running or gone from the board, the `y` fact says why, and `jobs` shows the outcome.
- **Jobs outlive the tower, not the jobs daemon.** A job runs in the jobs daemon, outside the tower: it outlives a
  restart of the tower or of compute, which picks up where its facts left off. Stopping the jobs daemon ends every
  job, so a long run should be able to resume.
- **Nothing secret goes in.** A job's command and label are kept in the jobs log every worker and renderer reads, and
  its env holds only `COMPUTE_JOB` and `GIT_TERMINAL_PROMPT=0`. A command that needs a key reads it from its own
  folder.
- **The pure part** (`compute.ts`) holds what the facts mean, which jobs start, and the words. `server.ts` is the shell
  around it: the stream, the board, the jobs daemon, the prompts.

Not yet here, in the order [docs/design.md](docs/design.md) gives: spend pools for paid API keys, disk and memory
floors, a load read, holds and bumps, and a page section on the tower.

## Working on it

```sh
npm install
npm run types       # tower types .: the library's declarations for this tower, in .tower/ (git-ignored)
npm run typecheck
npm test            # node --test over compute.ts
npm run check       # tower extensions check .
```

Try a change on a tower checkout's sandbox (`npm run sandbox -- up` there), never on your real tower first: name this
folder in the sandbox's config, then `npm run -s sandbox -- run tower x compute jobs`. After a change to the manifest's
names, `tower extensions freeze .` rewrites `contract.json`: adding a name is a minor, removing or renaming one a major.
