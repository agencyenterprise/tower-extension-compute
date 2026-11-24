/**
 * The Compute page: the machine's resources and its queue, from the board's `x.compute`, which the compute extension
 * folds. It draws, and acts only through compute's verbs (`compute/cancel`, `compute/seen`): a worker or any other page
 * can do all it does. A job's screen opens at the page's foot, read only, from the tower's `job/<id>/screen` stream.
 *
 * The filters (a floor, a tag) and the tag the jobs are grouped by live in the hash, so a link keeps them. Grouping is by
 * `mission` when the lab runs and the hash says nothing of it (groups.js).
 */
import { esc } from '/lib/words.js'
import { loadTerminalFont, mountTermView, SHELL_SCROLLBACK, terminalFont } from '/lib/terminal.js'
import { copyText, ICON } from '/lib/view.js'
import { watchTips } from '/lib/chrome.js'
import { usageHtml } from './usage.js'
import { groupTag, groupsOf, labMissions, labRuns, tagNames } from './groups.js'
import { groupsSection, recordReadings } from './groupview.js'

/**
 * @typedef {{ n: number, label: string, argv: string[], cwd: string, project: string, by: string, callsign?: string,
 *   needs: Record<string, number>, tags: Record<string, string>, caps: Record<string, number>, hours?: number,
 *   status: 'queued' | 'running' | 'over' | 'withdrawn', outcome?: string, queuedAt: number, startedAt?: number,
 *   endedAt?: number, withdrawnAt?: number, job?: string, overdue?: true, seenAt?: number,
 *   told?: { at: number, to?: string, resumed?: string, failed?: string } }} Job
 * @typedef {{ resources: Record<string, number>, used: Record<string, number>, queued: number, jobs: Job[] }} Compute
 */

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id))

/**
 * `pages`: the page each section shows, by its key, from 0; a section the map doesn't name shows its first.
 * @type {{ board?: any, machine?: import('./usage.js').Machine | { failed: string }, screen?: { n: number, close: () => void }, pages: Record<string, number> }}
 */
const state = { pages: {} }

/** The rows a section draws at once: a day of a busy lab ends hundreds of jobs, and the page redraws every board. */
const PAGE = 50

// ---------- the filters, in the hash ----------

/**
 * @typedef {{ floor: string, tag: string, group: string | null }} Filters `group`: the tag the jobs are grouped by, '' for
 *   none; null when the hash says nothing, which groups by `mission` while the lab runs.
 */
const filtersOf = () => {
  const q = new URLSearchParams(location.hash.slice(1))
  return /** @type {Filters} */ ({ floor: q.get('floor') ?? '', tag: q.get('tag') ?? '', group: q.get('group') })
}
const setFilters = (/** @type {Filters} */ f) => {
  const q = new URLSearchParams()
  if (f.floor) q.set('floor', f.floor)
  if (f.tag) q.set('tag', f.tag)
  if (f.group !== null) q.set('group', f.group)
  history.replaceState(null, '', q.size ? `#${q}` : location.pathname)
  // Other filters, other jobs: each section opens again at its first page.
  state.pages = {}
  draw()
}

