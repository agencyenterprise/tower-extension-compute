import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DAY_MS,
  count,
  entriesOf,
  jobLine,
  listed,
  listTitle,
  recent,
  resumeText,
  nextStarts,
  outcomeOf,
  pairsOf,
  tellText,
  unrunnable,
  untold,
  usedOf,
  viewsOf,
  type BoardJob,
  type QueueFact,
  type QueuedFact,
} from '../compute.ts'

const MIN = 60_000
const job = (over: Partial<QueuedFact> = {}): QueuedFact => ({
  argv: ['sleep', '60'],
  cwd: '/tmp',
  label: 'a run',
  project: 'lab-research',
  needs: { lanes: 1 },
  tags: {},
  caps: {},
  by: 's-1',
  callsign: 'BRUNO-01',
  ...over,
})
const views = (facts: QueueFact[], jobs: BoardJob[] = [], now = 10 * MIN, jobsUp = true) => viewsOf(entriesOf(facts), jobs, jobsUp, now)
const lanes = { lanes: 4 }

test('jobs are numbered from 1 in the order they were queued', () => {
  const e = entriesOf([[1, 'j', job({ label: 'a' })], [2, 'j', job({ label: 'b' })], [3, 'o', { n: 2, job: 'job-b' }]])
  assert.deepEqual(
    e.map((x) => [x.n, x.label, x.job]),
    [
      [1, 'a', undefined],
      [2, 'b', 'job-b'],
    ],
  )
})

test('the oldest jobs that fit start first, and a big one is passed by smaller ones behind it', () => {
  const facts: QueueFact[] = [
    [1, 'j', job({ needs: { lanes: 3 } })],
    [2, 'j', job({ needs: { lanes: 2 } })],
    [3, 'j', job({ needs: { lanes: 1 } })],
  ]
  assert.deepEqual(nextStarts(views(facts), lanes), [1, 3])
})

test('running jobs hold their units until they end', () => {
  const facts: QueueFact[] = [
    [1, 'j', job({ needs: { lanes: 3 } })],
    [2, 'o', { n: 1, job: 'job-1' }],
    [3, 'j', job({ needs: { lanes: 2 } })],
  ]
  const running: BoardJob[] = [{ id: 'job-1', state: 'running', startedAt: 2 }]
  assert.deepEqual(usedOf(views(facts, running)), { lanes: 3 })
  assert.deepEqual(nextStarts(views(facts, running), lanes), [])
  const ended: BoardJob[] = [{ id: 'job-1', state: 'ended', startedAt: 2, endedAt: 5 * MIN, exit: 0 }]
  assert.deepEqual(nextStarts(views(facts, ended), lanes), [2])
})

test('a cap keeps a tag value to its number of running jobs', () => {
  const tagged = (m: string) => job({ tags: { mission: m }, caps: { mission: 1 } })
  const facts: QueueFact[] = [
    [1, 'j', tagged('a')],
    [2, 'j', tagged('a')],
    [3, 'j', tagged('b')],
  ]
  assert.deepEqual(nextStarts(views(facts), lanes), [1, 3])
})

test('a job just started and not yet on the board still runs; one gone after a day is over', () => {
  const facts: QueueFact[] = [
    [1, 'j', job()],
    [MIN, 'o', { n: 1, job: 'job-1' }],
  ]
  assert.equal(views(facts, [], 2 * MIN)[0].status, 'running')
  assert.equal(views(facts, [], 2 * DAY_MS)[0].status, 'over')
})

test('while the jobs daemon is down, a lost job is not taken for over', () => {
  const facts: QueueFact[] = [
    [1, 'j', job()],
    [2, 'o', { n: 1, job: 'job-1' }],
  ]
  const lost: BoardJob[] = [{ id: 'job-1', state: 'lost', startedAt: 2 }]
  assert.equal(views(facts, lost, 3, false)[0].status, 'running')
  assert.equal(views(facts, lost, 3, true)[0].status, 'over')
})

