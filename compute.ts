/**
 * The pure part of compute: the queue's facts and what they mean, which queued jobs start next, and the words the
 * reads and the wake print. No I/O: `server.ts` reads the board and the stream, calls these, and acts.
 *
 * A job is queued by `run` (`j`), started by the scheduler (`o`, naming the jobs daemon's job), refused by the jobs
 * daemon (`f`), withdrawn before it started (`q`), and its requester told once it is over (`y`). Where a started job
 * stands (running, ended, cancelled, lost) is never stored here: it is read from the board's `jobs`, which the jobs
 * daemon's log holds.
 */

/** A job asked for: what to run and where, what it needs of the machine, and who asked. */
export type QueuedFact = {
  argv: string[]
  cwd: string
  label: string
  /** The floor it was asked from. */
  project: string
  /** Units of the machine's named resources it holds while it runs: `{ lanes: 2 }`. */
  needs: Record<string, number>
  /** How long its requester expects it to run, in hours: said when it runs past it. */
  hours?: number
  /** Words a caller groups its jobs by (`mission: "boss-05-…"`): compute gives them no meaning. */
  tags: Record<string, string>
  /** At most this many jobs carrying the same value of the tag run at once: `{ mission: 2 }`. */
  caps: Record<string, number>
  /** A shell command run in `cwd` once the job is over, with `COMPUTE_JOB` set: what the job left behind outside itself. */
  cleanup?: string
  /** The session that asked, or `user`. */
  by: string
  /** The worker that asked, by callsign. */
  callsign?: string
}
/** The scheduler started a queued job: `job` is the jobs daemon's id. */
export type StartedFact = { n: number; job: string }
/** The jobs daemon refused to start a queued job. */
export type RefusedFact = { n: number; reason: string }
/** A queued job taken out of the queue before it started. */
export type WithdrawnFact = { n: number; by: string; callsign?: string }
/**
 * A job is over and compute is done telling its requester: what it said (`outcome`), to whom, the session it resumed
 * the requester in when that worker wasn't running (`resumed`), and how the job's cleanup went. `failed`: the requester
 * couldn't be told, and why: the job is on the user's list until they mark it seen.
 */
export type ToldFact = { n: number; outcome: string; to?: string; resumed?: string; failed?: string; cleanup?: { exit: number | null; signal?: string } }
/** The user (or a worker) saw a job the list held, and took it off. */
export type SeenFact = { n: number; by: string }

export type QueueFact =
  | [number, 'j', QueuedFact]
  | [number, 'o', StartedFact]
  | [number, 'f', RefusedFact]
  | [number, 'q', WithdrawnFact]
  | [number, 'y', ToldFact]
  | [number, 's', SeenFact]

/** The stream's state: every fact, in order. What they mean is `entriesOf`'s. */
export type QueueFacts = { facts: QueueFact[] }

/** A job as its facts say it: numbered from 1 in the order it was queued. */
export type Entry = QueuedFact & {
  n: number
  queuedAt: number
  startedAt?: number
  job?: string
  refused?: string
  withdrawnAt?: number
  told?: ToldFact & { at: number }
  seenAt?: number
}

/** Every job the facts name, oldest first. */
export const entriesOf = (facts: QueueFact[]): Entry[] => {
  const entries: Entry[] = []
  const at = (n: number) => entries[n - 1]
  for (const [time, code, fact] of facts) {
    if (code === 'j') entries.push({ ...fact, n: entries.length + 1, queuedAt: time })
    else if (code === 'o') Object.assign(at(fact.n), { startedAt: time, job: fact.job })
    else if (code === 'f') Object.assign(at(fact.n), { refused: fact.reason })
    else if (code === 'q') Object.assign(at(fact.n), { withdrawnAt: time })
    else if (code === 'y') Object.assign(at(fact.n), { told: { ...fact, at: time } })
    else Object.assign(at(fact.n), { seenAt: time })
  }
  return entries
}