/** Whether a job passes the filters: its floor, and a tag it carries (`name=value`, or a word any of its tags hold). */
const shown = (/** @type {Job} */ j, /** @type {Filters} */ f) => {
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
    .map(([k, u]) => `${u} ${u === 1 && k.endsWith('s') ? k.slice(0, -1) : k}`)
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

/**
 * A job's state as a word in a tone, and a line under it. The tones are the Lobby's: a running job is working (amber),
 * one past its hours needs a look (red), one that exited 0 is ready (green), a failed one broken, the rest quiet.
 */
const stateOf = (/** @type {Job} */ j, /** @type {Compute} */ c) => {
  if (j.status === 'queued') return { word: 'queued', tone: 'quiet', why: `waits for ${waitsFor(j, c)}` }
  if (j.status === 'running') return { word: j.overdue ? 'running long' : 'running', tone: j.overdue ? 'needs' : 'working', why: j.overdue ? `past the ${hoursWords(j.hours ?? 0)} it was given` : '' }
  if (j.status === 'withdrawn') return { word: 'withdrawn', tone: 'quiet', why: '' }
  const ok = /^exit 0\b/.test(j.outcome ?? '')
  const told = !j.told ? 'telling its requester' : j.told.failed !== undefined ? '' : j.told.resumed ? `${j.told.to} was resumed to be told` : j.told.to ? `${j.told.to} was told` : ''
  return { word: j.outcome ?? 'over', tone: ok ? 'ready' : 'broken', why: told }
}

/** The time column: how long it has waited, run, or took, and when; a running job's hours go on a line under it. */
const timeOf = (/** @type {Job} */ j) => {
  if (j.status === 'queued') return `waiting ${duration(Date.now() - j.queuedAt)}`
  if (j.status === 'running') return duration(Date.now() - (j.startedAt ?? Date.now()))
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
    <td class="time">${esc(timeOf(j))}${j.status === 'running' && j.hours !== undefined ? `<small>of ${esc(hoursWords(j.hours))}</small>` : ''}</td>
    <td class="needs-col">${esc(needsWords(j.needs))}</td>
    <td class="acts">${acts}</td>
  </tr>`
}

/**
 * The page of a section's jobs it shows, held in `state.pages` under `key` and kept within its pages as jobs come and
 * go: a page emptied by jobs ending shows the last one left.
 */
const pageOf = (/** @type {string} */ key, /** @type {number} */ total) => {
  const last = Math.max(0, Math.ceil(total / PAGE) - 1)
  const page = Math.min(state.pages[key] ?? 0, last)
  if (page) state.pages[key] = page
  else delete state.pages[key]
  return { page, last }
}

/** Under a section's table when its jobs run past a page: which of them it shows, and the way to the others. */
const pagerHtml = (/** @type {string} */ key, /** @type {number} */ page, /** @type {number} */ last, /** @type {number} */ total, /** @type {[string, string]} */ [back, on]) => {
  if (!last) return ''
  const first = page * PAGE + 1
  const to = Math.min(total, first + PAGE - 1)
  const button = (/** @type {number} */ p, /** @type {string} */ word, /** @type {string} */ tip) =>
    `<button type="button" class="act" data-page="${esc(key)}" data-to="${p}"${p < 0 || p > last ? ' disabled' : ` data-tip="${esc(tip)}"`}>${esc(word)}</button>`
  return `<nav class="pager" aria-label="${esc(`Pages of ${key}`)}">
    ${button(0, '«', 'The first page')}${button(page - 1, back, `${back}: the page before`)}
    <span class="pos">${first}–${to} of ${total}</span>
    ${button(page + 1, on, `${on}: the page after`)}${button(last, '»', 'The last page')}
  </nav>`
}

/**
 * A section of jobs, a page of them at a time (`PAGE`). `key` names it in `state.pages`; `turn` is the words for the
 * page before and the page after, as its order reads.
 */
const sectionHtml = (
  /** @type {string} */ key,
  /** @type {string} */ title,
  /** @type {Job[]} */ jobs,
  /** @type {Compute} */ c,
  /** @type {string} */ none,
  /** @type {[string, string]} */ turn = ['Earlier', 'Later'],
) => {
  const { page, last } = pageOf(key, jobs.length)
  const rows = jobs.slice(page * PAGE, (page + 1) * PAGE)
  return `
  <section data-section="${esc(key)}">
    <h2>${esc(title)}<span class="count">${jobs.length}</span></h2>
    ${
      jobs.length
        ? `<table class="jobs"><colgroup><col class="c-n"><col><col class="c-who"><col class="c-state"><col class="c-time"><col class="c-holds needs-col"><col class="c-acts"></colgroup><thead><tr><th>#</th><th>Job</th><th>Who</th><th>Where it stands</th><th>Time</th><th class="needs-col">Holds</th><th></th></tr></thead><tbody>${rows.map((j) => rowHtml(j, c)).join('')}</tbody></table>${pagerHtml(key, page, last, jobs.length, turn)}`
        : `<div class="jobs empty">${esc(none)}</div>`
    }
  </section>`
}

/**
 * The groups of the jobs by `tag` (groups.js): with the lab's missions on the floors the filter keeps when the tag is
 * `mission` and the lab runs, and the machine's use when it was read.
 */
const groupsNow = (/** @type {string} */ tag, /** @type {Job[]} */ jobs, /** @type {Filters} */ f) => {
  const missions = labRuns(state.board) && tag === 'mission' ? labMissions(state.board).filter((m) => !f.floor || m.project === f.floor) : undefined
  const machine = state.machine && !('failed' in state.machine) ? state.machine : undefined
  return { missions, machine, groups: groupsOf(jobs, tag, Date.now(), machine, missions) }
}

/** The "By <tag>" section, or the missions: a card per group (groupview.js). Pressing a card's name shows only its jobs. */
const groupsHtml = (/** @type {string} */ tag, /** @type {Job[]} */ jobs, /** @type {Compute} */ c, /** @type {Filters} */ f) => {
  const { missions, machine, groups } = groupsNow(tag, jobs, f)
  const none = missions ? 'No mission is open, and no job shown carries a mission.' : `No job shown carries ${tag}.`
  return groupsSection(missions ? 'Missions' : `By ${tag}`, tag, groups, c.resources, machine, none, missions ? 'lab' : '')
}

const draw = () => {
  const board = state.board
  if (!board) return
  $('usage').innerHTML = usageHtml(board, board.x?.compute ? state.machine : { failed: 'Compute isn’t running: nothing reads the machine.' })
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
  const lab = labRuns(board)
  const group = groupTag(f, lab)
  const names = [...new Set([...(lab ? ['mission'] : []), ...tagNames(c.jobs), ...(group ? [group] : [])])]
  $('group').innerHTML = [`<option value=""${group ? '' : ' selected'}>Nothing</option>`, ...names.map((k) => `<option value="${esc(k)}"${k === group ? ' selected' : ''}>${esc(lab && k === 'mission' ? 'mission · lab' : k)}</option>`)].join('')
  $('meter').innerHTML = meterHtml(c)
  const jobs = c.jobs.filter((j) => shown(j, f))
  const listed = jobs.filter((j) => j.told?.failed !== undefined && j.seenAt === undefined)
  const over = jobs.filter((j) => (j.status === 'over' || j.status === 'withdrawn') && !listed.includes(j)).reverse()
  $('main').innerHTML = [
    listed.length ? sectionHtml('listed', 'On your list', listed, c, '') : '',
    group ? groupsHtml(group, jobs, c, f) : '',
    sectionHtml('running', 'Running', jobs.filter((j) => j.status === 'running'), c, 'Nothing runs.'),
    sectionHtml('queued', 'Queued', jobs.filter((j) => j.status === 'queued'), c, 'Nothing waits.'),
    // Newest first: its first page is what just ended.
    sectionHtml('over', 'Over in the last day', over, c, 'Nothing ended in the last day.', ['Newer', 'Older']),
  ].join('')
}

// ---------- a job's screen ----------

/**
 * A cell of `font`, in px, measured as the tower's `fitSize` measures one (src/shared/terminal.ts): the W's advance,
 * and the face's ascent and descent rounded to whole device pixels.
 */
const cellOf = (/** @type {{ family: string, size: number }} */ { family, size }) => {
  const text = /** @type {OffscreenCanvasRenderingContext2D} */ (new OffscreenCanvas(1, 1).getContext('2d'))
  text.font = `${size}px ${family}`
  const w = text.measureText('W')
  return { width: w.width, height: Math.ceil((w.fontBoundingBoxAscent + w.fontBoundingBoxDescent) * devicePixelRatio) / devicePixelRatio }
}

/**
 * A job's PTY has its own size (the jobs daemon's 120×40), and nobody can resize it: a view that only watches would draw
 * it at the largest font at which all its cells fit the box, in a card a third of the page high the smallest font there
 * is. So the job is drawn as the tower page draws a terminal it holds: at the viewer's font, the PTY's columns wide and
 * as many rows high as the card holds, xterm's own scrollback taking the lines above them, its one scrollbar reaching
 * all of the output. A job takes no input and writes lines, which scroll the same in fewer rows; a program that moves
 * its cursor about the PTY's 40 rows would draw out of place.
 */
const openScreen = async (/** @type {number} */ n) => {
  /** @type {Job | undefined} */
  const j = state.board?.x?.compute?.jobs.find((/** @type {Job} */ x) => x.n === n)
  if (!j?.job) return
  state.screen?.close()
  $('screen').hidden = false
  $('screen-title').textContent = `#${j.n} ${j.label} · ${j.job}`
  const well = $('screen-term')
  well.innerHTML = ''
  const host = document.createElement('div')
  host.className = 'screen-cells'
  well.append(host)
  const font = () => terminalFont(tower.prefs.get())
  await loadTerminalFont(font())
  const xterm = { Terminal: /** @type {any} */ (window).Terminal, FitAddon: /** @type {any} */ (window).FitAddon.FitAddon }
  const id = j.job
  /** The PTY's size, once the stream says it. */
  let pty = { cols: 0, rows: 0 }
  /** How many rows the well holds at the viewer's font, at most the PTY's. */
  const rowsHeld = (/** @type {number} */ ptyRows) => {
    const pad = parseFloat(getComputedStyle(well).paddingTop) + parseFloat(getComputedStyle(well).paddingBottom)
    return Math.max(1, Math.min(ptyRows, Math.floor((well.clientHeight - pad) / cellOf(font()).height)))
  }
  /** The view's size: the PTY's columns, the well's rows; its box set to it at the viewer's font before it draws. */
  const size = (/** @type {{ cols: number, rows: number }} */ { cols, rows }) => {
    pty = { cols, rows }
    const held = rowsHeld(rows)
    const cell = cellOf(font())
    host.style.width = `${Math.ceil(cols * cell.width)}px`
    host.style.height = `${Math.ceil(held * cell.height)}px`
    return { cols, rows: held }
  }
  /**
   * The terminal's ground is the card's graphite (`--term-bg`), not the core's enamel: the library takes only a scheme,
   * so its theme is xterm's own option, set as each snapshot opens a terminal.
   */
  const ground = () => {
    const term = handle.term()
    if (!term) return
    const bg = getComputedStyle(well).getPropertyValue('--term-bg').trim()
    term.options.theme = { ...term.options.theme, background: bg, cursorAccent: bg }
  }
  /** @type {(msg: any) => void} */
  let feed = () => {}
  const handle = mountTermView(host, xterm, {
    watch: (on) => {
      feed = on
      return tower.watch(`job/${id}/screen`, (/** @type {any} */ msg) => {
        if (msg.t === 'snapshot') return on({ ...msg, ...size(msg), terminals: 1 }), ground()
        if (msg.t === 'r') return on({ t: 'r', ...size(msg) })
        if (msg.t === 'x') return on({ t: 'x', exitCode: msg.exit ?? 1 })
        if (msg.t === 'error') return toast(`The tower no longer keeps that job's screen: ${msg.message ?? ''}`)
        on(msg)
      })
    },
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
  /** The window grows or shrinks the card: the view takes the rows it now holds. */
  const seen = new ResizeObserver(() => {
    const term = handle.term()
    if (!term || !pty.cols) return
    const next = size(pty)
    if (next.rows !== term.rows) feed({ t: 'r', ...next })
  })
  seen.observe(well)
  state.screen = { n, close: () => (seen.disconnect(), handle.close()) }
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
  const { cancel, seen, screen, tag, page, to } = button.dataset
  if (cancel) void act(/** @type {HTMLButtonElement} */ (button), 'compute/cancel', Number(cancel))
  if (seen) void act(/** @type {HTMLButtonElement} */ (button), 'compute/seen', Number(seen))
  if (screen) void openScreen(Number(screen))
  if (tag) setFilters({ ...filtersOf(), tag })
  if (page) turnPage(page, Number(to))
})

/** Shows another page of a section, its head kept in sight when the page was scrolled past it. */
const turnPage = (/** @type {string} */ key, /** @type {number} */ page) => {
  state.pages[key] = page
  draw()
  const section = /** @type {HTMLElement | null} */ ($('main').querySelector(`section[data-section="${CSS.escape(key)}"]`))
  if (section && section.getBoundingClientRect().top < $('main').getBoundingClientRect().top) section.scrollIntoView({ block: 'start' })
}
$('screen-close').addEventListener('click', closeScreen)
$('group').addEventListener('change', (e) => setFilters({ ...filtersOf(), group: /** @type {HTMLSelectElement} */ (e.target).value }))
$('floor').addEventListener('change', (e) => setFilters({ ...filtersOf(), floor: /** @type {HTMLSelectElement} */ (e.target).value }))
$('tag').addEventListener('input', (e) => setFilters({ ...filtersOf(), tag: /** @type {HTMLInputElement} */ (e.target).value }))
window.addEventListener('hashchange', draw)

// ---------- which version runs ----------

/**
 * Compute's version at the page's foot, as the tower loaded it (the board's `extensions`), with the tower's: the
 * extension's server and this page ship together, from one release. Pressing it copies one line for a bug report.
 */
const versionSaid = (/** @type {any} */ board) => {
  const e = board.extensions.find((/** @type {{ id: string }} */ x) => x.id === 'compute')
  const name = e ? `Compute ${e.version}${e.state === 'started' ? '' : ` (${e.state})`}` : 'Compute (not loaded)'
  return { name, said: `${name} on the tower ${tower.served.version ?? 'of unknown version'}` }
}
const drawVersion = () => {
  const { name, said } = versionSaid(state.board)
  const button = $('version')
  button.textContent = name
  if (button.dataset.tip !== 'copied') button.dataset.tip = `${said}. Press to copy it`
}
$('version').addEventListener('click', () => {
  const button = $('version')
  const { said } = versionSaid(state.board)
  copyText(said).then(() => (button.dataset.tip = 'copied'), (/** @type {Error} */ err) => (button.dataset.tip = err.message))
  setTimeout(() => (button.dataset.tip = `${said}. Press to copy it`), 1400)
})

// The way back to the tower, with the tower's own icon for it.
$('back').insertAdjacentHTML('afterbegin', ICON.back)
watchTips(document)
tower.onBoardError((err) => ($('main').innerHTML = `<p class="note broken">${esc(err.message)}</p>`))
tower.subscribe((board) => {
  state.board = board
  draw()
  drawVersion()
})
// Elapsed times move between boards.
setInterval(draw, 30_000)

/** The machine and who uses it, compute's read: it isn't on the board, so the page reads it every 10 s while in sight. */
const readMachine = async () => {
  if (document.hidden || !state.board?.x?.compute) return
  try {
    state.machine = /** @type {import('./usage.js').Machine} */ (/** @type {unknown} */ (await tower.get(/** @type {any} */ ('compute/machine'))))
  } catch (err) {
    state.machine = { failed: `The machine can't be read: ${/** @type {Error} */ (err).message}` }
  }
  // Each group's CPU at this read, for its sparkline: every job of the queue, whatever the page filters.
  const f = filtersOf()
  const tag = groupTag(f, labRuns(state.board))
  if (tag && !('failed' in state.machine)) recordReadings(tag, groupsNow(tag, state.board.x.compute.jobs, { ...f, tag: '' }).groups, state.machine.at)
  draw()
}
setInterval(readMachine, 10_000)
document.addEventListener('visibilitychange', () => void readMachine())
tower.subscribe(() => {
  if (state.machine === undefined) void readMachine()
})
