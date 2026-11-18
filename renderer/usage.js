/**
 * The machine and who uses it, a band of tiles over the queue: its CPU, memory and disk; the share of each that
 * workers, compute's jobs, other jobs, the tower's shells, the tower itself and the rest of the machine hold; the
 * heaviest workers and jobs; each floor's workers; and every job in the jobs daemon. The measures are compute's
 * `machine` read, by process and owner, whatever runtime a worker runs; the jobs and floors are the board's.
 */
import { esc, plural } from '/lib/words.js'

/**
 * @typedef {'calm' | 'busy' | 'over'} Tone
 * @typedef {{ cpu: number, rss: number, procs: number }} Use
 * @typedef {{ at: number, cpus: number, load: [number, number, number], memory?: { total: number, used: number, compressed?: number },
 *   disk: { path: string, total: number, free: number }, tones: { load: Tone, memory?: Tone, disk: Tone },
 *   use: { workers: (Use & { session: string, callsign?: string, project?: string })[], jobs: (Use & { n: number, label?: string })[],
 *     otherJobs: Use, shells: Use, tower: Use, rest: Use, total: Use } }} Machine
 * @typedef {{ id: string, callsign: string, project: string, onDuty: boolean, lineage: { id: string }[] }} Card
 * @typedef {{ id: string, owner: string, state: 'running' | 'ended' | 'cancelled' | 'lost' }} BoardJob
 */

const TONE_CLASS = { calm: '', busy: 'warm', over: 'hot' }

/** Bytes in the unit that reads best. */
export const bytes = (/** @type {number} */ b) => (b >= 1e12 ? `${(b / 1e12).toFixed(1)} TB` : b >= 1e9 ? `${(b / 1e9).toFixed(b >= 1e10 ? 0 : 1)} GB` : `${Math.round(b / 1e6)} MB`)
const processes = (/** @type {number} */ n) => `${n} ${n === 1 ? 'process' : 'processes'}`
/** ps's percent of one core, in cores. */
export const cores = (/** @type {number} */ cpu) => `${(cpu / 100).toFixed(1)}`

const tile = (/** @type {string} */ title, /** @type {string} */ body, /** @type {string} */ cls = '') =>
  `<article class="tile${cls ? ` ${cls}` : ''}"><h3>${esc(title)}</h3>${body}</article>`

/** A gauge: its name and a note, its figure, and a bar as full as `share`, coloured by its tone. */
const gauge = (/** @type {string} */ name, /** @type {string} */ note, /** @type {string} */ value, /** @type {number} */ share, /** @type {Tone | undefined} */ tone, /** @type {string} */ tip) =>
  `<li class="${TONE_CLASS[tone ?? 'calm']}" data-tip="${esc(tip)}"><span>${esc(name)} <small>${esc(note)}</small></span><span class="n">${esc(value)}</span><div class="gauge"><i style="width:${Math.max(0, Math.min(100, share * 100))}%"></i></div></li>`

const machineTile = (/** @type {Machine} */ m) => {
  const loadShare = m.load[0] / m.cpus
  const rows = [
    gauge('CPU', `${m.cpus} cores · ${m.load[1].toFixed(1)} over 5 min`, `${Math.round(loadShare * 100)}%`, loadShare, m.tones.load,
      `Load ${m.load[0].toFixed(1)} over the last minute against ${m.cpus} cores: past 100%, work waits for a core`),
    m.memory
      ? gauge('Memory', `${bytes(m.memory.used)} of ${bytes(m.memory.total)}${m.memory.compressed ? ` · ${bytes(m.memory.compressed)} compressed` : ''}`, `${Math.round((m.memory.used / m.memory.total) * 100)}%`,
          m.memory.used / m.memory.total, m.tones.memory, 'Memory in use: wired, compressed and what programs hold, as Activity Monitor counts it. Cached files are free to take, so they aren’t in use')
      : '',
    gauge('Disk', `${bytes(m.disk.free)} free of ${bytes(m.disk.total)}`, `${Math.round((1 - m.disk.free / m.disk.total) * 100)}%`, 1 - m.disk.free / m.disk.total, m.tones.disk,
      `The disk holding ${m.disk.path}: how full it is`),
  ]
  return tile('Machine', `<ul class="gauges">${rows.join('')}</ul>`)
}