/** A job of the jobs daemon as the board's `jobs` holds it, the fields compute reads. */
export type BoardJob = {
  id: string
  state: 'running' | 'ended' | 'cancelled' | 'lost'
  startedAt: number
  endedAt?: number
  exit?: number | null
  signal?: string | null
}

/**
 * Where a job stands. `queued`: waiting for room. `running`: the jobs daemon runs it. `over`: it ended, was cancelled,
 * was lost or could not start, and its requester is to be told (`outcome`) unless it was. `withdrawn`: taken out
 * before it started.
 */
export type Status = 'queued' | 'running' | 'over' | 'withdrawn'

export type View = Entry & { status: Status; outcome?: string; endedAt?: number }

export const DAY_MS = 86_400_000

/**
 * Each entry with where it stands, from the board's jobs at `now`. `jobsUp`: whether the jobs daemon answers; while it
 * doesn't, a started job that hasn't ended reads as running, since `lost` then says nothing about the job.
 */
export const viewsOf = (entries: Entry[], jobs: BoardJob[], jobsUp: boolean, now: number): View[] =>
  entries.map((e): View => {
    if (e.withdrawnAt !== undefined) return { ...e, status: 'withdrawn' }
    if (e.refused !== undefined) return { ...e, status: 'over', outcome: e.told?.outcome ?? `could not start: ${e.refused}` }
    if (e.job === undefined) return { ...e, status: 'queued' }
    if (e.told) return { ...e, status: 'over', outcome: e.told.outcome }
    const job = jobs.find((j) => j.id === e.job)
    // The board keeps every running job and each ended one for a day. A job missing from it was started too recently
    // for the board to hold it yet, or ended more than a day ago.
    if (!job) return !jobsUp || now - e.startedAt! < DAY_MS ? { ...e, status: 'running' } : { ...e, status: 'over', outcome: 'over (the board no longer holds the job)' }
    if (job.state === 'running' || (job.state === 'lost' && !jobsUp)) return { ...e, status: 'running' }
    return { ...e, status: 'over', outcome: outcomeOf(job), ...(job.endedAt !== undefined && { endedAt: job.endedAt }) }
  })

/** How a job of the jobs daemon ended, in words. */
export const outcomeOf = (job: BoardJob): string => {
  if (job.state === 'lost') return 'lost: the jobs daemon no longer holds it (it stopped, or the machine restarted)'
  const took = job.endedAt !== undefined ? ` after ${durationWords(job.endedAt - job.startedAt)}` : ''
  if (job.state === 'cancelled') return `cancelled${took}`
  if (job.exit === null || job.exit === undefined) return `ended by ${job.signal ?? 'a signal'}${took}`
  return `exit ${job.exit}${took}`
}

/** Whether an outcome is a job that did what it was asked: it exited 0. */
export const succeeded = (outcome: string) => /^exit 0\b/.test(outcome)

/** Units of each resource the running jobs hold. */
export const usedOf = (views: View[]): Record<string, number> => {
  const used: Record<string, number> = {}
  for (const v of views.filter((x) => x.status === 'running')) for (const [k, units] of Object.entries(v.needs)) used[k] = (used[k] ?? 0) + units
  return used
}

/** Why a queued job can't start beside `active` (the running jobs and those starting with it), or undefined when it can. */
export const waitsFor = (job: View, active: View[], resources: Record<string, number>): string | undefined => {
  const used = usedOf(active.map((a) => ({ ...a, status: 'running' as const })))
  for (const [k, units] of Object.entries(job.needs)) {
    const total = resources[k]
    if (total === undefined) return `${k}, which the machine's resources no longer name`
    if ((used[k] ?? 0) + units > total) return `${units} ${k} (${Math.max(0, total - (used[k] ?? 0))} of ${total} free)`
  }
  for (const [tag, max] of Object.entries(job.caps)) {
    const value = job.tags[tag]
    const alike = active.filter((a) => a.tags[tag] === value).length
    if (alike >= max) return `its cap: ${alike} jobs of ${tag}=${value} run, at most ${max}`
  }
  return undefined
}

