/**
 * The "By <tag>" section, or the lab's missions, drawn as a card per group (groups.js says what each holds): its
 * phases as a stepper, the CPU and memory it uses now as bars against the whole machine, split into its jobs (teal)
 * and its crew (blue), the lanes it holds and the slots its cap leaves, its CPU over the last minutes as a sparkline,
 * a dot per job in the colour of where it stands, and its crew, heaviest first.
 *
 * The sparkline's readings are the page's own, kept in memory while it is open (`recordReadings`): compute stores
 * none, and a reload starts it again.
 */
import { esc } from '/lib/words.js'
import { bytes, cores } from './usage.js'

/**
 * @typedef {import('./groups.js').Group} Group
 * @typedef {import('./groups.js').GroupJob} GroupJob
 * @typedef {import('./usage.js').Machine} Machine
 * @typedef {{ at: number, cpu: number }} Reading
 */

/** How many readings a sparkline keeps: the machine is read every 10 s, so 10 minutes. */
const KEEP = 60
/** @type {Map<string, Reading[]>} each group's CPU readings, keyed `tag=value` */
const readings = new Map()

/** Keep a reading of each group's CPU, its jobs' and its crew's, from one machine read. */
export const recordReadings = (/** @type {string} */ tag, /** @type {Group[]} */ groups, /** @type {number} */ at) => {
  for (const g of groups) {
    const key = `${tag}=${g.value}`
    const list = readings.get(key) ?? []
    if (list.at(-1)?.at === at) continue
    list.push({ at, cpu: g.jobs.cpu + (g.crew?.cpu ?? 0) })
    readings.set(key, list.slice(-KEEP))
  }
}

const pct = (/** @type {number} */ part, /** @type {number} */ whole) => (whole > 0 ? Math.max(0, Math.min(100, (part / whole) * 100)) : 0)
const ago = (/** @type {number} */ ms) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`
}

/** A bar against the whole machine, its jobs' part then its crew's, with a 2px gap between them. */
const splitBar = (/** @type {number} */ jobs, /** @type {number | undefined} */ crew, /** @type {number} */ whole) =>
  `<div class="gbar"><i class="s-jobs" style="width:${pct(jobs, whole)}%"></i>${crew !== undefined ? `<i class="s-workers" style="width:${pct(crew, whole)}%"></i>` : ''}</div>`

const meterRow = (/** @type {string} */ name, /** @type {string} */ value, /** @type {string} */ note, /** @type {string} */ body, /** @type {string} */ tip) =>
  `<div class="grow" data-tip="${esc(tip)}"><span class="gname">${esc(name)}</span><span class="gval">${esc(value)}<small>${esc(note)}</small></span>${body}</div>`

/** CPU and memory now, each against the machine's, split into jobs and crew. */
const useRows = (/** @type {Group} */ g, /** @type {Machine | undefined} */ m) => {
  if (!m) return `<p class="gnote">Reading the machine…</p>`
  const cpu = g.jobs.cpu + (g.crew?.cpu ?? 0)
  const rss = g.jobs.rss + (g.crew?.rss ?? 0)
  const parts = (/** @type {(u: { cpu: number, rss: number }) => string} */ f) =>
    g.crew ? `jobs ${f(g.jobs)} · crew ${f(g.crew)}` : ''
  const coreAll = m.cpus * 100
  const rows = [
    meterRow('CPU', `${cores(cpu)} cores`, ` of ${m.cpus} · ${Math.round(pct(cpu, coreAll))}%`, splitBar(g.jobs.cpu, g.crew?.cpu, coreAll),
      `CPU now, in cores of the machine's ${m.cpus}${g.crew ? `: ${parts((u) => `${cores(u.cpu)} cores`)}` : ''}`),
  ]
  if (m.memory)
    rows.push(meterRow('Memory', bytes(rss), ` of ${bytes(m.memory.total)} · ${Math.round(pct(rss, m.memory.total))}%`, splitBar(g.jobs.rss, g.crew?.rss, m.memory.total),
      `Memory now, resident${g.crew ? `: ${parts((u) => bytes(u.rss))}` : ''}`))
  return rows.join('')
}

