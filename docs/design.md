# Design

Why compute exists, what it takes from Esben Kran's autonomous research lab
([kran-lab](https://github.com/esbenkc/kran-lab)), what it leaves out, and what comes next.

## The problem

Crews of agents on the tower run long, heavy work: agent trials in Docker lanes, model runs, rebuilds. Before compute,
each crew ran them as background processes of a worker's own session. That had four costs:

- **No one saw the machine.** Each crew picked its own concurrency, with no view of what other floors ran at the same
  time.
- **Nothing woke anyone.** A run ending was noticed only by a worker polling it from its turns.
- **Cleanups reached too far.** A cleanup that matched containers by name would have removed other crews' work.
- **Runs lived and died with a session.** The tower's jobs daemon, which outlives the tower, went unused.

## What Esben's lab does, and what compute keeps

| kran-lab piece | Problem it solves there | Here |
| --- | --- | --- |
| `labq`, a job queue to the owner's laptop | Heavy runs need a bigger machine than the agents' one, and must outlive the agent | Kept as the queue, on the same machine: the tower's jobs daemon runs each job |
| `mps-lock`, a FIFO ticket lock | One heavy job at a time, fairly: plain `lockf` let chained steps starve the queue | Kept as named resources and an oldest-first scheduler: no lock files, no polling for a lock |
| Heartbeats, stale-claim requeues, adoption | The queue was a remote API and the worker another machine | Left out: the jobs log is local and has one writer, and a lost job reads as lost on the board |
| Telegram notices | The owner learns a job started and ended | Kept as a line at the requester's prompt, the requester resumed when it isn't running, and the user's list when it can't be found |
| Menu bar app, queue panel | The owner sees the queue and what runs, and stops a job | Kept as the Compute page: the queue, a lane meter, a job's live screen, Cancel and Seen |
| Memory guard, disk guard, janitor | A small machine that agents ran out of memory and disk | Planned: start floors and stop floors (below) |
| Load meter in the menu bar | The owner sees what the lab does with the machine | Kept as the `machine` read and the Compute page's tiles: load, memory and disk, and who uses them, worker by worker and job by job |
| Off / on / until 08:00, pause for a game | The owner's laptop, lent on the owner's terms | Planned: holds, of the machine or of one tag |
| Per-room API budget, shared spend ledger, guard at the cap | A maxed card, spent by programs that can't see each other | Planned: spend pools (below) |
| "Heavy" thresholds, honest estimates, disclosure | Rules the code can't decide | Left to whoever uses compute: the lab's playbooks say them |

## Principles it keeps

From the tower's [principles](https://github.com/RegiByte/the-tower/blob/main/PRINCIPLES.md):

- **Extension before core.** Everything compute needs is in the tower: `ctx.jobs`, the board's `jobs`, system
  streams, `tower/submit`. The one thing it asked of the core is general: each job's `pid` on the board (2.10), which
  the jobs log already held, so any page can find what a job runs.
- **Observe, don't store.** The queue stores what was asked and what compute did. Where a job stands is the jobs log's.
- **Open systems first.** Compute knows nothing of missions, Docker or any provider. Resources are named by the
  config, tags and caps group jobs for whoever calls, and cleanup is a command the job names.
- **No credentials in the config.** A job reads its own keys. A pool's probe (below) is a command that holds its key.

## Next

In order, each small enough to build alone:

1. **Spend pools.** `pools.<name> = { limitUsd, probe: "<command printing the key's used USD>", every, atLimit }` in
   the settings. A job declares `--usd X --pool P` and starts only if the limit, less the latest reading and the
   reservations of the pool's running jobs, leaves X. Readings and failed reads are facts. A harness reports spend
   between readings with `spent`, since a provider's usage figure can lag real spend by minutes. At the limit, or
   after a run of failed reads, a pool always stops new starts and asks the user. It cancels running jobs only when
   `atLimit` says `cancel`.
2. **The machine's floors.** The `machine` read is here: load, memory and disk, and CPU and memory by owner, a job by
   its process group and a worker by its session's mark, computed when asked and never stored. Next, start floors keep
   a job from starting below a free memory or disk level, and stop floors cancel the newest job compute started below a
   lower one, a fact saying why.
3. **Holds and bumps.** `hold [--tag k=v] [--until <time>]` and `release` stop starts for the machine or one group,
   and never stop running jobs. `bump <n>` moves a queued job to the front.
4. **A place in the tower page.** The Compute page (`/r/compute/`) holds the queue, the meter and the controls for now,
   a renderer of its own, declared in the manifest, while the rest of the tower's integration is thought through: a meter in the tower page's
   header, the queue as a view in its panes. Everything it draws is in `board.x.compute` and everything it does is a
   compute verb, so that move is a second client, not a rewrite.

## Known limits

- The jobs daemon sends SIGTERM, then SIGKILL 5 s later. What a job can't tear down in that time is its cleanup's to
  remove.
- Stopping the jobs daemon (`tower down jobs`) ends every job, and nothing adopts them back. Long runs should be able
  to resume.
- Scheduling is oldest-first with passing: a job that needs much waits while smaller younger ones fit. A hold or a bump
  is the remedy until a reservation rule earns its place.
