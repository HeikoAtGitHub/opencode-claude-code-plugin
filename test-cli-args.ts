import assert from "node:assert/strict"
import { test } from "node:test"
import {
  buildCliArgs,
  claudeSpawnEnv,
  isClaudeThinkingDisabled,
} from "./src/session-manager.js"
import {
  cliSupportsThinking,
  cliSupportsThinkingDisplay,
} from "./src/cli-version.js"

function withClaudeThinkingEnv<T>(
  env: {
    disableThinking?: string
    disableAdaptiveThinking?: string
    showSummaries?: string
  },
  fn: () => T,
): T {
  const previous = {
    disableThinking: process.env.CLAUDE_CODE_DISABLE_THINKING,
    disableAdaptiveThinking: process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING,
    showSummaries: process.env.CLAUDE_CODE_SHOW_THINKING_SUMMARIES,
  }

  try {
    if (env.disableThinking === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_THINKING
    } else {
      process.env.CLAUDE_CODE_DISABLE_THINKING = env.disableThinking
    }
    if (env.disableAdaptiveThinking === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING
    } else {
      process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING = env.disableAdaptiveThinking
    }
    if (env.showSummaries === undefined) {
      delete process.env.CLAUDE_CODE_SHOW_THINKING_SUMMARIES
    } else {
      process.env.CLAUDE_CODE_SHOW_THINKING_SUMMARIES = env.showSummaries
    }
    return fn()
  } finally {
    if (previous.disableThinking === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_THINKING
    } else {
      process.env.CLAUDE_CODE_DISABLE_THINKING = previous.disableThinking
    }
    if (previous.disableAdaptiveThinking === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING
    } else {
      process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING = previous.disableAdaptiveThinking
    }
    if (previous.showSummaries === undefined) {
      delete process.env.CLAUDE_CODE_SHOW_THINKING_SUMMARIES
    } else {
      process.env.CLAUDE_CODE_SHOW_THINKING_SUMMARIES = previous.showSummaries
    }
  }
}

test("thinking-display is gated on Claude Code CLI 2.1.142+", () => {
  assert.equal(cliSupportsThinkingDisplay(null), false)
  assert.equal(
    cliSupportsThinkingDisplay({ major: 2, minor: 1, patch: 141, raw: "2.1.141" }),
    false,
  )
  assert.equal(
    cliSupportsThinkingDisplay({ major: 2, minor: 1, patch: 142, raw: "2.1.142" }),
    true,
  )
  assert.equal(
    cliSupportsThinkingDisplay({ major: 2, minor: 2, patch: 0, raw: "2.2.0" }),
    true,
  )
})

test("buildCliArgs skips unsupported thinking-display flag", () => {
  const args = buildCliArgs({
    sessionKey: "test",
    skipPermissions: true,
    model: "claude-opus-4-7",
    thinking: "enabled",
    thinkingDisplay: "summarized",
    cliVersion: { major: 2, minor: 1, patch: 141, raw: "2.1.141" },
  })

  assert.equal(args.includes("--thinking"), true)
  assert.equal(args.includes("enabled"), true)
  assert.equal(args.includes("--thinking-display"), false)
  assert.equal(args.includes("summarized"), false)
})

test("cliSupportsThinking floors at 2.0.0", () => {
  assert.equal(cliSupportsThinking(null), false)
  assert.equal(
    cliSupportsThinking({ major: 1, minor: 99, patch: 99, raw: "1.99.99" }),
    false,
  )
  assert.equal(
    cliSupportsThinking({ major: 2, minor: 0, patch: 0, raw: "2.0.0" }),
    true,
  )
  assert.equal(
    cliSupportsThinking({ major: 2, minor: 1, patch: 142, raw: "2.1.142" }),
    true,
  )
})

test("buildCliArgs skips --thinking when cliVersion is unknown", () => {
  const args = buildCliArgs({
    sessionKey: "test",
    skipPermissions: true,
    model: "claude-opus-4-7",
    thinking: "enabled",
    cliVersion: null,
  })

  assert.equal(args.includes("--thinking"), false)
  assert.equal(args.includes("enabled"), false)
})