/** The units it holds of each resource against the machine's, as lamps, and the slots its cap leaves. */
const holdRows = (/** @type {Group} */ g, /** @type {Record<string, number>} */ resources, /** @type {string} */ tag) => {
  const rows = Object.entries(resources)
    .filter(([k]) => g.holds[k] || g.items.some((j) => j.needs[k]))
    .map(([k, total]) => {
      const held = g.holds[k] ?? 0
      const lamps = Array.from({ length: Math.min(total, 24) }, (_, i) => `<i class="${i < held ? 'on' : ''}"></i>`).join('')
      return meterRow(k, `${held}`, ` of ${total}`, `<div class="lamps">${lamps}</div>`, `${held} of the machine's ${total} ${k} held by its running jobs`)
    })
  if (g.cap !== undefined) {
    const slots = Array.from({ length: Math.min(g.cap, 24) }, (_, i) => `<i class="${i < g.running ? 'on' : ''}"></i>`).join('')
    rows.push(meterRow('Slots', `${g.running}`, ` of ${g.cap}${g.queued ? ` · ${g.queued} waiting` : ''}`, `<div class="lamps slots">${slots}</div>`,
      `At most ${g.cap} of its jobs (${tag}=${g.value}) run at once: ${g.running} run${g.queued ? `, ${g.queued} queued` : ''}`))
  }
  return rows.join('')
}

/** Its CPU over the minutes the page has watched: an area under a 2px line, a hover target per reading. */
const sparkline = (/** @type {string} */ key, /** @type {number} */ now) => {
  const list = readings.get(key) ?? []
  if (list.length < 2) return `<div class="spark empty"><span class="gname">CPU, last 10 min</span><p class="gnote">The page draws it as it reads the machine, every 10 s while open.</p></div>`
  const top = Math.max(100, ...list.map((r) => r.cpu))
  const t0 = list[0].at
  const span = ((list.at(-1)?.at ?? t0) - t0) || 1
  const x = (/** @type {Reading} */ r) => ((r.at - t0) / span) * 100
  const y = (/** @type {Reading} */ r) => 30 - (r.cpu / top) * 28
  const line = list.map((r) => `${x(r).toFixed(2)},${y(r).toFixed(2)}`).join(' ')
  const peak = Math.max(...list.map((r) => r.cpu))
  const w = 100 / list.length
  const hits = list.map((r, i) => `<rect x="${Math.max(0, x(r) - w / 2).toFixed(2)}" y="0" width="${w.toFixed(2)}" height="32"><title>${esc(`${ago(now - r.at)}: ${cores(r.cpu)} cores`)}</title></rect>`).join('')
  return `<div class="spark"><span class="gname">CPU, last ${Math.max(1, Math.round((now - t0) / 60_000))} min</span><span class="gval">peak ${esc(cores(peak))}<small> cores</small></span>
    <svg viewBox="0 0 100 32" preserveAspectRatio="none" role="img" aria-label="${esc(`CPU over the last minutes, peak ${cores(peak)} cores`)}">
      <polygon class="area" points="0,32 ${line} 100,32"></polygon><polyline class="line" points="${line}"></polyline><g class="hits">${hits}</g>
    </svg></div>`
}

/** A job's dot: running amber (red past its hours), queued a grey ring, exit 0 green, a failure dark red, withdrawn grey. */
const dotOf = (/** @type {GroupJob} */ j) => {
  const tone =
    j.status === 'running' ? (j.overdue ? 'needs' : 'working') : j.status === 'queued' ? 'queued' : j.status === 'withdrawn' ? 'quiet' : /^exit 0\b/.test(j.outcome ?? '') ? 'ready' : 'broken'
  const said = j.status === 'over' ? (j.outcome ?? 'over') : j.overdue ? 'running long' : j.status
  return `<i class="jdot d-${tone}" data-tip="${esc(`#${j.n}${j.label ? ` ${j.label}` : ''}: ${said}`)}"></i>`
}

/** Its phases, the ones reached filled and the one it is in named. */
const stepper = (/** @type {import('./groups.js').Mission} */ m) => {
  if (!m.phases.length) return ''
  const at = m.phases.findIndex((p) => p.name === m.phase)
  const steps = m.phases.map((p, i) => `<i class="${m.closed || i < at ? 'done' : i === at ? 'now' : ''}" data-tip="${esc(`${p.name}${i === at && !m.closed ? ': now' : p.at ? ': done' : ''}`)}"></i>`).join('')
  return `<div class="steps"><div class="track">${steps}</div><span>${esc(m.closed ? 'closed' : `${m.phase} · ${at + 1} of ${m.phases.length}`)}</span></div>`
}

