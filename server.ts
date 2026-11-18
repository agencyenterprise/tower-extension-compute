/**
 * Compute: a queue for long or heavy commands on the machine the tower runs on. `run` records a job in the `queue`
 * stream; every few seconds the scheduler starts the oldest queued jobs that fit the machine's free resources in the
 * jobs daemon, and once a job is over runs its cleanup and tells its requester: at its prompt when it runs, by resuming
 * it when it doesn't, and on the user's list only when it can't be found or resumed.
 *
 * What it decides is pure and lives in `compute.ts`. Here: reading the stream and the board, the jobs daemon, the
 * prompts and resumes, the verbs, the read and the board's part.
 */
import { execFile } from 'node:child_process'
import { readFileSync, statfsSync, statSync } from 'node:fs'
import { availableParallelism, homedir, loadavg, totalmem } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { callOf, type Board, type Card } from '/lib/board.js'
import { apiError, isApiError, type Ask, type CallCtx, type FoldCtx, type Part, type Reduce, type Start, type StartCtx } from '/lib/extension.js'
import {
  count,
  entriesOf,
  jobLine,
  listed,
  listTitle,
  diskTone,
  loadTone,
  machineLines,
  memoryOfMeminfo,
  memoryOfVmStat,
  memoryTone,
  nextStarts,
  pairsOf,
  plainJob,
  recent,
  resourcesLine,
  resumeText,
  tellText,
  unrunnable,
  untold,
  usedOf,
  useOf,
  jobGroups,
  parseProcs,
  viewsOf,
  type MachineUse,
  type Memory,
  type Owner,
  type QueueFact,
  type QueueFacts,
  type QueuedFact,
  type ToldFact,
  type Use,
  type View,
} from './compute.ts'

const QUEUE = 'queue'
const TICK_MS = 5000
const CLEANUP_MS = 120_000
/** How long an append waits for the tower's fold to hold it. */
const TRACK_MS = 5000

type Settings = { resources: Record<string, number>; defaultNeeds: Record<string, number> }

const QUEUE_REDUCE: Reduce = {
  init: { facts: [] } satisfies QueueFacts,
  step: (state: QueueFacts, fact: QueueFact): QueueFacts => ({ facts: [...state.facts, fact] }),
}

/** The latest card a session's lineage holds: the worker it runs as now. */
const cardOfSession = (cards: Card[], session: string): Card | undefined =>
  cards.filter((c) => c.lineage.some((l) => l.id === session)).sort((a, b) => b.enteredAt - a.enteredAt)[0]

const boardCards = (board: Board): Card[] => board.floors.flatMap((f) => f.cards)

const exec = promisify(execFile)
/** ps with the environment, macOS's flag or procps's. */
const PS_ENV = process.platform === 'darwin' ? '-E' : 'e'
/** Every process's environment runs to megabytes. */
const PS_BUFFER = 64 * 1024 * 1024
/** A read within this long of the last answers the last: pages open together read ps once. */
const MACHINE_FRESH_MS = 5000

type Machine = { at: number; cpus: number; load: [number, number, number]; memory?: Memory; disk: { path: string; total: number; free: number }; use: MachineUse }

/** Memory as the platform says it: vm_stat on macOS, /proc/meminfo on Linux, none elsewhere. */
const memoryNow = async (): Promise<Memory | undefined> => {
  if (process.platform === 'darwin') return memoryOfVmStat((await exec('vm_stat')).stdout, totalmem())
  if (process.platform === 'linux') return memoryOfMeminfo(readFileSync('/proc/meminfo', 'utf8'))
  return undefined
}

/**
 * The machine as it is now: load, memory, the disk holding the home folder, and every process's CPU and memory by
 * owner (`groups`: the running jobs' process groups). Read when asked, kept only to answer reads within a few seconds
 * of it, never stored.
 */
let lastMachine: Promise<Machine> | undefined
let lastMachineAt = 0
const machineNow = (groups: Map<number, Owner>): Promise<Machine> => {
  if (lastMachine && Date.now() - lastMachineAt < MACHINE_FRESH_MS) return lastMachine
  lastMachineAt = Date.now()
  lastMachine = (async () => {
    const [stats, marked, memory] = await Promise.all([
      exec('ps', ['-A', '-o', 'pid=,ppid=,pgid=,pcpu=,rss=']),
      exec('ps', ['-A', '-ww', PS_ENV, '-o', 'pid=,command='], { maxBuffer: PS_BUFFER }),
      memoryNow(),
    ])
    const home = homedir()
    const fs = statfsSync(home)
    const [one, five, fifteen] = loadavg()
    return {
      at: lastMachineAt,
      cpus: availableParallelism(),
      load: [one, five, fifteen],
      ...(memory && { memory }),
      disk: { path: home, total: fs.blocks * fs.bsize, free: fs.bavail * fs.bsize },
      use: useOf(parseProcs(stats.stdout, marked.stdout), groups),
    }
  })()
  lastMachine.catch(() => (lastMachine = undefined))
  return lastMachine
}

