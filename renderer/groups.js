/**
 * The jobs grouped by one tag, and what each group holds and uses: the Compute page's "By <tag>" section. Compute gives
 * tags no meaning, so this is plain arithmetic over the jobs the page shows. When the lab runs, its missions join in by
 * the `mission` tag it puts on their jobs: each mission's title, floor and crew, and the crew's own processes counted
 * with the mission's jobs, so a group says what the whole mission uses, the agents with their runs.
 *
 * Nothing here reaches the page or the tower: it is imported by the page and by the tests alike.
 */

/**
 * @typedef {{ cpu: number, rss: number, procs: number }} Use
 * @typedef {{ n: number, tags: Record<string, string>, caps: Record<string, number>, needs: Record<string, number>, project: string,
 *   status: string, startedAt?: number, endedAt?: number, label?: string, outcome?: string, overdue?: true }} GroupJob
 * @typedef {Use & { session: string, callsign?: string, project?: string }} WorkerUse
 * @typedef {{ use: { workers: WorkerUse[], jobs: (Use & { n: number })[] } }} GroupMachine
 * @typedef {{ name: string, at?: number }} Phase
 * @typedef {{ id: string, title: string, playbook: string, coordinator: string, phase: string, phases?: Phase[], closedAt?: number,
 *   members: { callsign: string, left?: true }[] }} LabMission
 * @typedef {{ id: string, title: string, playbook: string, coordinator: string, phase: string, phases: Phase[], closed: boolean,
 *   project: string, floorName: string, crew: string[] }} Mission
 * @typedef {{ value: string, running: number, queued: number, over: number, holds: Record<string, number>, cap?: number,
 *   ranMs: number, items: GroupJob[], jobs: Use, crew?: Use, members?: WorkerUse[], mission?: Mission }} Group
 *   `items`: its jobs, oldest first; `members`: its crew's workers with their use, heaviest first.
 */

const ZERO = () => ({ cpu: 0, rss: 0, procs: 0 })
const add = (/** @type {Use} */ a, /** @type {Use} */ b) => ({ cpu: a.cpu + b.cpu, rss: a.rss + b.rss, procs: a.procs + b.procs })

/** Every tag name the jobs carry, the most carried first. */
export const tagNames = (/** @type {GroupJob[]} */ jobs) => {
  /** @type {Map<string, number>} */
  const n = new Map()
  for (const j of jobs) for (const k of Object.keys(j.tags)) n.set(k, (n.get(k) ?? 0) + 1)
  return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k)
}

/** Whether the lab runs on this tower, as the board's `extensions` says. */
export const labRuns = (/** @type {any} */ board) =>
  (board.extensions ?? []).some((/** @type {{ id: string, state?: string }} */ e) => e.id === 'lab' && e.state === 'started')

/**
 * The tag the jobs are grouped by: the page's choice (`group` in its hash, '' for none), else `mission` while the lab
 * runs, else none, so a tower without the lab shows no group at all until asked.
 */
export const groupTag = (/** @type {{ group: string | null }} */ f, /** @type {boolean} */ lab) => f.group ?? (lab ? 'mission' : '')

/** The lab's missions on every floor, from each floor's `x.lab`, with their floor and their crew's callsigns. */
export const labMissions = (/** @type {any} */ board) =>
  /** @type {Mission[]} */ (
    (board.floors ?? []).flatMap((/** @type {{ id: string, name: string, x?: any }} */ f) =>
      (f.x?.lab?.missions ?? []).map((/** @type {LabMission} */ m) => ({
        id: m.id,
        title: m.title,
        playbook: m.playbook,
        coordinator: m.coordinator,
        phase: m.phase,
        phases: m.phases ?? [],
        closed: m.closedAt !== undefined,
        project: f.id,
        floorName: f.name,
        crew: [...new Set([m.coordinator, ...(m.members ?? []).map((x) => x.callsign)])],
      })),
    )
  )

/**
 * The jobs grouped by their value of `tag`, the busiest first: each group's jobs running, queued and over, the units
 * its running jobs hold, the cap its jobs carry on the tag, how long its jobs have run (the running ones until `now`),
 * and, given the machine read, its jobs' CPU and memory now. Jobs without the tag are left out.
 *
 * `missions`, when the lab runs and `tag` is `mission`: each open mission is a group even with no job shown (its crew
 * works), each group of a mission's id carries the mission, and its crew's processes (the machine's workers of its
 * floor by callsign) count as `crew`. A closed mission shows only while jobs of it do.
 */
export const groupsOf = (
  /** @type {GroupJob[]} */ jobs,
  /** @type {string} */ tag,
  /** @type {number} */ now,
  /** @type {GroupMachine | undefined} */ machine,
  /** @type {Mission[] | undefined} */ missions,
) => {
  /** @type {Map<string, Group>} */
  const groups = new Map()
  const groupOf = (/** @type {string} */ value) => {
    let g = groups.get(value)
    if (!g) groups.set(value, (g = { value, running: 0, queued: 0, over: 0, holds: {}, ranMs: 0, items: [], jobs: ZERO() }))
    return g
  }
  const jobUse = new Map((machine?.use.jobs ?? []).map((u) => [u.n, u]))
  for (const j of jobs) {
    const value = j.tags[tag]
    if (value === undefined) continue
    const g = groupOf(value)
    g.items.push(j)
    if (j.status === 'running') {
      g.running++
      for (const [k, u] of Object.entries(j.needs)) g.holds[k] = (g.holds[k] ?? 0) + u
    } else if (j.status === 'queued') g.queued++
    else g.over++
    if (j.caps[tag] !== undefined) g.cap = Math.max(g.cap ?? 0, j.caps[tag])
    if (j.startedAt !== undefined && (j.status === 'running' || j.endedAt !== undefined)) g.ranMs += (j.endedAt ?? now) - j.startedAt
    const u = jobUse.get(j.n)
    if (u) g.jobs = add(g.jobs, u)
  }
  if (missions && tag === 'mission') {
    for (const m of missions) {
      if (m.closed && !groups.has(m.id)) continue
      const g = groupOf(m.id)
      g.mission = m
      g.members = (machine?.use.workers ?? []).filter((w) => w.project === m.project && w.callsign !== undefined && m.crew.includes(w.callsign)).sort((a, b) => b.cpu - a.cpu || b.rss - a.rss)
      g.crew = g.members.reduce(add, ZERO())
    }
  }
  const live = (/** @type {Group} */ g) => g.running + g.queued + (g.mission && !g.mission.closed ? 1 : 0)
  const cpu = (/** @type {Group} */ g) => g.jobs.cpu + (g.crew?.cpu ?? 0)
  return [...groups.values()].sort((a, b) => Number(live(b) > 0) - Number(live(a) > 0) || cpu(b) - cpu(a) || b.running - a.running || b.ranMs - a.ranMs || a.value.localeCompare(b.value))
}
