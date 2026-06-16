/**
 * Unit tests for src/proxy-broker.ts — the per-session pending-call
 * registry used to coordinate proxy-mcp HTTP handlers with the language
 * model's stream lifecycle.
 *
 * Usage:
 *   bun test-broker.ts
 *   node --experimental-strip-types --test test-broker.ts
 */
import { test } from "node:test"
import assert from "node:assert/strict"

import {
  queuePendingProxyCall,
  getPendingProxyCalls,
  onPendingProxyCall,
  resolvePendingProxyCallById,
  rejectPendingProxyCallById,
  rejectAllPendingProxyCallsForSession,
  type PendingProxyCall,
} from "./src/proxy-broker.js"
import type { ProxyToolCall, ProxyToolResult } from "./src/proxy-mcp.js"

type CallHandle = {
  id: string
  promise: Promise<ProxyToolResult>
  resolved: boolean
  rejected: boolean
  call: ProxyToolCall
}

let callCounter = 0

function makeCall(toolName: string, input: Record<string, unknown> = {}): CallHandle {
  const id = `call-${++callCounter}`
  const state = {
    id,
    resolved: false,
    rejected: false,
  } as CallHandle
  state.promise = new Promise<ProxyToolResult>((resolve, reject) => {
    state.call = {
      id,
      toolName,
      input,
      resolve: (result) => {
        state.resolved = true
        resolve(result)
      },
      reject: (err) => {
        state.rejected = true
        reject(err)
      },
    }
  })
  // Swallow rejections so test runner doesn't crash on unawaited rejects.
  state.promise.catch(() => {})
  return state
}

test("queue + getPendingProxyCalls returns every queued call in order", () => {
  const sk = `sk-multi-${Date.now()}`
  const a = makeCall("bash", { command: "ls" })
  const b = makeCall("bash", { command: "pwd" })

  queuePendingProxyCall(sk, a.call)
  queuePendingProxyCall(sk, b.call)

  const pending = getPendingProxyCalls(sk)
  assert.equal(pending.length, 2)
  const ids = new Set(pending.map((p) => p.toolCallId))
  assert.ok(ids.has(a.id))
  assert.ok(ids.has(b.id))

  // Clean up
  rejectAllPendingProxyCallsForSession(sk, new Error("test cleanup"))
})

test("resolvePendingProxyCallById resolves only the matching call", async () => {
  const sk = `sk-resolve-${Date.now()}`
  const a = makeCall("bash")
  const b = makeCall("write")

  queuePendingProxyCall(sk, a.call)
  queuePendingProxyCall(sk, b.call)

  const ok = resolvePendingProxyCallById(a.id, { kind: "text", text: "a-result" })
  assert.equal(ok, true)

  const result = await a.promise
  assert.deepEqual(result, { kind: "text", text: "a-result" })

  // b should still be pending
  const remaining = getPendingProxyCalls(sk)
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0].toolCallId, b.id)
  assert.equal(b.resolved, false)
  assert.equal(b.rejected, false)

  // Clean up
  rejectAllPendingProxyCallsForSession(sk, new Error("test cleanup"))
})

test("rejectPendingProxyCallById rejects only the matching call", async () => {
  const sk = `sk-reject-${Date.now()}`
  const a = makeCall("bash")
  const b = makeCall("bash")

  queuePendingProxyCall(sk, a.call)
  queuePendingProxyCall(sk, b.call)

  const ok = rejectPendingProxyCallById(a.id, new Error("a-rejected"))
  assert.equal(ok, true)

  await assert.rejects(a.promise, /a-rejected/)
  assert.equal(getPendingProxyCalls(sk).length, 1)

  // Clean up
  rejectAllPendingProxyCallsForSession(sk, new Error("test cleanup"))
})

test("rejectAllPendingProxyCallsForSession rejects every pending call", async () => {
  const sk = `sk-reject-all-${Date.now()}`
  const a = makeCall("bash")
  const b = makeCall("bash")
  const c = makeCall("bash")

  queuePendingProxyCall(sk, a.call)
  queuePendingProxyCall(sk, b.call)
  queuePendingProxyCall(sk, c.call)

  const count = rejectAllPendingProxyCallsForSession(sk, new Error("session gone"))
  assert.equal(count, 3)
  assert.equal(getPendingProxyCalls(sk).length, 0)

  await assert.rejects(a.promise, /session gone/)
  await assert.rejects(b.promise, /session gone/)
  await assert.rejects(c.promise, /session gone/)
})

