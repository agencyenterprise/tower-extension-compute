import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupTag, groupsOf, labMissions, labRuns, tagNames } from '../renderer/groups.js'

const MIN = 60_000
type J = Parameters<typeof groupsOf>[0][number]
const job = (n: number, over: Partial<J> = {}): J => ({ n, tags: {}, caps: {}, needs: { lanes: 1 }, project: 'research', status: 'queued', ...over })
const use = (cpu: number, rss: number, procs = 1) => ({ cpu, rss, procs })

test('tag names come the most carried first', () => {
  const jobs = [job(1, { tags: { mission: 'a', claim: '1' } }), job(2, { tags: { mission: 'b' } }), job(3, { tags: { size: 'big' } })]
  assert.deepEqual(tagNames(jobs), ['mission', 'claim', 'size'])
})

test('jobs group by their value of a tag: counts, units held, cap and time run', () => {
  const now = 100 * MIN
  const jobs = [
    job(1, { tags: { mission: 'a' }, caps: { mission: 2 }, status: 'running', needs: { lanes: 2 }, startedAt: 70 * MIN }),
    job(2, { tags: { mission: 'a' }, caps: { mission: 2 }, status: 'over', startedAt: 10 * MIN, endedAt: 40 * MIN }),
    job(3, { tags: { mission: 'a' }, status: 'queued' }),
    job(4, { tags: { mission: 'b' }, status: 'withdrawn' }),
    job(5, { tags: {} , status: 'running', startedAt: 0 }),
  ]
  const [a, b, ...rest] = groupsOf(jobs, 'mission', now, undefined, undefined)
  assert.equal(rest.length, 0, 'a job without the tag is in no group')
  assert.deepEqual({ ...a, jobs: undefined, items: a.items.map((j) => j.n) }, { value: 'a', running: 1, queued: 1, over: 1, holds: { lanes: 2 }, cap: 2, ranMs: 60 * MIN, jobs: undefined, items: [1, 2, 3] })
  assert.equal(b.value, 'b')
  assert.equal(b.over, 1)
  assert.equal(b.ranMs, 0, 'a withdrawn job never ran')
})

test("the machine read adds each group's jobs' CPU and memory", () => {
  const jobs = [job(1, { tags: { mission: 'a' }, status: 'running', startedAt: 0 }), job(2, { tags: { mission: 'a' }, status: 'running', startedAt: 0 })]
  const machine = { use: { workers: [], jobs: [{ n: 1, ...use(150, 1e9) }, { n: 2, ...use(50, 2e9, 3) }, { n: 9, ...use(999, 9e9) }] } }
  const [a] = groupsOf(jobs, 'mission', 0, machine, undefined)
  assert.deepEqual(a.jobs, use(200, 3e9, 4))
  assert.equal(a.crew, undefined, 'without the lab, a group has no crew')
})

const board = {
  extensions: [{ id: 'compute', state: 'started' }, { id: 'lab', state: 'started' }],
  floors: [
    {
      id: 'research',
      name: 'Research',
      x: {
        lab: {
          missions: [
            { id: 'm-open', title: 'Open one', playbook: 'research', coordinator: 'BOSS-01', phase: 'explore', members: [{ callsign: 'BOSS-01' }, { callsign: 'VERA-02' }] },
            { id: 'm-closed', title: 'Closed one', playbook: 'research', coordinator: 'BOSS-03', phase: 'done', closedAt: 5, members: [] },
            { id: 'm-closed-jobs', title: 'Closed with jobs', playbook: 'research', coordinator: 'BOSS-04', phase: 'done', closedAt: 5, members: [] },
          ],
        },
      },
    },
    { id: 'other', name: 'Other', x: {} },
  ],
}

test('the lab runs only when the board says it started', () => {
  assert.equal(labRuns(board), true)
  assert.equal(labRuns({ extensions: [{ id: 'lab', state: 'failed' }] }), false)
  assert.equal(labRuns({ extensions: [] }), false)
})

test("a mission's group holds its crew's processes on its floor, and an open mission shows with no job", () => {
  const missions = labMissions(board)
  assert.deepEqual(missions[0].crew, ['BOSS-01', 'VERA-02'])
  const machine = {
    use: {
      workers: [
        { session: 's1', callsign: 'BOSS-01', project: 'research', ...use(40, 1e9) },
        { session: 's2', callsign: 'VERA-02', project: 'research', ...use(60, 2e9) },
        { session: 's3', callsign: 'VERA-02', project: 'other', ...use(500, 5e9) },
        { session: 's4', project: 'research', ...use(500, 5e9) },
      ],
      jobs: [{ n: 1, ...use(100, 1e9) }],
    },
  }
  const jobs = [job(1, { tags: { mission: 'm-closed-jobs' }, status: 'over', startedAt: 0, endedAt: MIN }), job(2, { tags: { mission: 'm-gone' }, status: 'running', startedAt: 0 })]
  const groups = groupsOf(jobs, 'mission', MIN, machine, missions)
  assert.deepEqual(groups.map((g) => g.value), ['m-open', 'm-gone', 'm-closed-jobs'], 'live first, then by CPU; a closed mission without jobs is left out')
  const open = groups[0]
  assert.equal(open.mission?.title, 'Open one')
  assert.deepEqual(open.crew, use(100, 3e9, 2), 'its crew on its own floor, by callsign')
  assert.deepEqual(open.members?.map((w) => w.callsign), ['VERA-02', 'BOSS-01'], 'its crew heaviest first')
  assert.equal(groups[1].mission, undefined, 'a mission the lab no longer lists is a plain group')
  assert.equal(groups[2].mission?.closed, true)
})

test('missions join only when grouping by mission', () => {
  const groups = groupsOf([job(1, { tags: { claim: '3' } })], 'claim', 0, undefined, labMissions(board))
  assert.deepEqual(groups.map((g) => g.value), ['3'])
})

test('the page groups by mission while the lab runs, and by nothing without it, until told otherwise', () => {
  assert.equal(groupTag({ group: null }, true), 'mission')
  assert.equal(groupTag({ group: null }, false), '', 'no lab: no section')
  assert.equal(groupTag({ group: '' }, true), '', 'Nothing, chosen, holds with the lab')
  assert.equal(groupTag({ group: 'size' }, false), 'size')
})
