import assert from "node:assert/strict"
import { test } from "node:test"
import { SUBAGENT_DISPATCH_HINT } from "./src/claude-code-language-model.js"
import {
  DEFAULT_PROXY_TOOLS,
  extractAgentTypeList,
  overlayTaskProxyDescription,
  TASK_PROXY_NOTE,
} from "./src/proxy-mcp.js"

// Regression guard for the 2026-07-04 "subagents only write todos" report:
// opencode's @-mention hint says "call the task tool with subagent: X", and
// models resolved that to Claude Code's native TaskCreate (a todo tool),
// created a todo, and narrated a dispatch that never happened. The system
// hint must name the exact proxy tool, the ToolSearch recovery path for
// deferred tools, and explicitly defuse the TaskCreate near-miss.
test("subagent dispatch hint names the tool and defuses TaskCreate", () => {
  assert.match(SUBAGENT_DISPATCH_HINT, /mcp__opencode_proxy__task/)
  assert.match(SUBAGENT_DISPATCH_HINT, /ToolSearch/)
  assert.match(SUBAGENT_DISPATCH_HINT, /select:mcp__opencode_proxy__task/)
  assert.match(SUBAGENT_DISPATCH_HINT, /TaskCreate/)
  assert.match(SUBAGENT_DISPATCH_HINT, /todo list/i)
  assert.match(SUBAGENT_DISPATCH_HINT, /subagent_type/)
  // The "don't grep configs to verify agents" guard (opus burned ~8 tool
  // calls doing exactly that before dispatching).
  assert.match(SUBAGENT_DISPATCH_HINT, /config files/i)
})

test("static task proxy def carries the disambiguation note", () => {
  const task = DEFAULT_PROXY_TOOLS.find((t) => t.name === "task")
  assert.ok(task, "task def missing from DEFAULT_PROXY_TOOLS")
  assert.ok(task!.description.includes(TASK_PROXY_NOTE))
  assert.match(task!.description, /TaskCreate/)
})

// Shape of opencode's live `task` description: generic delegation advice
// first, the agent list LAST. Claude Code truncates long MCP descriptions, so
// overlaying the whole thing buries the list in the cut region — which is what
// made haiku guess `general-purpose`/`code-reviewer` and fail every dispatch
// (live check 2026-07-26). Only the list is kept, and it goes first.
const LIVE_TASK_DESCRIPTION = [
  "Launch a new agent to handle complex, multistep tasks autonomously.",
  "",
  "When NOT to use the Task tool:",
  "- If you want to read a specific file path, use Read instead",
  "",
  "Usage notes:",
  "1. Launch multiple agents concurrently whenever possible",
  "",
  "Available agent types and the tools they have access to:",
  "- explore: Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns, search code for keywords, or answer questions about the codebase. Specify a thoroughness level.",
  "- glm: GLM 5.2",
].join("\n")

test("extractAgentTypeList keeps the agent names and drops the preamble", () => {
  const list = extractAgentTypeList(LIVE_TASK_DESCRIPTION)!
  assert.ok(list, "no list extracted")
  assert.match(list, /subagent_type/)
  assert.match(list, /- explore:/)
  assert.match(list, /- glm: GLM 5\.2/)
  // opencode's generic advice is not carried over.
  assert.ok(!list.includes("When NOT to use"))
  assert.ok(!list.includes("Usage notes"))
  // Long blurbs are trimmed with an ellipsis so the block stays small.
  assert.match(list, /…/)
})

test("extractAgentTypeList declines when there is no parsable list", () => {
  assert.equal(extractAgentTypeList(undefined), undefined)
  assert.equal(extractAgentTypeList("   "), undefined)
  assert.equal(extractAgentTypeList("Launch a new agent. No list here."), undefined)
  // Heading present but no entries under it.
  assert.equal(
    extractAgentTypeList("Available agent types and the tools they have access to:"),
    undefined,
  )
})

test("overlayTaskProxyDescription front-loads the agent list", () => {
  const out = overlayTaskProxyDescription(DEFAULT_PROXY_TOOLS, LIVE_TASK_DESCRIPTION)
  const task = out.find((t) => t.name === "task")!
  // The list must come first: it has to survive Claude Code truncating the
  // tail of a long MCP tool description.
  assert.match(task.description.split("\n")[0], /subagent_type/)
  assert.match(task.description, /- explore:/)
  assert.ok(task.description.endsWith(TASK_PROXY_NOTE))
  // Budget guard for the same truncation: the whole description stays small.
  assert.ok(
    task.description.length < 1600,
    `task description too long to survive truncation: ${task.description.length}`,
  )
  // Other defs untouched (same object references).
  const bashIn = DEFAULT_PROXY_TOOLS.find((t) => t.name === "bash")!
  const bashOut = out.find((t) => t.name === "bash")!
  assert.equal(bashOut, bashIn)
  // Source array not mutated.
  const original = DEFAULT_PROXY_TOOLS.find((t) => t.name === "task")!
  assert.ok(!original.description.includes("subagent_type values"))
})

test("overlayTaskProxyDescription is a no-op without a usable description", () => {
  assert.deepEqual(
    overlayTaskProxyDescription(DEFAULT_PROXY_TOOLS, undefined),
    DEFAULT_PROXY_TOOLS,
  )
  assert.deepEqual(
    overlayTaskProxyDescription(DEFAULT_PROXY_TOOLS, "   "),
    DEFAULT_PROXY_TOOLS,
  )
  // Live description with no agent list: keep the static def rather than
  // pasting opencode's preamble in front of it.
  assert.deepEqual(
    overlayTaskProxyDescription(DEFAULT_PROXY_TOOLS, "Launch a new agent."),
    DEFAULT_PROXY_TOOLS,
  )
})
