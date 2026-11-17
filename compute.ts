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
/** A job is over and its requester was told: what it was told, whom, why it couldn't be, and how its cleanup went. */
export type ToldFact = { n: number; outcome: string; to?: string; failed?: string; cleanup?: { exit: number | null; signal?: string } }

export type QueueFact =
  | [number, 'j', QueuedFact]
  | [number, 'o', StartedFact]
  | [number, 'f', RefusedFact]
  | [number, 'q', WithdrawnFact]
  | [number, 'y', ToldFact]

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
    else Object.assign(at(fact.n), { told: { ...fact, at: time } })
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

/** What a requester is told once its job is over. */
export const tellText = (v: View): string =>
  [
    `${TELL_MARK} Your job #${v.n} (${v.label}) is over: ${v.outcome}.`,
    v.job ? `Its screen: \`tower job list\` names it (${v.job}), and the tower serves it at /job/${v.job}/screen while it keeps it.` : '',
    v.outcome && !succeeded(v.outcome) ? 'Read what went wrong before you run it again.' : '',
  ]
    .filter(Boolean)
    .join(' ')

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
    return `over: ${v.outcome}${v.told ? '' : ', telling its requester'}`
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