test("onPendingProxyCall fires once per queued call for the matching session", () => {
  const sk = `sk-onevent-${Date.now()}`
  const otherSk = `sk-other-${Date.now()}`
  const fired: PendingProxyCall[] = []
  const unsubscribe = onPendingProxyCall(sk, (call) => {
    fired.push(call)
  })

  const a = makeCall("bash")
  const b = makeCall("write")
  const c = makeCall("bash") // different session — should not fire

  queuePendingProxyCall(sk, a.call)
  queuePendingProxyCall(sk, b.call)
  queuePendingProxyCall(otherSk, c.call)

  assert.equal(fired.length, 2)
  const firedIds = new Set(fired.map((f) => f.toolCallId))
  assert.ok(firedIds.has(a.id))
  assert.ok(firedIds.has(b.id))
  assert.ok(!firedIds.has(c.id))

  unsubscribe()
  rejectAllPendingProxyCallsForSession(sk, new Error("test cleanup"))
  rejectAllPendingProxyCallsForSession(otherSk, new Error("test cleanup"))
})

test("getPendingProxyCalls is empty for unknown session", () => {
  assert.deepEqual(getPendingProxyCalls(`sk-empty-${Date.now()}`), [])
})

test("resolve / reject on already-resolved id is a no-op returning false", () => {
  const sk = `sk-double-${Date.now()}`
  const a = makeCall("bash")
  queuePendingProxyCall(sk, a.call)

  assert.equal(resolvePendingProxyCallById(a.id, { kind: "text", text: "ok" }), true)
  assert.equal(resolvePendingProxyCallById(a.id, { kind: "text", text: "again" }), false)
  assert.equal(rejectPendingProxyCallById(a.id, new Error("late")), false)
})

test("parallel queue from same session: index reflects every callId", () => {
  const sk = `sk-parallel-${Date.now()}`
  const calls = Array.from({ length: 5 }, () => makeCall("bash"))
  for (const c of calls) queuePendingProxyCall(sk, c.call)

  const pending = getPendingProxyCalls(sk)
  assert.equal(pending.length, 5)
  const ids = new Set(pending.map((p) => p.toolCallId))
  for (const c of calls) assert.ok(ids.has(c.id))

  // Resolve a couple, reject the rest
  resolvePendingProxyCallById(calls[0].id, { kind: "text", text: "0" })
  resolvePendingProxyCallById(calls[2].id, { kind: "text", text: "2" })
  const left = getPendingProxyCalls(sk)
  assert.equal(left.length, 3)

  rejectAllPendingProxyCallsForSession(sk, new Error("cleanup"))
  assert.equal(getPendingProxyCalls(sk).length, 0)
})

test("submit_plan pending rejects later proxy calls immediately", async () => {
  const sk = `sk-submit-plan-lock-${Date.now()}`
  const submitPlan = makeCall("submit_plan")
  const edit = makeCall("edit")

  queuePendingProxyCall(sk, submitPlan.call)
  const queuedEdit = queuePendingProxyCall(sk, edit.call)

  assert.equal(queuedEdit, null)
  await assert.rejects(edit.promise, /cannot run while interactive proxy tool 'submit_plan'/)

  const pending = getPendingProxyCalls(sk)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].toolCallId, submitPlan.id)

  rejectAllPendingProxyCallsForSession(sk, new Error("test cleanup"))
})

test("submit_plan is rejected when another proxy call is already pending", async () => {
  const sk = `sk-submit-plan-after-call-${Date.now()}`
  const bash = makeCall("bash")
  const submitPlan = makeCall("submit_plan")

  queuePendingProxyCall(sk, bash.call)
  const queuedSubmitPlan = queuePendingProxyCall(sk, submitPlan.call)

  assert.equal(queuedSubmitPlan, null)
  await assert.rejects(submitPlan.promise, /cannot run while 1 proxy call\(s\) are pending/)

  const pending = getPendingProxyCalls(sk)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].toolCallId, bash.id)

  rejectAllPendingProxyCallsForSession(sk, new Error("test cleanup"))
})
