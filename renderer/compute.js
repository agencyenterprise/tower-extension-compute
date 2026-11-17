/**
 * The Compute page: the machine's resources and its queue, from the board's `x.compute`, which the compute extension
 * folds. It draws, and acts only through compute's verbs (`compute/cancel`, `compute/seen`): a worker or any other page
 * can do all it does. A job's screen opens at the page's foot, read only, from the tower's `job/<id>/screen` stream.
 *
 * The filters (a floor, a tag) live in the hash, so a link keeps them.
 */
import { esc } from '/lib/words.js'
import { loadTerminalFont, mountTermView, SHELL_SCROLLBACK, terminalFont } from '/lib/terminal.js'

/**
 * @typedef {{ n: number, label: string, argv: string[], cwd: string, project: string, by: string, callsign?: string,
 *   needs: Record<string, number>, tags: Record<string, string>, caps: Record<string, number>, hours?: number,
 *   status: 'queued' | 'running' | 'over' | 'withdrawn', outcome?: string, queuedAt: number, startedAt?: number,
 *   endedAt?: number, withdrawnAt?: number, job?: string, overdue?: true, seenAt?: number,
 *   told?: { at: number, to?: string, resumed?: string, failed?: string } }} Job
 * @typedef {{ resources: Record<string, number>, used: Record<string, number>, queued: number, jobs: Job[] }} Compute
 */

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id))

/** @type {{ board?: any, screen?: { n: number, close: () => void } }} */
const state = {}

// ---------- the filters, in the hash ----------

const filtersOf = () => {
  const q = new URLSearchParams(location.hash.slice(1))
  return { floor: q.get('floor') ?? '', tag: q.get('tag') ?? '' }
}
const setFilters = (/** @type {{ floor: string, tag: string }} */ f) => {
  const q = new URLSearchParams()
  if (f.floor) q.set('floor', f.floor)
  if (f.tag) q.set('tag', f.tag)
  history.replaceState(null, '', q.size ? `#${q}` : location.pathname)
  draw()
}

/** Whether a job passes the filters: its floor, and a tag it carries (`name=value`, or a word any of its tags hold). */
const shown = (/** @type {Job} */ j, /** @type {{ floor: string, tag: string }} */ f) => {
  if (f.floor && j.project !== f.floor) return false
  const t = f.tag.trim()
  if (!t) return true
  const tags = Object.entries(j.tags).map(([k, v]) => `${k}=${v}`)
  return t.includes('=') ? tags.includes(t) : tags.some((x) => x.includes(t)) || j.label.includes(t)
}

// ---------- words ----------

const duration = (/** @type {number} */ ms) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const min = Math.round(s / 60)
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  return `${h} h${min % 60 ? ` ${min % 60} min` : ''}`
}
const ago = (/** @type {number} */ at) => `${duration(Date.now() - at)} ago`
const hoursWords = (/** @type {number} */ h) => (h < 1 ? duration(h * 3_600_000) : `${h} h`)
const needsWords = (/** @type {Record<string, number>} */ needs) =>
  Object.entries(needs)
    .map(([k, u]) => `${k} ${u}`)
    .join(', ') || 'nothing'

/** What a queued job waits for, as compute decides it: units of a resource, or room under one of its caps. */
const waitsFor = (/** @type {Job} */ j, /** @type {Compute} */ c) => {
  const running = c.jobs.filter((x) => x.status === 'running')
  for (const [k, units] of Object.entries(j.needs)) {
    const total = c.resources[k]
    if (total === undefined) return `${k}, which the machine no longer names`
    const free = total - (c.used[k] ?? 0)
    if (units > free) return `${units} ${k} (${Math.max(0, free)} of ${total} free)`
  }
  for (const [tag, max] of Object.entries(j.caps)) {
    const alike = running.filter((x) => x.tags[tag] === j.tags[tag]).length
    if (alike >= max) return `its cap: ${alike} of ${tag}=${j.tags[tag]} run, at most ${max}`
  }
  return 'its turn: it starts within seconds'
}

/** A job's state as a word in a tone, and a line under it. */
const stateOf = (/** @type {Job} */ j, /** @type {Compute} */ c) => {
  if (j.status === 'queued') return { word: 'queued', tone: 'quiet', why: `waits for ${waitsFor(j, c)}` }
  if (j.status === 'running') return { word: j.overdue ? 'running long' : 'running', tone: j.overdue ? 'needs' : 'ready', why: j.overdue ? `past the ${hoursWords(j.hours ?? 0)} it was given` : '' }
  if (j.status === 'withdrawn') return { word: 'withdrawn', tone: 'quiet', why: '' }
  const ok = /^exit 0\b/.test(j.outcome ?? '')
  const told = !j.told ? 'telling its requester' : j.told.failed !== undefined ? '' : j.told.resumed ? `${j.told.to} was resumed to be told` : j.told.to ? `${j.told.to} was told` : ''
  return { word: j.outcome ?? 'over', tone: ok ? 'quiet' : 'broken', why: told }
}

