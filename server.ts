/**
 * Compute: a queue for long or heavy commands on the machine the tower runs on. `run` records a job in the `queue`
 * stream; every few seconds the scheduler starts the oldest queued jobs that fit the machine's free resources in the
 * jobs daemon, and tells each requester at its prompt once its job is over, after running the job's cleanup.
 *
 * What it decides is pure and lives in `compute.ts`. Here: reading the stream and the board, the jobs daemon, the
 * prompts, and the verbs and the read.
 */
import { statSync } from 'node:fs'
import path from 'node:path'
import type { Board, Card } from '/lib/board.js'
import { apiError, isApiError, type CallCtx, type Reduce, type Start, type StartCtx } from '/lib/extension.js'
import {
  DAY_MS,
  count,
  entriesOf,
  jobLine,
  nextStarts,
  overdue,
  pairsOf,
  resourcesLine,
  tellText,
  unrunnable,
  untold,
  usedOf,
  viewsOf,
  type QueueFact,
  type QueueFacts,
  type QueuedFact,
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

  /** Tells a requester its job is over, at its prompt; why it couldn't, if it couldn't. */
  const tell = async (v: View, board: Board): Promise<{ to?: string; failed?: string }> => {
    if (v.by === 'user') return {}
    const card = cardOfSession(boardCards(board), v.by)
    if (!card) return { failed: `${v.callsign ?? v.by} is no longer on the board` }
    if (!card.live) return { to: card.callsign, failed: `${card.callsign} isn't running` }
    const reply = await ctx.call('tower/submit', { id: card.id, text: tellText(v) })
    return { to: card.callsign, ...(isApiError(reply) && { failed: reply.message }) }
  }

  /** One round: tell the requesters of jobs that are over, then start what fits. */
  let busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      const board = ctx.board()
      if (!board.jobsUp) return
      for (const v of untold(viewsNow(board))) {
        const ran = await cleanup(v)
        const told = await tell(v, board)
        await append('y', { n: v.n, outcome: v.outcome!, ...told, ...(ran && { cleanup: ran }) })
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

  const plain = (v: View, now: number) => ({
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
    status: v.status,
    ...(v.outcome && { outcome: v.outcome }),
    queuedAt: v.queuedAt,
    ...(v.startedAt !== undefined && { startedAt: v.startedAt }),
    ...(v.endedAt !== undefined && { endedAt: v.endedAt }),
    ...(v.job && { job: v.job }),
    ...(overdue(v, now) && { overdue: true }),
  })

  return {
    reduce: { [QUEUE]: QUEUE_REDUCE },
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
          by: card ? call.caller.id! : 'user',
          ...(card && { callsign: card.callsign }),
        }
        await append('j', fact)
        const n = entriesOf(factsOf()).length
        const views = viewsNow()
        const ahead = views.filter((v) => v.status === 'queued' && v.n < n).length
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
          const card = callerCard(call)
          await append('q', { n: job, by: card ? call.caller.id! : 'user', ...(card && { callsign: card.callsign }) })
          return { said: `Withdrew #${job} ${v.label}: it never started.` }
        }
        if (v.status === 'running') {
          await ctx.jobs.cancel(v.job!)
          return { said: `Cancelling #${job} ${v.label}: the jobs daemon stops it${v.cleanup ? ', then its cleanup runs' : ''}, and its requester is told.` }
        }
        return apiError('refused', `#${job} ${v.label} is ${v.status === 'withdrawn' ? 'withdrawn already' : `over already: ${v.outcome}`}`)
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
        const shown = views.filter((v) => {
          if (name !== undefined && v.tags[name] !== value) return false
          if (query.all === 'true' || v.status === 'queued' || v.status === 'running' || !v.told) return true
          return v.told.at > now - DAY_MS
        })
        return {
          resources,
          used: usedOf(views),
          jobs: shown.map((v) => plain(v, now)),
          lines: [resourcesLine(views, resources), ...(shown.length ? shown.map((v) => jobLine(v, views, resources, now)) : ['No job to show.'])],
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