/** The queued jobs to start now: the oldest first, each that fits beside the running ones and those it starts before it. */
export const nextStarts = (views: View[], resources: Record<string, number>): number[] => {
  const active = views.filter((v) => v.status === 'running')
  const starting: number[] = []
  for (const job of views.filter((v) => v.status === 'queued')) {
    if (waitsFor(job, active, resources) !== undefined) continue
    active.push(job)
    starting.push(job.n)
  }
  return starting
}

/** The over jobs whose requester hasn't been told yet. */
export const untold = (views: View[]): View[] => views.filter((v) => v.status === 'over' && !v.told)

/** `k=v` words as a record, each value checked by `value`; a problem names the word. */
export const pairsOf = <T>(words: string[], what: string, value: (v: string) => T | undefined): Record<string, T> | string => {
  const out: Record<string, T> = {}
  for (const word of words) {
    const m = /^([a-z][a-z0-9-]*)=(.+)$/.exec(word)
    const v = m ? value(m[2]) : undefined
    if (!m || v === undefined) return `${what} "${word}" is not a name=value pair (lowercase name)`
    out[m[1]] = v
  }
  return out
}

/** A whole number of 1 or more. */
export const count = (v: string): number | undefined => (/^[1-9]\d*$/.test(v) ? Number(v) : undefined)

/** Why a job asked for can never start on this machine, or undefined. */
export const unrunnable = (job: Pick<QueuedFact, 'needs' | 'tags' | 'caps'>, resources: Record<string, number>): string | undefined => {
  for (const [k, units] of Object.entries(job.needs)) {
    if (resources[k] === undefined) return `it needs ${k}, which the machine's resources don't name (${namesOf(resources)}): set compute's \`resources\` in the config`
    if (units > resources[k]) return `it needs ${units} ${k} and the machine has ${resources[k]}`
  }
  for (const tag of Object.keys(job.caps)) if (job.tags[tag] === undefined) return `it caps the tag ${tag} but carries no ${tag} tag`
  return undefined
}

const namesOf = (resources: Record<string, number>) =>
  Object.entries(resources)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ') || 'none'

/** A duration in words: "40 s", "12 min", "2 h 10 min". */
export const durationWords = (ms: number): string => {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  const min = Math.round(s / 60)
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  return `${h} h${min % 60 ? ` ${min % 60} min` : ''}`
}

/** Whether a running job has run past the hours its requester expected. */
export const overdue = (v: View, now: number): boolean =>
  v.status === 'running' && v.hours !== undefined && v.startedAt !== undefined && now - v.startedAt > v.hours * 3_600_000

/** What compute types at a requester's prompt opens with, so a worker tells it from the user's words. */
export const TELL_MARK = '[compute]'

const tagWords = (tags: Record<string, string>) =>
  Object.entries(tags)
    .map(([k, t]) => `${k}=${t}`)
    .join(' ')

/** What a requester is told at its prompt once its job is over. */
export const tellText = (v: View): string =>
  [
    `${TELL_MARK} Your job #${v.n} (${v.label}) is over: ${v.outcome}.`,
    Object.keys(v.tags).length ? `Its tags: ${tagWords(v.tags)}.` : '',
    v.job ? `Its screen: \`tower job list\` names it (${v.job}), and the tower serves it at /job/${v.job}/screen while it keeps it.` : '',
    v.outcome && !succeeded(v.outcome) ? 'Read what went wrong before you run it again.' : '',
  ]
    .filter(Boolean)
    .join(' ')

/**
 * The first prompt of a requester compute resumes because it wasn't running when its job ended: why it is back, then
 * what it would have been told. What it does with that is its own work's to say: a closed mission, say, is done.
 */
export const resumeText = (v: View): string =>
  `${TELL_MARK} You were resumed because a job you queued is over and you weren't running to be told. ${tellText(v).slice(TELL_MARK.length + 1)} Check whether the work it was for still goes on before you act on it.`

/** The jobs on the user's list: over, their requester not told (`told.failed`), and not marked seen. */
export const listed = (views: View[]): View[] => views.filter((v) => v.told?.failed !== undefined && v.seenAt === undefined)