const duration = (/** @type {number} */ ms) => {
  const min = Math.round(ms / 60_000)
  if (min < 1) return `${Math.round(ms / 1000)} s`
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`
}

const cardHtml = (/** @type {Group} */ g, /** @type {string} */ tag, /** @type {Record<string, number>} */ resources, /** @type {Machine | undefined} */ machine, /** @type {number} */ now) => {
  const m = g.mission
  const filter = `${tag}=${g.value}`
  const head = m
    ? `<button type="button" class="gtitle one-line" data-tag="${esc(filter)}" data-tip="${esc(`Show only the jobs of ${m.title} (${filter})`)}">${esc(m.title)}</button>
       <a class="act" href="/r/lab/#room/${encodeURIComponent(m.project)}/${encodeURIComponent(m.id)}" target="_top" data-tip="Its room in the lab">Room</a>
       <small class="gmeta one-line">${esc(`${m.floorName} · ${m.playbook} · ${m.coordinator}`)}</small>`
    : `<button type="button" class="gtitle one-line" data-tag="${esc(filter)}" data-tip="${esc(`Show only the jobs tagged ${filter}`)}">${esc(g.value)}</button>`
  const counts = [g.running ? `${g.running} running` : '', g.queued ? `${g.queued} queued` : '', g.over ? `${g.over} over` : ''].filter(Boolean).join(' · ') || 'no jobs shown'
  const crew = g.members?.length
    ? `<ul class="crew">${g.members
        .slice(0, 4)
        .map((w) => `<li data-tip="${esc(`${w.callsign}: ${cores(w.cpu)} cores, ${bytes(w.rss)} in ${w.procs} processes`)}"><i class="s-workers"></i><span class="one-line">${esc(w.callsign ?? '')}</span><span class="n">${cores(w.cpu)}</span><span class="n">${bytes(w.rss)}</span></li>`)
        .join('')}${g.members.length > 4 ? `<li class="more">and ${g.members.length - 4} more</li>` : ''}</ul>`
    : m
      ? `<p class="gnote">${esc(m.closed ? 'Its crew has gone home.' : 'No one of its crew runs a process now.')}</p>`
      : ''
  return `<article class="gcard${m?.closed ? ' closed' : ''}">
    <header class="ghead">${head}</header>
    ${m ? stepper(m) : ''}
    <div class="gmeters">${useRows(g, machine)}${holdRows(g, resources, tag)}</div>
    ${sparkline(`${tag}=${g.value}`, now)}
    <div class="jstrip"><span class="dots">${g.items.map(dotOf).join('')}</span><span class="gnote">${esc(counts)}${g.ranMs ? esc(` · ran ${duration(g.ranMs)}`) : ''}</span></div>
    ${crew}
  </article>`
}

/**
 * The section: its head with the legend for jobs and crew, then the cards. `from`: the extension that lends it what
 * compute doesn't know (the lab, for missions), named by a badge beside its title.
 */
export const groupsSection = (
  /** @type {string} */ title,
  /** @type {string} */ tag,
  /** @type {Group[]} */ groups,
  /** @type {Record<string, number>} */ resources,
  /** @type {Machine | undefined} */ machine,
  /** @type {string} */ none,
  /** @type {string} */ from = '',
) => {
  const crew = groups.some((g) => g.crew)
  const legend = `<span class="glegend"><i class="s-jobs"></i>its jobs${crew ? '<i class="s-workers"></i>its crew' : ''}</span>`
  const now = Date.now()
  return `<section>
    <h2>${esc(title)}<span class="count">${groups.length}</span>${from === 'lab' ? '<span class="from" data-tip="From the lab extension: its missions, phases and crew. Shown while the lab runs">Lab</span>' : ''}${groups.length ? legend : ''}</h2>
    ${groups.length ? `<div class="gcards">${groups.map((g) => cardHtml(g, tag, resources, machine, now)).join('')}</div>` : `<div class="jobs empty">${esc(none)}</div>`}
  </section>`
}
