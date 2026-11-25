// model/browser-plan/reach.mjs: checks R7 ("from every reachable state a settled state can be reached")
// on the checker's state graph. A reachability rule is not a state formula, so the checker cannot test it
// as an INVARIANT. Node built-ins only; `check` runs it.
//
//   node reach.mjs <the checker's `-dump dot,actionlabels` output> <rule name>
//
// Settled (the same predicate as PlanLife.tla's, StepsLife.tla's and FramesLife.tla's `Settled`): every app
// idle (or gone), no execution claimed / running / permitted / unknown (no run waiting / open / locked), every
// lock (FramesLife: the run's in-flight slot) free. Exit 0 when the rule
// holds. Exit 1 when it does not, printing the unsettleable state nearest to the start and the actions that lead there. Exit 2 when the graph cannot
// be read (a checker or dump format change must not pass silently).
import { readFileSync } from 'node:fs'

const [dotPath, rule] = process.argv.slice(2)
if (!dotPath || !rule) {
  console.error('usage: node reach.mjs <state graph> <rule>')
  process.exit(2)
}

const unescape = s => s.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
const label = new Map()
const initial = []
const out = new Map()
const into = new Map()
for (const line of readFileSync(dotPath, 'utf8').split('\n')) {
  let m = line.match(/^(-?\d+) -> (-?\d+) \[label="((?:[^"\\]|\\.)*)"/)
  if (m) {
    if (!out.has(m[1])) out.set(m[1], [])
    out.get(m[1]).push({ to: m[2], action: unescape(m[3]) })
    if (!into.has(m[2])) into.set(m[2], [])
    into.get(m[2]).push(m[1])
    continue
  }
  m = line.match(/^(-?\d+) \[label="((?:[^"\\]|\\.)*)"/)
  if (m) {
    label.set(m[1], unescape(m[2]))
    if (/style = filled\]$/.test(line)) initial.push(m[1])
  }
}
if (initial.length === 0 || label.size === 0) {
  console.error(`FAIL ${rule}: cannot read the state graph (no initial state or no state lines)`)
  process.exit(2)
}

const value = (text, name) => {
  const m = text.match(new RegExp(`^/\\\\ ${name} = (.*)$`, 'm'))
  if (!m) {
    console.error(`FAIL ${rule}: a state has no variable ${name} (did the model rename it?)`)
    process.exit(2)
  }
  return m[1]
}
// One predicate for every model, written as "only these words": PlanLife's and FramesLife's `lock` is one
// value, StepsLife's a function from lock keys (unquoted) to a plan or "none" — every quoted value in it must
// be "none"; every app's phase must be "idle" (or "gone"); every execution not started or final (the models'
// final words together — FramesLife's run: "ended"; a new open state is never settled by mistake).
const FINAL = ['none', 'succeeded', 'failed', 'cdone', 'cnotdone', 'void', 'partial', 'confirmed', 'ended']
const only = (text, words) => {
  const quoted = text.match(/"[^"]*"/g) ?? []
  return quoted.length > 0 && quoted.every(q => words.includes(q.slice(1, -1)))
}
const settled = id => {
  const t = label.get(id)
  return only(value(t, 'ph'), ['idle', 'gone'])
    && only(value(t, 'exSt'), FINAL)
    && only(value(t, 'lock'), ['none'])
}

// Walk backwards from the settled states.
const good = new Set()
const queue = []
for (const id of label.keys()) if (settled(id)) { good.add(id); queue.push(id) }
if (good.size === 0) {
  console.error(`FAIL ${rule}: no settled state at all (the initial state is settled; is the predicate stale?)`)
  process.exit(2)
}
while (queue.length) {
  const id = queue.pop()
  for (const from of into.get(id) ?? []) if (!good.has(from)) { good.add(from); queue.push(from) }
}

// Breadth-first from the start: the first state that cannot reach settled is the nearest one.
const prev = new Map()
const seen = new Set(initial)
const order = [...initial]
for (let i = 0; i < order.length; i++) {
  const id = order[i]
  if (!good.has(id)) {
    const steps = []
    for (let at = id; prev.has(at); at = prev.get(at).from) steps.unshift(prev.get(at).action)
    console.log(`FAIL ${rule}: a reachable state cannot reach a settled state`)
    console.log(`     actions: ${steps.join(' -> ') || '(the initial state)'}`)
    console.log(label.get(id).split('\n').map(l => `     | ${l}`).join('\n'))
    process.exit(1)
  }
  for (const { to, action } of out.get(id) ?? []) {
    if (seen.has(to)) continue
    seen.add(to)
    prev.set(to, { from: id, action })
    order.push(to)
  }
}
console.log(`ok   ${rule}: every one of the ${order.length} reachable states can reach a settled state`)