/** A listed job's line on the user's list. */
export const listTitle = (v: View): string => {
  const why = v.told!.failed!
  return `Job #${v.n} (${v.label})${v.callsign ? ` by ${v.callsign}` : ''} is over: ${v.outcome}. Not told: ${why}.`
}

/** The jobs worth showing at `now`: queued, running, over and untold or listed, and the rest within the last day. */
export const recent = (views: View[], now: number): View[] =>
  views.filter((v) => {
    if (v.status === 'queued' || v.status === 'running' || !v.told) return v.status !== 'withdrawn' || (v.withdrawnAt ?? 0) > now - DAY_MS
    if (v.told.failed !== undefined && v.seenAt === undefined) return true
    return v.told.at > now - DAY_MS
  })

/** A job as plain data, as the read and the board part give it. */
export const plainJob = (v: View, now: number) => ({
  n: v.n,
  label: v.label,
  argv: v.argv,
  cwd: v.cwd,
  project: v.project,
  by: v.by,
  ...(v.callsign && { callsign: v.callsign }),
  needs: v.needs,
  tags: v.tags,
  caps: v.caps,
  ...(v.hours !== undefined && { hours: v.hours }),
  ...(v.cleanup && { cleanup: v.cleanup }),
  status: v.status,
  ...(v.outcome && { outcome: v.outcome }),
  queuedAt: v.queuedAt,
  ...(v.startedAt !== undefined && { startedAt: v.startedAt }),
  ...(v.endedAt !== undefined && { endedAt: v.endedAt }),
  ...(v.withdrawnAt !== undefined && { withdrawnAt: v.withdrawnAt }),
  ...(v.job && { job: v.job }),
  ...(v.told && { told: { at: v.told.at, ...(v.told.to && { to: v.told.to }), ...(v.told.resumed && { resumed: v.told.resumed }), ...(v.told.failed !== undefined && { failed: v.told.failed }) } }),
  ...(v.seenAt !== undefined && { seenAt: v.seenAt }),
  ...(overdue(v, now) && { overdue: true }),
})
export type PlainJob = ReturnType<typeof plainJob>

/** One job in a line. */
export const jobLine = (v: View, views: View[], resources: Record<string, number>, now: number): string => {
  const needs = Object.entries(v.needs)
    .map(([k, u]) => `${k} ${u}`)
    .join(', ')
  const tags = Object.entries(v.tags)
    .map(([k, t]) => `${k}=${t}`)
    .join(' ')
  const who = `${v.callsign ?? v.by} on ${v.project}`
  const state = (() => {
    if (v.status === 'queued') {
      const ahead = views.filter((x) => x.status === 'queued' && x.n < v.n).length
      const why = waitsFor(v, views.filter((x) => x.status === 'running'), resources)
      return `queued${ahead ? `, ${ahead} ahead` : ''}${why ? `, waits for ${why}` : ', starts at the next tick'}`
    }
    if (v.status === 'running') return `running ${durationWords(now - (v.startedAt ?? now))}${overdue(v, now) ? `, past its ${v.hours} h` : ''}${v.job ? ` (${v.job})` : ''}`
    if (v.status === 'withdrawn') return 'withdrawn'
    const told = !v.told
      ? ', telling its requester'
      : v.told.failed !== undefined
        ? `, not told (${v.told.failed})${v.seenAt === undefined ? ', on the list' : ''}`
        : v.told.resumed
          ? `, told by resuming ${v.told.to}`
          : ''
    return `over: ${v.outcome}${told}`
  })()
  return `#${v.n} ${state} · ${v.label} · ${needs || 'needs nothing'} · ${who}${tags ? ` · ${tags}` : ''}`
}

/** The machine's resources in a line: what is in use of each, and how many jobs wait. */
export const resourcesLine = (views: View[], resources: Record<string, number>): string => {
  const used = usedOf(views)
  const queued = views.filter((v) => v.status === 'queued').length
  const of = Object.entries(resources)
    .map(([k, total]) => `${k} ${used[k] ?? 0} of ${total} in use`)
    .join(', ')
  return `${of || 'no resources set'} · ${queued} queued`
}