/** The time column: how long it has waited, run, or took, and when. */
const timeOf = (/** @type {Job} */ j) => {
  if (j.status === 'queued') return `waiting ${duration(Date.now() - j.queuedAt)}`
  if (j.status === 'running') return `${duration(Date.now() - (j.startedAt ?? Date.now()))}${j.hours !== undefined ? ` of ${hoursWords(j.hours)}` : ''}`
  if (j.status === 'withdrawn') return j.withdrawnAt ? ago(j.withdrawnAt) : ''
  return j.endedAt ? ago(j.endedAt) : j.told ? ago(j.told.at) : ''
}

// ---------- drawing ----------

const meterHtml = (/** @type {Compute} */ c) => {
  const res = Object.entries(c.resources).map(([k, total]) => {
    const used = c.used[k] ?? 0
    const full = used >= total && c.queued > 0
    const bars = Array.from({ length: Math.min(total, 24) }, (_, i) => `<i class="${i < used ? 'on' : ''}"></i>`).join('')
    return `<div class="res${full ? ' full' : ''}" data-tip="${esc(`${used} of ${total} ${k} in use${full ? ': full, and jobs wait' : ''}`)}"><span class="name">${esc(k)}</span><span class="num">${used}/${total}</span><div class="bar">${bars}</div></div>`
  })
  return `${res.join('') || '<span class="muted">no resources set</span>'}<span class="queued${c.queued ? ' waiting' : ''}">${c.queued} queued</span>`
}

const rowHtml = (/** @type {Job} */ j, /** @type {Compute} */ c) => {
  const s = stateOf(j, c)
  const listed = j.told?.failed !== undefined && j.seenAt === undefined
  const tags = Object.entries(j.tags)
    .map(([k, v]) => `<button type="button" class="chip-t" data-tag="${esc(`${k}=${v}`)}" data-tip="Show only the jobs tagged ${esc(`${k}=${v}`)}">${esc(`${k}=${v}`)}</button>`)
    .join('')
  const acts = [
    j.job ? `<button type="button" class="act" data-screen="${j.n}" data-tip="Its screen, read only">Screen</button>` : '',
    listed ? `<button type="button" class="act" data-seen="${j.n}" data-tip="You read it: take it off your list">Seen</button>` : '',
    j.status === 'queued' || j.status === 'running'
      ? `<button type="button" class="act danger" data-cancel="${j.n}" data-tip="${j.status === 'queued' ? 'Withdraw it: it never starts' : 'Stop it: SIGTERM, SIGKILL 5 s later, then its cleanup runs'}">${j.status === 'queued' ? 'Withdraw' : 'Cancel'}</button>`
      : '',
  ].join('')
  return `<tr>
    <td class="n">#${j.n}</td>
    <td><span class="label one-line" data-tip="${esc(j.label)}">${esc(j.label)}</span><code class="cmd one-line" data-tip="${esc(`${j.argv.join(' ')}\nin ${j.cwd}`)}">${esc(j.argv.join(' '))}</code>${tags ? `<div class="chips">${tags}</div>` : ''}</td>
    <td class="who">${esc(j.callsign ?? (j.by === 'user' ? 'you' : j.by))}<small>${esc(j.project)}</small></td>
    <td><span class="state t-${s.tone}">${esc(s.word)}</span>${s.why ? `<span class="why">${esc(s.why)}</span>` : ''}${listed ? `<span class="listed">on your list: ${esc(j.told?.failed ?? '')}</span>` : ''}</td>
    <td class="time">${esc(timeOf(j))}</td>
    <td class="needs-col">${esc(needsWords(j.needs))}</td>
    <td class="acts">${acts}</td>
  </tr>`
}