/** What telling a requester came to: told (perhaps by resuming it), not told and why, or to try again next round. */
type Telling = Pick<ToldFact, 'to' | 'resumed' | 'failed'> | 'retry'

const start: Start = (ctx: StartCtx) => {
  const settings = () => ctx.settings as Settings
  const factsOf = () => (ctx.own.streams(QUEUE) as QueueFacts).facts
  const viewsNow = (board: Board = ctx.board(), now = Date.now()) => viewsOf(entriesOf(factsOf()), board.jobs, board.jobsUp, now)

  /** Appends a queue fact, and resolves once the tower's fold holds it. */
  const append = async (code: QueueFact[1], fact: QueueFact[2]) => {
    const before = factsOf().length
    await ctx.streams.append(QUEUE, {}, code, fact)
    await until(() => (factsOf().length > before ? true : undefined), TRACK_MS)
  }

  /** Runs a job's cleanup command, if it has one, in its folder. */
  const cleanup = async (v: View): Promise<{ exit: number | null; signal?: string } | undefined> => {
    if (!v.cleanup || !v.job) return undefined
    try {
      const r = await ctx.run(['/bin/sh', '-c', v.cleanup], { cwd: v.cwd, env: { COMPUTE_JOB: String(v.n) }, timeoutMs: CLEANUP_MS })
      return { exit: r.exit, ...(r.signal && { signal: r.signal }) }
    } catch (err) {
      return { exit: null, signal: `could not run: ${(err as Error).message}` }
    }
  }

  /** The worker a session runs as now: on the board, else in its floor's archive (sent home, let go). */
  const requesterCard = async (v: View, board: Board): Promise<Card | undefined> => {
    const onBoard = cardOfSession(boardCards(board), v.by)
    if (onBoard) return onBoard
    const archived = await ctx.read('tower/archive/<project>', { project: v.project })
    return isApiError(archived) ? undefined : cardOfSession(archived as Card[], v.by)
  }

  /**
   * Tells a requester its job is over. A running worker gets a line at its prompt; one busy with a question or a
   * screen is tried again next round. One that isn't running, on the board or sent home, is resumed with the line as
   * its first prompt. Only a job queued from outside a worker, a worker that can't be found, or a resume the tower
   * refuses is left unsaid, for the user's list.
   */
  const tell = async (v: View, board: Board): Promise<Telling> => {
    if (v.by === 'user') return { failed: 'it was queued from outside a worker' }
    const card = await requesterCard(v, board)
    const who = card?.callsign ?? v.callsign ?? v.by
    if (!card) return { failed: `${who} can't be found on ${v.project}` }
    if (card.live) {
      const reply = await ctx.call('tower/submit', { id: card.id, text: tellText(v) })
      if (!isApiError(reply)) return { to: who }
      return reply.code === 'not_at_prompt' ? 'retry' : { to: who, failed: `${who} refused the line: ${reply.message}` }
    }
    const offered = callOf(card, 'resume')
    if (!offered) return { to: who, failed: `${who} isn't running and can't be resumed` }
    const [verb, input] = offered
    const reply = await ctx.call(`tower/${verb}`, { ...input, prompt: resumeText(v) })
    if (isApiError(reply)) return { to: who, failed: `resuming ${who} was refused: ${reply.message}` }
    return { to: who, resumed: (reply as { id: string }).id }
  }

  /**
   * Cleanups run as each job is first found over, before its requester is told, which may take rounds while it is
   * busy. Held here until the `y` fact records them: after a restart one runs again, so a cleanup must be safe to repeat.
   */
  const cleaned = new Map<number, { exit: number | null; signal?: string } | undefined>()

  /** One round: clean up after and tell the requesters of jobs that are over, then start what fits. */
  let busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      const board = ctx.board()
      if (!board.jobsUp) return
      for (const v of untold(viewsNow(board))) {
        if (!cleaned.has(v.n)) cleaned.set(v.n, await cleanup(v))
        const told = await tell(v, board)
        if (told === 'retry') continue
        const ran = cleaned.get(v.n)
        await append('y', { n: v.n, outcome: v.outcome!, ...told, ...(ran && { cleanup: ran }) })
        cleaned.delete(v.n)
      }
      const views = viewsNow()
      for (const n of nextStarts(views, settings().resources)) {
        const v = views[n - 1]
        try {
          const { id } = await ctx.jobs.start(v.argv, { cwd: v.cwd, label: `#${n} ${v.label}`, env: { COMPUTE_JOB: String(n), GIT_TERMINAL_PROMPT: '0' } })
          await append('o', { n, job: id })
        } catch (err) {
          await append('f', { n, reason: (err as Error).message })
        }
      }
    } finally {
      busy = false
    }
  }
  ctx.every(TICK_MS, tick)

  /** The worker calling, by the session it called from; undefined for the user or a script. */
  const callerCard = (call: CallCtx): Card | undefined =>
    call.caller.t === 'worker' && call.caller.id !== undefined ? cardOfSession(call.cards(), call.caller.id) : undefined

  /** Who a verb is by: the calling worker's session, or `user`. */
  const byOf = (call: CallCtx) => {
    const card = callerCard(call)
    return card ? { by: call.caller.id!, callsign: card.callsign } : { by: 'user' }
  }

  /** A job's folder: absolute, or relative to the caller's checkout, or the checkout itself. */
  const folderOf = (cwd: string | undefined, card: Card | undefined): string | { problem: string } => {
    if (cwd && path.isAbsolute(cwd)) return cwd
    if (!card) return { problem: 'Say the folder it runs in: --cwd <absolute path> (run from outside a worker, there is no checkout to run in)' }
    return path.resolve(card.cwd, cwd ?? '.')
  }

  const isFolder = (dir: string) => {
    try {
      return statSync(dir).isDirectory()
    } catch {
      return false
    }
  }

  return {
    reduce: { [QUEUE]: QUEUE_REDUCE },
    folds: {
      /**
       * The board's part: the machine's resources and the jobs worth showing, for a page to draw; and each job whose
       * requester couldn't be told on the user's list, at its floor, until it is marked seen.
       */
      board: (_board: Board, fold: FoldCtx): Part => {
        const { resources } = fold.settings as Settings
        const views = viewsOf(entriesOf((fold.own.streams[QUEUE] as QueueFacts).facts), fold.board.jobs, fold.board.jobsUp, fold.now)
        const floors = new Set(fold.board.floors.map((f) => f.id))
        const asks = listed(views)
          .filter((v) => floors.has(v.project))
          .map(
            (v): Ask => ({
              key: `job-${v.n}`,
              subject: `floor:${v.project}`,
              title: listTitle(v),
              since: v.told!.at,
              sound: 'wait',
              actions: [{ verb: 'compute/seen', call: { job: v.n }, words: { label: 'Seen', hint: 'you read it: take it off the list' } }],
            }),
          )
        return {
          x: { resources, used: usedOf(views), queued: views.filter((v) => v.status === 'queued').length, jobs: recent(views, fold.now).map((v) => plainJob(v, fold.now)) },
          ...(asks.length && { asks }),
        }
      },
    },
    verbs: {
      run: async (
        input: { project: string; argv: string[]; need?: string[]; hours?: number; tag?: string[]; cap?: string[]; label?: string; cwd?: string; cleanup?: string },
        call: CallCtx,
      ) => {
        const card = callerCard(call)
        const cwd = folderOf(input.cwd, card)
        if (typeof cwd !== 'string') return apiError('invalid', cwd.problem)
        if (!isFolder(cwd)) return apiError('invalid', `${cwd} is not a folder: --cwd names the folder the job runs in`)
        const needs = input.need?.length ? pairsOf(input.need, 'need', count) : settings().defaultNeeds
        if (typeof needs === 'string') return apiError('invalid', `${needs}: --need lanes=2`)
        const tags = pairsOf(input.tag ?? [], 'tag', (v) => v)
        if (typeof tags === 'string') return apiError('invalid', `${tags}: --tag mission=boss-05`)
        const caps = pairsOf(input.cap ?? [], 'cap', count)
        if (typeof caps === 'string') return apiError('invalid', `${caps}: --cap mission=2`)
        const why = unrunnable({ needs, tags, caps }, settings().resources)
        if (why) return apiError('refused', `It could never start: ${why}`)
        const fact: QueuedFact = {
          argv: input.argv,
          cwd,
          label: input.label?.trim() || input.argv.join(' ').slice(0, 80),
          project: input.project,
          needs,
          ...(input.hours !== undefined && { hours: input.hours }),
          tags,
          caps,
          ...(input.cleanup && { cleanup: input.cleanup }),
          ...byOf(call),
        }
        await append('j', fact)
        const n = entriesOf(factsOf()).length
        const ahead = viewsNow().filter((v) => v.status === 'queued' && v.n < n).length
        void tick()
        return {
          n,
          said: `Queued #${n} ${fact.label}${ahead ? `, ${ahead} ahead of it` : ''}. It starts once the machine has room (\`tower x compute jobs\`), and ${card ? 'you are told at your prompt' : 'the queue says'} when it is over.`,
        }
      },
      cancel: async ({ job }: { job: number }, call: CallCtx) => {
        const v = viewsNow()[job - 1]
        if (!v) return apiError('not_found', `No job #${job}: \`tower x compute jobs\` lists them`)
        if (v.status === 'queued') {
          await append('q', { n: job, ...byOf(call) })
          return { said: `Withdrew #${job} ${v.label}: it never started.` }
        }
        if (v.status === 'running') {
          await ctx.jobs.cancel(v.job!)
          return { said: `Cancelling #${job} ${v.label}: the jobs daemon stops it${v.cleanup ? ', then its cleanup runs' : ''}, and its requester is told.` }
        }
        return apiError('refused', `#${job} ${v.label} is ${v.status === 'withdrawn' ? 'withdrawn already' : `over already: ${v.outcome}`}`)
      },
      seen: async ({ job }: { job: number }, call: CallCtx) => {
        const v = viewsNow()[job - 1]
        if (!v) return apiError('not_found', `No job #${job}: \`tower x compute jobs\` lists them`)
        if (!listed([v]).length) return apiError('refused', `#${job} ${v.label} is not on the list: only a job whose requester couldn't be told is`)
        await append('s', { n: job, by: byOf(call).by })
        return { said: `#${job} ${v.label} is off the list.` }
      },
    },
    reads: {
      jobs: ({ query }: { query: { tag?: string; all?: 'true' | 'false' } }) => {
        const now = Date.now()
        const { resources } = settings()
        const views = viewsNow(ctx.board(), now)
        const tag = query.tag === undefined ? undefined : pairsOf([query.tag], 'tag', (v) => v)
        if (typeof tag === 'string') return apiError('invalid', `${tag}: tag=mission=boss-05`)
        const [name, value] = tag ? Object.entries(tag)[0] : []
        const shown = (query.all === 'true' ? views : recent(views, now)).filter((v) => name === undefined || v.tags[name] === value)
        return {
          resources,
          used: usedOf(views),
          jobs: shown.map((v) => plainJob(v, now)),
          lines: [resourcesLine(views, resources), ...(shown.length ? shown.map((v) => jobLine(v, views, resources, now)) : ['No job to show.'])],
        }
      },
      machine: async () => {
        const board = ctx.board()
        const views = viewsNow(board)
        const m = await machineNow(jobGroups(board.jobs, views))
        const cards = boardCards(board)
        const worker = (session: string) => {
          const card = cardOfSession(cards, session)
          return card ? { callsign: card.callsign, project: card.project } : {}
        }
        const label = (n: number) => views[n - 1]?.label
        const byUse = (a: Use, b: Use) => b.cpu - a.cpu || b.rss - a.rss
        return {
          ...m,
          tones: {
            load: loadTone(m.load[0], m.cpus),
            ...(m.memory && { memory: memoryTone(m.memory.used, m.memory.total) }),
            disk: diskTone(m.disk.free, m.disk.total),
          },
          use: {
            ...m.use,
            workers: Object.entries(m.use.workers)
              .sort(([, a], [, b]) => byUse(a, b))
              .map(([session, u]) => ({ session, ...worker(session), ...u })),
            jobs: Object.entries(m.use.jobs)
              .sort(([, a], [, b]) => byUse(a, b))
              .map(([n, u]) => ({ n: Number(n), ...(label(Number(n)) !== undefined && { label: label(Number(n)) }), ...u })),
          },
          lines: machineLines(m, {
            worker: (s) => {
              const w = worker(s)
              return w.callsign ? `${w.callsign} on ${w.project}` : `a worker gone from the board (${s})`
            },
            job: (n) => `#${n}${label(n) ? ` ${label(n)}` : ''}`,
          }),
        }
      },
    },
  }
}

/** Resolves to what `get` finds, read every 25 ms, or undefined once `ms` pass. */
const until = async <T>(get: () => T | undefined, ms: number): Promise<T | undefined> => {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await new Promise((done) => setTimeout(done, 25))) {
    const found = get()
    if (found !== undefined) return found
  }
  return undefined
}

export default start