// ---------- the machine: its load, memory and disk, and who uses them ----------

/** How full a measure is, in three tones a page colours: `calm`, `busy` past `warm`, `over` past `hot`. */
export type Tone = 'calm' | 'busy' | 'over'
const toneAt = (share: number, warm: number, hot: number): Tone => (share > hot ? 'over' : share >= warm ? 'busy' : 'calm')

/** The run queue over the cores: busy from 70%, over past 100%, when work waits for a core. */
export const loadTone = (load1: number, cpus: number): Tone => toneAt(load1 / cpus, 0.7, 1)
/** Memory in use: busy from 75%, over past 90%. */
export const memoryTone = (used: number, total: number): Tone => toneAt(used / total, 0.75, 0.9)
/** A disk: busy from 85% full, over past 95%. */
export const diskTone = (free: number, total: number): Tone => toneAt(1 - free / total, 0.85, 0.95)

/**
 * A process as `ps` tells it: its parent and process group, its CPU (percent of one core, ps's own average over the
 * last moments), its resident memory in bytes, and the marks its environment or command carry: the worker's session
 * (`TOWER_SESSION_ID`, which every process a worker starts inherits), a compute job's number (`COMPUTE_JOB`), and which
 * of the tower's own daemons it is.
 */
export type Proc = { pid: number; ppid: number; pgid: number; cpu: number; rss: number; session?: string; job?: number; daemon?: Daemon }
export type Daemon = 'host' | 'terms' | 'jobs' | 'tower'

const STATS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s*$/
const MARKED_LINE = /^\s*(\d+)\s+(.*)$/
const SESSION_MARK = /(?:^|\s)TOWER_SESSION_ID=([\w-]+)/
const JOB_MARK = /(?:^|\s)COMPUTE_JOB=(\d+)(?:\s|$)/
/** The tower's daemons, by the script each runs: a launch the tower changes leaves them under everything else. */
const DAEMON_SCRIPT = /\/src\/(host|terms|jobs)\/main\.ts(?:\s|$)|\/src\/(tower)\/server\.ts(?:\s|$)/

/**
 * `stats` is `ps -A -o pid=,ppid=,pgid=,pcpu=,rss=` (rss in KiB); `marked` is `ps -A -ww -E -o pid=,command=` (`e` on Linux),
 * whose command runs into the environment with nothing between them, read only for the marks. A process in one but not
 * the other, started or ended between the two reads, is left out.
 */
export const parseProcs = (stats: string, marked: string): Map<number, Proc> => {
  const marks = new Map<number, string>()
  for (const row of marked.split('\n')) {
    const m = MARKED_LINE.exec(row)
    if (m) marks.set(Number(m[1]), m[2])
  }
  const procs = new Map<number, Proc>()
  for (const row of stats.split('\n')) {
    const m = STATS_LINE.exec(row)
    if (!m) continue
    const pid = Number(m[1])
    const text = marks.get(pid)
    if (text === undefined) continue
    const session = SESSION_MARK.exec(text)?.[1]
    const job = JOB_MARK.exec(text)?.[1]
    const daemon = DAEMON_SCRIPT.exec(text)
    procs.set(pid, {
      pid,
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      cpu: Number(m[4]),
      rss: Number(m[5]) * 1024,
      ...(session !== undefined && { session }),
      ...(job !== undefined && { job: Number(job) }),
      ...(daemon && { daemon: (daemon[1] ?? daemon[2]) as Daemon }),
    })
  }
  return procs
}

/**
 * Whose a process is: a worker's, a compute job's, another job in the jobs daemon (one compute didn't start), a shell
 * the tower's terms daemon holds, the tower's own daemons, or the rest of the machine.
 */
export type Owner = { t: 'worker'; session: string } | { t: 'job'; n: number } | { t: 'jobs' } | { t: 'shells' } | { t: 'tower' } | { t: 'rest' }