const sectionHtml = (/** @type {string} */ title, /** @type {Job[]} */ jobs, /** @type {Compute} */ c, /** @type {string} */ none) => `
  <section>
    <h2 class="eyebrow">${esc(title)} · ${jobs.length}</h2>
    ${
      jobs.length
        ? `<table class="jobs"><colgroup><col class="c-n"><col><col class="c-who"><col class="c-state"><col class="c-time"><col class="c-holds needs-col"><col class="c-acts"></colgroup><thead><tr><th>#</th><th>Job</th><th>Who</th><th>Where it stands</th><th>Time</th><th class="needs-col">Holds</th><th></th></tr></thead><tbody>${jobs.map((j) => rowHtml(j, c)).join('')}</tbody></table>`
        : `<div class="jobs empty">${esc(none)}</div>`
    }
  </section>`

const draw = () => {
  const board = state.board
  if (!board) return
  /** @type {Compute | undefined} */
  const c = board.x?.compute
  if (!c) {
    $('meter').innerHTML = ''
    $('main').innerHTML = '<p class="note">Compute isn’t running on this tower: add the compute extension to the config, or turn it on.</p>'
    return
  }
  const f = filtersOf()
  const floors = /** @type {{ id: string, name: string }[]} */ (board.floors)
  $('floor').innerHTML = [`<option value="">All floors</option>`, ...floors.map((fl) => `<option value="${esc(fl.id)}"${fl.id === f.floor ? ' selected' : ''}>${esc(fl.name)}</option>`)].join('')
  const tagInput = /** @type {HTMLInputElement} */ ($('tag'))
  if (document.activeElement !== tagInput) tagInput.value = f.tag
  $('meter').innerHTML = meterHtml(c)
  const jobs = c.jobs.filter((j) => shown(j, f))
  const listed = jobs.filter((j) => j.told?.failed !== undefined && j.seenAt === undefined)
  const over = jobs.filter((j) => (j.status === 'over' || j.status === 'withdrawn') && !listed.includes(j)).reverse()
  $('main').innerHTML = [
    listed.length ? sectionHtml('On your list', listed, c, '') : '',
    sectionHtml('Running', jobs.filter((j) => j.status === 'running'), c, 'Nothing runs.'),
    sectionHtml('Queued', jobs.filter((j) => j.status === 'queued'), c, 'Nothing waits.'),
    sectionHtml('Over in the last day', over, c, 'Nothing ended in the last day.'),
  ].join('')
}

// ---------- a job's screen ----------

const openScreen = async (/** @type {number} */ n) => {
  /** @type {Job | undefined} */
  const j = state.board?.x?.compute?.jobs.find((/** @type {Job} */ x) => x.n === n)
  if (!j?.job) return
  state.screen?.close()
  $('screen').hidden = false
  $('screen-title').textContent = `#${j.n} ${j.label} · ${j.job}`
  const host = $('screen-term')
  host.innerHTML = ''
  const font = () => terminalFont(tower.prefs.get())
  await loadTerminalFont(font())
  const xterm = { Terminal: /** @type {any} */ (window).Terminal, FitAddon: /** @type {any} */ (window).FitAddon.FitAddon }
  const id = j.job
  const handle = mountTermView(host, xterm, {
    watch: (on) =>
      tower.watch(`job/${id}/screen`, (/** @type {any} */ msg) => {
        if (msg.t === 'snapshot') return on({ ...msg, terminals: 1 })
        if (msg.t === 'x') return on({ t: 'x', exitCode: msg.exit ?? 1 })
        if (msg.t === 'error') return toast(`The tower no longer keeps that job's screen: ${msg.message ?? ''}`)
        on(msg)
      }),
    resize: () => Promise.resolve(),
    send: () => {},
    wheelReports: false,
    scrollback: SHELL_SCROLLBACK,
    font,
    scheme: () => tower.scheme(),
    keymap: () => state.board.keys,
    run: () => false,
    mode: () => {},
    end: () => {},
    error: (err) => toast(err.message),
  })
  state.screen = { n, close: () => handle.close() }
}

const closeScreen = () => {
  state.screen?.close()
  state.screen = undefined
  $('screen').hidden = true
}

// ---------- acting ----------

const toast = (/** @type {string} */ text) => {
  const el = Object.assign(document.createElement('div'), { className: 'toast', textContent: text })
  $('toasts').append(el)
  setTimeout(() => el.remove(), 6000)
}

const act = async (/** @type {HTMLButtonElement} */ button, /** @type {string} */ verb, /** @type {number} */ job) => {
  button.setAttribute('aria-busy', 'true')
  try {
    // tower.call types the core's verbs; an extension's answers its own reply, compute's `{ said }`.
    const r = /** @type {{ said: string }} */ (/** @type {unknown} */ (await tower.call(/** @type {any} */ (verb), { job })))
    toast(r.said)
  } catch (err) {
    toast(/** @type {Error} */ (err).message)
  } finally {
    button.removeAttribute('aria-busy')
  }
}

document.addEventListener('click', (e) => {
  const button = /** @type {HTMLElement} */ (e.target).closest('button')
  if (!button) return
  const { cancel, seen, screen, tag } = button.dataset
  if (cancel) void act(/** @type {HTMLButtonElement} */ (button), 'compute/cancel', Number(cancel))
  if (seen) void act(/** @type {HTMLButtonElement} */ (button), 'compute/seen', Number(seen))
  if (screen) void openScreen(Number(screen))
  if (tag) setFilters({ ...filtersOf(), tag })
})
$('screen-close').addEventListener('click', closeScreen)
$('floor').addEventListener('change', (e) => setFilters({ ...filtersOf(), floor: /** @type {HTMLSelectElement} */ (e.target).value }))
$('tag').addEventListener('input', (e) => setFilters({ ...filtersOf(), tag: /** @type {HTMLInputElement} */ (e.target).value }))
window.addEventListener('hashchange', draw)

tower.onBoardError((err) => ($('main').innerHTML = `<p class="note broken">${esc(err.message)}</p>`))
tower.subscribe((board) => {
  state.board = board
  draw()
})
// Elapsed times move between boards.
setInterval(draw, 30_000)