test('an over job is told once', () => {
  const facts: QueueFact[] = [
    [1, 'j', job()],
    [2, 'o', { n: 1, job: 'job-1' }],
  ]
  const ended: BoardJob[] = [{ id: 'job-1', state: 'ended', startedAt: 2, endedAt: 2 + 90 * MIN, exit: 0 }]
  const [over] = untold(views(facts, ended))
  assert.equal(over.outcome, 'exit 0 after 1 h 30 min')
  assert.match(tellText(over), /^\[compute\] Your job #1 \(a run\) is over: exit 0 after 1 h 30 min\./)
  const told: QueueFact[] = [...facts, [3, 'y', { n: 1, outcome: over.outcome!, to: 'BRUNO-01' }]]
  assert.deepEqual(untold(views(told, ended)), [])
})

test('a job the jobs daemon refused is over, and its requester is told why', () => {
  const facts: QueueFact[] = [
    [1, 'j', job({ argv: ['nope'] })],
    [2, 'f', { n: 1, reason: 'no such program: nope' }],
  ]
  const [over] = untold(views(facts))
  assert.equal(over.outcome, 'could not start: no such program: nope')
  assert.match(tellText(over), /Read what went wrong/)
})

test('a withdrawn job neither starts nor is told', () => {
  const facts: QueueFact[] = [
    [1, 'j', job()],
    [2, 'q', { n: 1, by: 'user' }],
  ]
  assert.deepEqual(nextStarts(views(facts), lanes), [])
  assert.deepEqual(untold(views(facts)), [])
})

test('outcomes say how a job ended', () => {
  assert.equal(outcomeOf({ id: 'j', state: 'ended', startedAt: 0, endedAt: 40_000, exit: 2 }), 'exit 2 after 40 s')
  assert.equal(outcomeOf({ id: 'j', state: 'ended', startedAt: 0, endedAt: 60_000, exit: null, signal: 'SIGKILL' }), 'ended by SIGKILL after 1 min')
  assert.equal(outcomeOf({ id: 'j', state: 'cancelled', startedAt: 0, endedAt: 60_000, exit: null, signal: 'SIGTERM' }), 'cancelled after 1 min')
  assert.match(outcomeOf({ id: 'j', state: 'lost', startedAt: 0 }), /^lost/)
})

test('name=value words parse, and a bad one is named', () => {
  assert.deepEqual(pairsOf(['lanes=2', 'gpu=1'], 'need', count), { lanes: 2, gpu: 1 })
  assert.match(pairsOf(['lanes=0'], 'need', count) as string, /need "lanes=0"/)
  assert.match(pairsOf(['Mission=x'], 'tag', (v) => v) as string, /tag "Mission=x"/)
})

test('a job that could never start is refused up front', () => {
  assert.match(unrunnable({ needs: { gpu: 1 }, tags: {}, caps: {} }, lanes)!, /gpu, which the machine's resources don't name/)
  assert.match(unrunnable({ needs: { lanes: 5 }, tags: {}, caps: {} }, lanes)!, /needs 5 lanes and the machine has 4/)
  assert.match(unrunnable({ needs: { lanes: 1 }, tags: {}, caps: { mission: 2 } }, lanes)!, /carries no mission tag/)
  assert.equal(unrunnable({ needs: { lanes: 4 }, tags: { mission: 'a' }, caps: { mission: 2 } }, lanes), undefined)
})

test('a queued job says what it waits for', () => {
  const facts: QueueFact[] = [
    [1, 'j', job({ needs: { lanes: 4 } })],
    [2, 'o', { n: 1, job: 'job-1' }],
    [3, 'j', job({ label: 'second', needs: { lanes: 2 } })],
  ]
  const v = views(facts, [{ id: 'job-1', state: 'running', startedAt: 2 }])
  assert.match(jobLine(v[1], v, lanes, 10 * MIN), /^#2 queued, waits for 2 lanes \(0 of 4 free\) · second/)
  assert.match(jobLine(v[0], v, lanes, 10 * MIN), /^#1 running 10 min \(job-1\)/)
})

test('a job whose requester could not be told is on the list until seen', () => {
  const facts: QueueFact[] = [
    [1, 'j', job({ tags: { mission: 'm1' } })],
    [2, 'o', { n: 1, job: 'job-1' }],
    [3, 'y', { n: 1, outcome: 'exit 1 after 3 min', to: 'BRUNO-01', failed: "BRUNO-01 can't be found on lab-research" }],
  ]
  const ended: BoardJob[] = [{ id: 'job-1', state: 'ended', startedAt: 2, endedAt: 3, exit: 1 }]
  const [onList] = listed(views(facts, ended))
  assert.equal(listTitle(onList), "Job #1 (a run) by BRUNO-01 is over: exit 1 after 3 min. Not told: BRUNO-01 can't be found on lab-research.")
  assert.match(jobLine(onList, views(facts, ended), lanes, 10 * MIN), /not told \(BRUNO-01 can't be found on lab-research\), on the list$|, on the list ·/)
  const seen: QueueFact[] = [...facts, [4, 's', { n: 1, by: 'user' }]]
  assert.deepEqual(listed(views(seen, ended)), [])
})

test('a resumed requester is told so, with the job and its tags', () => {
  const facts: QueueFact[] = [
    [1, 'j', job({ tags: { mission: 'm1' } })],
    [2, 'o', { n: 1, job: 'job-1' }],
  ]
  const [over] = untold(views(facts, [{ id: 'job-1', state: 'ended', startedAt: 2, endedAt: 2 + 5 * MIN, exit: 0 }]))
  const text = resumeText(over)
  assert.match(text, /^\[compute\] You were resumed because a job you queued is over and you weren't running to be told\. Your job #1 \(a run\) is over: exit 0 after 5 min\. Its tags: mission=m1\./)
  assert.match(text, /Check whether the work it was for still goes on/)
})

test('what is worth showing: live jobs, listed ones, and the last day of the rest', () => {
  const now = 3 * DAY_MS
  const facts: QueueFact[] = [
    [1, 'j', job({ label: 'old' })],
    [2, 'o', { n: 1, job: 'job-1' }],
    [3, 'y', { n: 1, outcome: 'exit 0 after 1 s' }],
    [4, 'j', job({ label: 'old, never told' })],
    [5, 'o', { n: 2, job: 'job-2' }],
    [6, 'y', { n: 2, outcome: 'exit 1 after 1 s', failed: 'it was queued from outside a worker' }],
    [now - MIN, 'j', job({ label: 'fresh' })],
  ]
  assert.deepEqual(
    recent(views(facts, [], now), now).map((v) => v.label),
    ['old, never told', 'fresh'],
  )
})