/**
 * The running jobs' process groups and whose each is: a compute job's number, or another job. A job's pid is its group
 * (the jobs daemon makes it so), which holds what it runs unless a process leaves the group.
 */
export const jobGroups = (jobs: { id: string; pid: number; state: BoardJob['state'] }[], views: View[]): Map<number, Owner> => {
  const ours = new Map(views.filter((v) => v.job !== undefined).map((v) => [v.job!, v.n]))
  return new Map(
    jobs
      .filter((j) => j.state === 'running')
      .map((j): [number, Owner] => {
        const n = ours.get(j.id)
        return [j.pid, n === undefined ? { t: 'jobs' } : { t: 'job', n }]
      }),
  )
}

/**
 * Each process's owner: a compute job's own mark, then the running job whose process group it is in, then a worker's
 * mark, then being one of the tower's daemons; else its parent's, so a program that hides its environment (Apple's own
 * binaries do) counts as whoever started it. A child of the terms daemon with no mark is a shell. Read up the tree,
 * each answer kept.
 */
export const ownersOf = (procs: Map<number, Proc>, groups: Map<number, Owner>): Map<number, Owner> => {
  const owners = new Map<number, Owner>()
  const of = (pid: number, seen: Set<number>): Owner => {
    const known = owners.get(pid)
    if (known) return known
    const p = procs.get(pid)
    const parent = p ? procs.get(p.ppid) : undefined
    const owner: Owner =
      !p || seen.has(pid)
        ? { t: 'rest' }
        : p.job !== undefined
          ? { t: 'job', n: p.job }
          : (groups.get(p.pgid) ??
            (p.session !== undefined
              ? { t: 'worker', session: p.session }
              : p.daemon
                ? { t: 'tower' }
                : parent?.daemon === 'terms'
                  ? { t: 'shells' }
                  : p.ppid <= 1
                    ? { t: 'rest' }
                    : of(p.ppid, seen.add(pid))))
    owners.set(pid, owner)
    return owner
  }
  for (const pid of procs.keys()) of(pid, new Set())
  return owners
}

/** What a group of processes uses: CPU in percent of one core, resident memory in bytes, and how many there are. */
export type Use = { cpu: number; rss: number; procs: number }
const NONE: Use = { cpu: 0, rss: 0, procs: 0 }
const plus = (a: Use, p: Proc): Use => ({ cpu: a.cpu + p.cpu, rss: a.rss + p.rss, procs: a.procs + 1 })

/** The machine's use, by owner. */
export type MachineUse = {
  workers: Record<string, Use>
  jobs: Record<number, Use>
  otherJobs: Use
  shells: Use
  tower: Use
  rest: Use
  total: Use
}

export const useOf = (procs: Map<number, Proc>, groups: Map<number, Owner>): MachineUse => {
  const owners = ownersOf(procs, groups)
  const u: MachineUse = { workers: {}, jobs: {}, otherJobs: NONE, shells: NONE, tower: NONE, rest: NONE, total: NONE }
  for (const p of procs.values()) {
    const o = owners.get(p.pid)!
    u.total = plus(u.total, p)
    if (o.t === 'worker') u.workers[o.session] = plus(u.workers[o.session] ?? NONE, p)
    else if (o.t === 'job') u.jobs[o.n] = plus(u.jobs[o.n] ?? NONE, p)
    else if (o.t === 'jobs') u.otherJobs = plus(u.otherJobs, p)
    else u[o.t] = plus(u[o.t], p)
  }
  return u
}

/** Memory in bytes: the machine's, what is in use, and on macOS what the compressor holds of it. */
export type Memory = { total: number; used: number; compressed?: number }

const vmCount = (text: string, name: string): number => {
  const m = new RegExp(`^${name}:\\s+(\\d+)\\.`, 'm').exec(text)
  if (!m) throw new Error(`vm_stat says nothing of "${name}"`)
  return Number(m[1])
}

/**
 * macOS's memory in use as Activity Monitor counts it, from `vm_stat`: wired, held by the compressor, and the apps'
 * own (anonymous pages less the purgeable ones). Free and cached pages are free to take, so they aren't in use.
 */