/** The owners a process can have, in the order the split bars stack them, each in its own series colour. */
const sum = (/** @type {Use[]} */ us) => us.reduce((a, u) => ({ cpu: a.cpu + u.cpu, rss: a.rss + u.rss, procs: a.procs + u.procs }), { cpu: 0, rss: 0, procs: 0 })
const groupsOf = (/** @type {Machine} */ m) => [
  { key: 'workers', name: 'Workers', use: sum(m.use.workers), tip: 'Every process a worker started, whatever its runtime: the agent, its tools, its servers, what it left running' },
  { key: 'jobs', name: 'Compute’s jobs', use: sum(m.use.jobs), tip: 'The jobs compute’s queue started, and everything they started' },
  { key: 'other', name: 'Other jobs', use: m.use.otherJobs, tip: 'Jobs in the jobs daemon that compute didn’t start' },
  { key: 'shells', name: 'Shells', use: m.use.shells, tip: 'The shells the tower page opens, and what runs in them' },
  { key: 'tower', name: 'The tower', use: m.use.tower, tip: 'The tower’s own daemons: the host, terms, jobs and the tower, extensions included' },
  { key: 'rest', name: 'Everything else', use: m.use.rest, tip: 'The rest of the machine: your apps, the system' },
]

/** One bar split by owner: each part as wide as its share of what all processes use. */
const split = (/** @type {{ key: string, value: number }[]} */ parts) => {
  const total = parts.reduce((a, p) => a + p.value, 0)
  return `<div class="split">${parts.filter((p) => p.value > 0).map((p) => `<i class="s-${p.key}" style="flex:${p.value / (total || 1)}"></i>`).join('')}</div>`
}

const whoTile = (/** @type {Machine} */ m) => {
  const groups = groupsOf(m)
  const rows = groups
    .map((g) => `<li data-tip="${esc(`${g.tip}. ${processes(g.use.procs)}`)}"><span class="key s-${g.key}"></span><span class="one-line">${esc(g.name)}</span><span class="n">${cores(g.use.cpu)}</span><span class="n">${bytes(g.use.rss)}</span></li>`)
    .join('')
  return tile(
    'Who uses it',
    `<div class="bars"><span>CPU</span>${split(groups.map((g) => ({ key: g.key, value: g.use.cpu })))}<span>Memory</span>${split(groups.map((g) => ({ key: g.key, value: g.use.rss })))}</div>
     <ul class="legend"><li class="head"><span></span><span></span><span class="n">cores</span><span class="n">memory</span></li>${rows}</ul>`,
    'wide',
  )
}

const heaviestTile = (/** @type {Machine} */ m) => {
  const rows = [
    ...m.use.workers.map((w) => ({ key: 'workers', name: w.callsign ?? `…${w.session.slice(-4)}`, where: w.project ?? 'gone from the board', use: w })),
    ...m.use.jobs.map((j) => ({ key: 'jobs', name: `#${j.n}${j.label ? ` ${j.label}` : ''}`, where: 'compute', use: j })),
  ]
    .sort((a, b) => b.use.cpu - a.use.cpu || b.use.rss - a.use.rss)
    .slice(0, 6)
  if (!rows.length) return tile('Heaviest', '<p class="muted">No worker or job runs a process now.</p>')
  return tile(
    'Heaviest',
    `<ul class="legend">${rows
      .map((r) => `<li data-tip="${esc(`${r.name} on ${r.where}: ${processes(r.use.procs)}`)}"><span class="key s-${r.key}"></span><span class="one-line">${esc(r.name)}</span><span class="n">${cores(r.use.cpu)}</span><span class="n">${bytes(r.use.rss)}</span></li>`)
      .join('')}</ul>`,
  )
}