test("buildCliArgs skips --thinking on pre-2.x CLI", () => {
  const args = buildCliArgs({
    sessionKey: "test",
    skipPermissions: true,
    model: "claude-opus-4-7",
    thinking: "enabled",
    cliVersion: { major: 1, minor: 5, patch: 0, raw: "1.5.0" },
  })

  assert.equal(args.includes("--thinking"), false)
})

test("buildCliArgs emits thinking-display for supported CLI", () => {
  const args = buildCliArgs({
    sessionKey: "test",
    skipPermissions: true,
    model: "claude-opus-4-7",
    thinking: "enabled",
    thinkingDisplay: "summarized",
    cliVersion: { major: 2, minor: 1, patch: 142, raw: "2.1.142" },
  })

  assert.equal(args.includes("--thinking"), true)
  assert.equal(args.includes("enabled"), true)
  assert.equal(args.includes("--thinking-display"), true)
  assert.equal(args.includes("summarized"), true)
})

test("Claude thinking env defaults preserve explicit user choices", () => {
  withClaudeThinkingEnv({}, () => {
    assert.equal(isClaudeThinkingDisabled(), false)
    assert.equal(claudeSpawnEnv().CLAUDE_CODE_SHOW_THINKING_SUMMARIES, "1")
  })

  withClaudeThinkingEnv({ showSummaries: "0" }, () => {
    assert.equal(isClaudeThinkingDisabled(), false)
    assert.equal(claudeSpawnEnv().CLAUDE_CODE_SHOW_THINKING_SUMMARIES, "0")
  })

  withClaudeThinkingEnv({ disableThinking: "1" }, () => {
    assert.equal(isClaudeThinkingDisabled(), true)
    assert.equal(claudeSpawnEnv().CLAUDE_CODE_SHOW_THINKING_SUMMARIES, undefined)
  })

  withClaudeThinkingEnv({ disableAdaptiveThinking: "false" }, () => {
    assert.equal(isClaudeThinkingDisabled(), false)
    assert.equal(claudeSpawnEnv().CLAUDE_CODE_SHOW_THINKING_SUMMARIES, "1")
  })
})

test("disableThinking config flag turns thinking off without env vars", () => {
  withClaudeThinkingEnv({}, () => {
    // config off (default): thinking stays on, summaries default to 1
    assert.equal(isClaudeThinkingDisabled(false), false)
    assert.equal(claudeSpawnEnv(false).CLAUDE_CODE_SHOW_THINKING_SUMMARIES, "1")
    assert.equal(claudeSpawnEnv(false).CLAUDE_CODE_DISABLE_THINKING, undefined)

    // config on: thinking off, no summaries env injected, and the disable var
    // is propagated to the child so the CLI itself enforces thinking-off
    assert.equal(isClaudeThinkingDisabled(true), true)
    assert.equal(
      claudeSpawnEnv(true).CLAUDE_CODE_SHOW_THINKING_SUMMARIES,
      undefined,
    )
    assert.equal(claudeSpawnEnv(true).CLAUDE_CODE_DISABLE_THINKING, "1")
  })
})

test("disableThinking config flag does not clobber an explicit env var value", () => {
  withClaudeThinkingEnv({ disableThinking: "0" }, () => {
    // User explicitly set the env var to off. Even though config requests
    // disable, the explicit child env value is preserved untouched.
    assert.equal(claudeSpawnEnv(true).CLAUDE_CODE_DISABLE_THINKING, "0")
  })
})

test("disableThinking env var still forces thinking off when config is off", () => {
  withClaudeThinkingEnv({ disableThinking: "1" }, () => {
    assert.equal(isClaudeThinkingDisabled(false), true)
    assert.equal(
      claudeSpawnEnv(false).CLAUDE_CODE_SHOW_THINKING_SUMMARIES,
      undefined,
    )
  })
})