export const memoryOfVmStat = (text: string, total: number): Memory => {
  const page = Number(/page size of (\d+) bytes/.exec(text)?.[1])
  if (!page) throw new Error('vm_stat names no page size')
  const compressed = vmCount(text, 'Pages occupied by compressor') * page
  const app = (vmCount(text, 'Anonymous pages') - vmCount(text, 'Pages purgeable')) * page
  return { total, used: vmCount(text, 'Pages wired down') * page + compressed + app, compressed }
}

/** Linux's memory in use, from `/proc/meminfo`: the total less what the kernel says is available. */
export const memoryOfMeminfo = (text: string): Memory => {
  const kib = (name: string) => {
    const m = new RegExp(`^${name}:\\s+(\\d+) kB`, 'm').exec(text)
    if (!m) throw new Error(`/proc/meminfo says nothing of ${name}`)
    return Number(m[1]) * 1024
  }
  const total = kib('MemTotal')
  return { total, used: total - kib('MemAvailable') }
}

/** Bytes in the unit that reads best: `512 MB`, `3.4 GB`. */
export const bytesWords = (b: number): string =>
  b >= 1e12 ? `${(b / 1e12).toFixed(1)} TB` : b >= 1e9 ? `${(b / 1e9).toFixed(b >= 1e10 ? 0 : 1)} GB` : `${Math.round(b / 1e6)} MB`

/** CPU in cores: `0.3 cores`, `2.4 cores`, from ps's percent of one core. */
export const coresWords = (cpu: number): string => `${(cpu / 100).toFixed(1)} cores`

const useWords = (u: Use) => `${coresWords(u.cpu)}, ${bytesWords(u.rss)} in ${u.procs} ${u.procs === 1 ? 'process' : 'processes'}`

/**
 * The machine in lines, for `tower x compute machine`: its load, memory and disk, then who uses it, the heaviest
 * workers and jobs by name (`names` gives a worker's callsign and floor, a job's number and label).
 */
export const machineLines = (
  m: { cpus: number; load: [number, number, number]; memory?: Memory; disk: { path: string; total: number; free: number }; use: MachineUse },
  names: { worker: (session: string) => string; job: (n: number) => string },
): string[] => {
  const top = <K>(rec: [K, Use][]) => rec.sort((a, b) => b[1].cpu - a[1].cpu || b[1].rss - a[1].rss).slice(0, 5)
  const workers = Object.entries(m.use.workers)
  const jobs = Object.entries(m.use.jobs).map(([n, u]) => [Number(n), u] as [number, Use])
  const sum = (us: Use[]) => us.reduce((a, u) => ({ cpu: a.cpu + u.cpu, rss: a.rss + u.rss, procs: a.procs + u.procs }), NONE)
  return [
    `load ${m.load.map((v) => v.toFixed(1)).join(' · ')} over 1, 5 and 15 min, on ${m.cpus} cores (${Math.round((m.load[0] / m.cpus) * 100)}%)`,
    m.memory ? `memory ${bytesWords(m.memory.used)} of ${bytesWords(m.memory.total)} in use${m.memory.compressed ? ` (${bytesWords(m.memory.compressed)} compressed)` : ''}` : 'memory: not read on this platform',
    `disk ${bytesWords(m.disk.free)} free of ${bytesWords(m.disk.total)} (${m.disk.path})`,
    `workers: ${useWords(sum(workers.map(([, u]) => u)))} across ${workers.length}`,
    ...top(workers).map(([s, u]) => `  ${names.worker(s)}: ${useWords(u)}`),
    `compute's jobs: ${useWords(sum(jobs.map(([, u]) => u)))}`,
    ...top(jobs).map(([n, u]) => `  ${names.job(n)}: ${useWords(u)}`),
    `other jobs: ${useWords(m.use.otherJobs)}`,
    `the tower's shells: ${useWords(m.use.shells)}`,
    `the tower itself: ${useWords(m.use.tower)}`,
    `everything else: ${useWords(m.use.rest)}`,
  ]
}