const floorsTile = (/** @type {any} */ board, /** @type {Machine} */ m) => {
  /** @type {{ id: string, name: string, cards: Card[] }[]} */
  const floors = board.floors
  const rows = floors
    .map((f) => ({ name: f.name, duty: f.cards.filter((c) => c.onDuty).length, use: sum(m.use.workers.filter((w) => w.project === f.id)) }))
    .filter((r) => r.duty || r.use.procs)
    .sort((a, b) => b.use.rss - a.use.rss)
  if (!rows.length) return tile('Floors', '<p class="muted">Nobody is on duty.</p>')
  const most = Math.max(...rows.map((r) => r.use.rss), 1)
  const shown = rows.slice(0, 6)
  return tile(
    'Floors',
    `<ul class="floors">${shown
      .map((r) => `<li data-tip="${esc(`${r.name}: ${plural(r.duty, 'worker')} on duty, ${cores(r.use.cpu)} cores, ${bytes(r.use.rss)} in ${processes(r.use.procs)}`)}"><span class="one-line">${esc(r.name)} <small>${r.duty}</small></span><span class="n">${bytes(r.use.rss)}</span><div class="gauge"><i class="s-workers" style="width:${(r.use.rss / most) * 100}%"></i></div></li>`)
      .join('')}${rows.length > shown.length ? `<li class="more">${esc(`and ${plural(rows.length - shown.length, 'floor')} more`)}</li>` : ''}</ul>`,
  )
}

/** Who a job is by: the user, the worker whose session started it, or the extension that did. */
const ownerName = (/** @type {string} */ owner, /** @type {Card[]} */ cards) =>
  owner === 'user' ? 'you' : (cards.find((c) => c.lineage.some((l) => l.id === owner))?.callsign ?? owner)

const jobsTile = (/** @type {any} */ board, /** @type {any} */ c) => {
  if (!board.jobsUp) return tile('Jobs', '<p class="note broken">The jobs daemon isn’t running: no job starts until it is back.</p>')
  /** @type {BoardJob[]} */
  const running = board.jobs.filter((/** @type {BoardJob} */ j) => j.state === 'running')
  /** @type {Card[]} */
  const cards = board.floors.flatMap((/** @type {{ cards: Card[] }} */ f) => f.cards)
  const ours = new Set((c?.jobs ?? []).map((/** @type {{ job?: string }} */ j) => j.job).filter(Boolean))
  const byOwner = new Map()
  for (const j of running) {
    const who = ours.has(j.id) ? 'compute' : ownerName(j.owner, cards)
    byOwner.set(who, (byOwner.get(who) ?? 0) + 1)
  }
  const owners = [...byOwner].sort((a, b) => b[1] - a[1]).map(([who, n]) => (who === 'compute' ? `${n} from the queue` : `${n} by ${who}`))
  const lost = board.jobs.filter((/** @type {BoardJob} */ j) => j.state === 'lost').length
  return tile(
    'Jobs',
    `<div class="fig" data-tip="Jobs the jobs daemon runs now, whoever started them: compute’s queue, workers, you, extensions"><b>${running.length}</b><span>running</span></div>
     ${owners.length ? `<p class="sub">${esc(owners.join(' · '))}</p>` : '<p class="sub">nothing runs in the jobs daemon</p>'}
     ${c?.queued ? `<p class="sub warm">${esc(`${c.queued} queued in compute`)}</p>` : ''}
     ${lost ? `<p class="sub hot">${esc(`${plural(lost, 'job')} lost: the daemon no longer holds them`)}</p>` : ''}`,
  )
}

/** The band: a tile each, the machine first. Until the first read, only the board's tiles. */
export const usageHtml = (/** @type {any} */ board, /** @type {Machine | { failed: string } | undefined} */ machine) => {
  const jobs = jobsTile(board, board.x?.compute)
  if (!machine) return tile('Machine', '<p class="muted">Reading the machine…</p>') + jobs
  if ('failed' in machine) return tile('Machine', `<p class="note broken">${esc(machine.failed)}</p>`) + jobs
  return [machineTile(machine), whoTile(machine), heaviestTile(machine), floorsTile(board, machine), jobs].join('')
}
