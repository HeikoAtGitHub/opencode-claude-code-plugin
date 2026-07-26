import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import * as fs from "node:fs"
import * as path from "node:path"
import * as crypto from "node:crypto"
import { EventEmitter } from "node:events"
import { log } from "./logger.js"
import { pluginTmpDir } from "./tmp.js"

/**
 * Minimal MCP HTTP server embedded in-process. Exposes a set of "proxy"
 * tools (Bash, Edit, Write, etc.) that Claude CLI calls when its built-in
 * equivalents are disabled via --disallowedTools. Our handler blocks until
 * an external broker resolves the call, then responds to Claude.
 *
 * Wire protocol: JSON-RPC 2.0 over plain HTTP POST to `/mcp`. MCP spec
 * also supports SSE streaming, but Claude's HTTP transport accepts single
 * JSON responses for short-lived tool calls, so we keep it simple.
 */

export interface ProxyMcpServer {
  url: string
  serverName: string
  tools: ProxyToolDef[]
  /** Fires when Claude invokes one of our proxy tools. The handler resolves
   * the returned pending call once a result is available. */
  calls: EventEmitter
  /** Write `--mcp-config <path>`-compatible scratch file and return its path. */
  configPath(): string
  close(): Promise<void>
}

export interface ProxyToolDef {
  /** Raw name as seen by Claude once proxied: the MCP exposed tool name. */
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ProxyToolCall {
  id: string
  toolName: string
  input: Record<string, unknown>
  resolve: (result: ProxyToolResult) => void
  reject: (err: Error) => void
}

export type ProxyToolResult =
  | { kind: "text"; text: string; isError?: boolean }
  | { kind: "error"; message: string }

export const SERVER_CLOSED_MESSAGE = "proxy MCP server closed"

/** Rejections that fire on normal lifecycle transitions: AFK-permission
 * timeouts, orphan rejections at turn boundaries, stream aborts, and server
 * close while its owning Claude process exits or is replaced. None are
 * user-actionable — file-log them at NOTICE. Anything else stays WARN so
 * genuine bugs remain visible in the TUI. */
export function isExpectedCleanupError(message: string): boolean {
  return (
    (message.includes("timed out after") &&
      message.includes("waiting for opencode to resolve")) ||
    message.includes("rejecting as orphaned") ||
    message.includes("was orphaned by a new user turn") ||
    message.includes("stream was aborted") ||
    message.includes(SERVER_CLOSED_MESSAGE)
  )
}

const PROTOCOL_VERSION = "2024-11-05"
const SERVER_NAME = "opencode_proxy"
export const PROXY_TOOL_PREFIX = `mcp__${SERVER_NAME}__`

// Flat fallback cap on how long a proxy tool call may wait for opencode to
// resolve it. Matches Claude CLI's hard upper bound for Bash (10 min). The
// effective deadline is resolved per tool — see `resolveProxyCallTimeoutMs`.
export const PROXY_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

// Per-tool default deadlines, keyed by lowercase proxy tool name. `task`
// dispatches an opencode subagent that routinely runs 20-40 min; the old
// flat ceiling fired mid-subagent, made Claude believe its dispatch had
// failed, and (because the proxy had already returned a timeout error) the
// late subagent result was dropped on the floor -- the operator had to
// nudge "please check now, it seems the task succeeded" (@jknlsn, live
// session ses_0cfc0da6, 2026-07-05).
export const PROXY_PER_TOOL_DEFAULT_TIMEOUT_MS: Record<string, number> = {
  task: 60 * 60 * 1000, // 60 min
}

// Node's setTimeout delay is a signed 32-bit int; values above 2^31-1 ms
// (~24.85 days) trigger TimeoutOverflowWarning and fire at ~1ms instead.
// Clamp absurd overrides / input.timeouts so a misconfigured deadline
// can't collapse to "fires immediately".
export const MAX_PROXY_TIMEOUT_MS = 2 ** 31 - 1

/**
 * Resolve the proxy deadline for a tool call. Layers, most-specific last:
 *  1. flat default (`PROXY_DEFAULT_TIMEOUT_MS`, 10 min)
 *  2. per-tool default (`PROXY_PER_TOOL_DEFAULT_TIMEOUT_MS`)
 *  3. user override via `proxyToolTimeoutMs` config (case-insensitive key)
 *  4. for `bash`, the call's own `input.timeout` -- the proxy must never
 *     undercut a build the caller explicitly asked to run long. The bash
 *     proxy def advertises a `timeout` field; before this fix the proxy
 *     ignored it and killed the call at the flat ceiling anyway.
 * Finally clamped to `MAX_PROXY_TIMEOUT_MS` to stay within Node's timer range.
 */
export function resolveProxyCallTimeoutMs(
  toolName: string,
  input: Record<string, unknown> | undefined,
  overrides: Record<string, number> | undefined,
): number {
  const key = toolName.toLowerCase()
  let ms = PROXY_PER_TOOL_DEFAULT_TIMEOUT_MS[key] ?? PROXY_DEFAULT_TIMEOUT_MS
  if (overrides) {
    const ov = lookupCaseInsensitive(overrides, key)
    if (typeof ov === "number" && ov > 0) ms = ov
  }
  if (key === "bash") {
    const requested = input?.timeout
    if (typeof requested === "number" && requested > ms) ms = requested
  }
  return Math.min(ms, MAX_PROXY_TIMEOUT_MS)
}

function lookupCaseInsensitive(
  map: Record<string, number>,
  key: string,
): number | undefined {
  if (Object.prototype.hasOwnProperty.call(map, key)) return map[key]
  for (const k of Object.keys(map)) {
    if (k.toLowerCase() === key) return map[k]
  }
  return undefined
}

/**
 * Client-side abort ceiling written into Claude's `--mcp-config` entry for
 * the proxy server. Without a `timeout` there, Claude CLI's remote-HTTP MCP
 * client aborts each call at its 60-second default even while an opencode
 * subagent is still running (@broskees, PR #18). It must be >= the largest
 * server-side deadline or the client gives up before the broker does, so it
 * tracks the max of the flat default, per-tool defaults, and user overrides.
 * (A bash call raising its own `input.timeout` above this ceiling is a known
 * edge; Claude CLI caps bash at 10 min anyway.)
 */
export function resolveProxyClientCeilingMs(
  overrides: Record<string, number> | undefined,
): number {
  let ms = PROXY_DEFAULT_TIMEOUT_MS
  for (const v of Object.values(PROXY_PER_TOOL_DEFAULT_TIMEOUT_MS)) {
    if (v > ms) ms = v
  }
  if (overrides) {
    for (const v of Object.values(overrides)) {
      if (typeof v === "number" && v > ms) ms = v
    }
  }
  return Math.min(ms, MAX_PROXY_TIMEOUT_MS)
}

/**
 * Build the timeout error surfaced to Claude. Keeps the substrings
 * `"timed out after"` and `"waiting for opencode to resolve"` that the
 * proxy-mcp catch block classifies as expected cleanup (notice, not warn).
 * For `task` we append guidance: a Task timeout means the subagent may
 * still be running but its result is now unreachable, and the model must
 * neither declare the dispatch failed nor "schedule a wake-up" -- that is a
 * Claude Code affordance which cannot fire in this headless/proxy context,
 * so deferring silently drops the work.
 */
export function buildProxyTimeoutError(toolName: string, ms: number): Error {
  const key = toolName.toLowerCase()
  const base = `Proxy tool '${toolName}' timed out after ${ms}ms waiting for opencode to resolve the call`
  if (key === "task") {
    return new Error(
      base +
        " (the subagent). The subagent may still be running but its result" +
        " is no longer reachable in this session. Do not declare the dispatch" +
        " failed, and do not 'schedule a wake-up' or defer -- that mechanism" +
        " does not apply here. If the result is required, re-dispatch or" +
        " verify it directly now.",
    )
  }
  return new Error(base)
}

/**
 * Disambiguation appended to the `task` proxy def (both the static
 * fallback and the live overlay). Models routinely resolve opencode's
 * "call the task tool with subagent: X" mention hint to Claude Code's
 * native TaskCreate (a todo tool) — creating a todo, dispatching nothing,
 * and then narrating a successful dispatch. Others burn turns grepping
 * config files to verify a subagent exists before daring to call it.
 * Both failure modes are addressed here, at the tool the model reads.
 */
export const TASK_PROXY_NOTE =
  "This is the ONLY tool that dispatches opencode subagents (including" +
  " user @-mentions). Claude Code's built-in TaskCreate/TaskUpdate manage" +
  " a local todo list and cannot dispatch subagents. Do not search config" +
  " files to verify a subagent type exists — invalid types fail fast with" +
  " a clear error. Foreground calls block until the subagent finishes; set" +
  " `background` to request opencode's background execution mode. Task calls" +
  " get a 60-minute proxy deadline by default (configurable via" +
  " proxyToolTimeoutMs)."

const AGENT_TYPES_HEADING = "Available agent types"

/** Longest per-agent blurb we keep; enough to choose, short enough to survive. */
const AGENT_BLURB_LIMIT = 140

/**
 * Pull *only* the agent-type list out of opencode's live `task` description.
 *
 * jknlsn's original overlaid the whole live description (2.8 KB here) in front
 * of the static def. Live check 2026-07-26 showed that backfires: Claude Code
 * truncates long MCP tool descriptions, and opencode puts the agent list at
 * the *end* (char 2306 of 2858), so the one part the model needs is exactly
 * what gets cut — haiku then guessed `general-purpose`, `default`, and
 * `code-reviewer` (Claude Code's own agent names) and every dispatch failed
 * with "Unknown agent type". So: keep the list, drop opencode's preamble
 * (generic delegation advice the model already has), trim each blurb, and let
 * the caller put it first.
 *
 * Returns undefined when the description carries no parsable list, so callers
 * leave the static def alone.
 */
export function extractAgentTypeList(
  liveDescription: string | undefined,
): string | undefined {
  const live = liveDescription?.trim()
  if (!live) return undefined
  const start = live.indexOf(AGENT_TYPES_HEADING)
  if (start === -1) return undefined
  const entries: string[] = []
  for (const raw of live.slice(start).split("\n")) {
    const match = /^-\s*([^:]+):\s*(.+)$/.exec(raw.trim())
    if (!match) continue
    const name = match[1].trim()
    const blurb = match[2].trim()
    entries.push(
      `- ${name}: ${
        blurb.length > AGENT_BLURB_LIMIT
          ? `${blurb.slice(0, AGENT_BLURB_LIMIT).trimEnd()}…`
          : blurb
      }`,
    )
  }
  if (entries.length === 0) return undefined
  return `Valid subagent_type values, from opencode's live registry — anything else fails:\n${entries.join("\n")}`
}

/**
 * Front-load opencode's live agent-type list onto the static `task` proxy def
 * so the model picks a real `subagent_type` instead of guessing a Claude Code
 * name. First, not last: see `extractAgentTypeList` for why position matters.
 * No-op when no list can be extracted (SDK client missing, older opencode) or
 * the `task` def is not among the tools.
 */
export function overlayTaskProxyDescription(
  tools: ProxyToolDef[],
  liveDescription: string | undefined,
): ProxyToolDef[] {
  const agentTypes = extractAgentTypeList(liveDescription)
  if (!agentTypes) return tools
  return tools.map((t) =>
    t.name === "task"
      ? { ...t, description: `${agentTypes}\n\n${t.description}` }
      : t,
  )
}

export const DEFAULT_PROXY_TOOLS: ProxyToolDef[] = [
  {
    name: "bash",
    description:
      "Execute a shell command. Routed through opencode's bash tool so" +
      " permission prompts flow through opencode's UI.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute.",
        },
        description: {
          type: "string",
          description: "Short human-readable description of what the command does.",
        },
        timeout: {
          type: "number",
          description: "Optional timeout in milliseconds.",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "write",
    description:
      "Write a file. Routed through opencode's write tool so permission prompts flow through opencode's UI.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "The file to write. Absolute paths are preferred.",
        },
        content: {
          type: "string",
          description: "The full content to write to the file.",
        },
      },
      required: ["filePath", "content"],
    },
  },
  {
    name: "edit",
    description:
      "Replace text in an existing file. Routed through opencode's edit tool so permission prompts flow through opencode's UI.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "The file to edit. Absolute paths are preferred.",
        },
        oldString: {
          type: "string",
          description: "The exact text to replace.",
        },
        newString: {
          type: "string",
          description: "The replacement text.",
        },
        replaceAll: {
          type: "boolean",
          description: "Replace all occurrences instead of just the first one.",
        },
      },
      required: ["filePath", "oldString", "newString"],
    },
  },
  {
    name: "webfetch",
    description:
      "Fetch content from a URL. Routed through opencode's webfetch tool so" +
      " permission prompts flow through opencode's UI. Returns the page" +
      " content in the requested format.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to fetch content from. Must start with http:// or https://.",
        },
        format: {
          type: "string",
          enum: ["text", "markdown", "html"],
          description:
            "The format to return the content in. Defaults to markdown.",
        },
        timeout: {
          type: "number",
          description: "Optional timeout in seconds (max 120).",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "task",
    description:
      "Launch an opencode subagent to handle a complex multi-step task" +
      " autonomously. Routed through opencode's task tool so subagent" +
      " orchestration, permission, and lifecycle are handled by opencode." +
      " Use `subagent_type` to pick which configured subagent runs (e.g." +
      " `build`, `general`, `explore`, or any custom subagent declared in" +
      " opencode.json). " +
      TASK_PROXY_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "A short (3-5 words) description of the task",
        },
        prompt: {
          type: "string",
          description: "The task for the agent to perform",
        },
        subagent_type: {
          type: "string",
          description: "The type of specialized agent to use for this task",
        },
        task_id: {
          type: "string",
          description:
            "Set this only if you mean to resume a previous task — pass the" +
            " prior task_id to continue the same subagent session instead of" +
            " creating a fresh one.",
        },
        command: {
          type: "string",
          description: "The command that triggered this task",
        },
        background: {
          type: "boolean",
          description:
            "Run the task in the background when supported by opencode",
        },
      },
      required: ["description", "prompt", "subagent_type"],
    },
  },
]

export async function createProxyMcpServer(
  tools: ProxyToolDef[] = DEFAULT_PROXY_TOOLS,
  timeoutOverrides?: Record<string, number>,
): Promise<ProxyMcpServer> {
  const calls = new EventEmitter()
  const pending = new Map<string, ProxyToolCall>()

  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url?.startsWith("/mcp")) {
      res.statusCode = 404
      res.end()
      return
    }
    let requestId: number | string | null = null
    let requestMethod: string | null = null
    try {
      const body = await readBody(req)
      const request = JSON.parse(body) as {
        jsonrpc?: string
        id?: number | string | null
        method?: string
        params?: Record<string, unknown>
      }
      requestId = request?.id ?? null
      requestMethod = typeof request?.method === "string" ? request.method : null

      if (request?.jsonrpc !== "2.0" || typeof request.method !== "string") {
        writeJson(res, {
          jsonrpc: "2.0",
          id: requestId,
          error: { code: -32600, message: "Invalid request" },
        })
        return
      }

      log.debug("proxy-mcp request", {
        method: request.method,
        id: request.id,
      })

      if (request.method === "initialize") {
        writeJson(res, {
          jsonrpc: "2.0",
          id: requestId,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: {
              name: SERVER_NAME,
              version: "0.1.0",
            },
          },
        })
        return
      }

      if (request.method === "notifications/initialized") {
        res.statusCode = 204
        res.end()
        return
      }

      if (request.method === "tools/list") {
        writeJson(res, {
          jsonrpc: "2.0",
          id: requestId,
          result: {
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        })
        return
      }

      if (request.method === "tools/call") {
        const params = request.params ?? {}
        const toolName = String(params.name ?? "")
        const input = (params.arguments ?? {}) as Record<string, unknown>

        if (!tools.some((t) => t.name === toolName)) {
          // tools/call failures MUST be MCP results with isError, never
          // JSON-RPC error envelopes: Claude CLI validates every tools/call
          // response against the MCP result schema and rejects JSON-RPC
          // errors as malformed (@jknlsn, seen live 2026-07-04).
          writeJson(res, {
            jsonrpc: "2.0",
            id: requestId,
            result: {
              content: [{ type: "text", text: `Unknown proxy tool: ${toolName}` }],
              isError: true,
            },
          })
          return
        }

        const callId = crypto.randomUUID()
        log.info("proxy-mcp tool call received", {
          callId,
          toolName,
          hasInput: input != null,
        })

        let timer: ReturnType<typeof setTimeout> | null = null
        const result = await new Promise<ProxyToolResult>(
          (resolve, reject) => {
            const entry: ProxyToolCall = {
              id: callId,
              toolName,
              input,
              resolve,
              reject,
            }
            pending.set(callId, entry)
            const deadlineMs = resolveProxyCallTimeoutMs(
              toolName,
              input,
              timeoutOverrides,
            )
            timer = setTimeout(() => {
              if (!pending.has(callId)) return
              pending.delete(callId)
              // v0.4.13: demoted from warn to notice. Timeouts are usually
              // permission-pending while the user is AFK — surfacing each as
              // a yellow UI bubble produces a wall of noise on return. The
              // file log still captures the event for diagnostics.
              log.notice("proxy-mcp tool call timed out", {
                callId,
                toolName,
                deadlineMs,
              })
              reject(buildProxyTimeoutError(toolName, deadlineMs))
            }, deadlineMs)
            calls.emit("call", entry)
          },
        ).finally(() => {
          if (timer) clearTimeout(timer)
          pending.delete(callId)
        })

        if (result.kind === "error") {
          // MCP result with isError, not a JSON-RPC error — see the unknown-
          // tool comment above.
          writeJson(res, {
            jsonrpc: "2.0",
            id: requestId,
            result: {
              content: [{ type: "text", text: result.message }],
              isError: true,
            },
          })
          return
        }

        writeJson(res, {
          jsonrpc: "2.0",
          id: requestId,
          result: {
            content: [{ type: "text", text: result.text }],
            isError: result.isError === true,
          },
        })
        return
      }

      writeJson(res, {
        jsonrpc: "2.0",
        id: requestId,
        error: { code: -32601, message: `Unknown method: ${request.method}` },
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      const logFn = isExpectedCleanupError(errorMessage) ? log.notice : log.warn
      logFn("proxy-mcp error handling request", {
        error: errorMessage,
      })
      // Broker rejections (timeouts, orphans, server close) surface here for
      // tools/call requests. Same rule as above: respond with an MCP result
      // carrying isError, never a JSON-RPC error envelope, or Claude CLI
      // rejects the response as schema-invalid.
      if (requestMethod === "tools/call") {
        try {
          writeJson(res, {
            jsonrpc: "2.0",
            id: requestId,
            result: {
              content: [{ type: "text", text: errorMessage }],
              isError: true,
            },
          })
        } catch {
          try {
            res.statusCode = 500
            res.end()
          } catch {}
        }
        return
      }
      try {
        writeJson(res, {
          jsonrpc: "2.0",
          id: requestId,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : "Internal error",
          },
        })
      } catch {
        try {
          res.statusCode = 500
          res.end()
        } catch {}
      }
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })

  const addr = server.address() as AddressInfo | null
  if (!addr) {
    server.close()
    throw new Error("Failed to bind proxy MCP server")
  }

  const url = `http://127.0.0.1:${addr.port}/mcp`

  log.info("proxy-mcp server started", {
    url,
    tools: tools.map((t) => t.name),
  })

  let configFilePath: string | null = null

  const api: ProxyMcpServer = {
    url,
    serverName: SERVER_NAME,
    tools,
    calls,
    configPath() {
      if (configFilePath) return configFilePath
      const body = JSON.stringify(
        {
          mcpServers: {
            [SERVER_NAME]: {
              type: "http",
              url,
              timeout: resolveProxyClientCeilingMs(timeoutOverrides),
            },
          },
        },
        null,
        2,
      )
      const hash = crypto
        .createHash("sha256")
        .update(body)
        .digest("hex")
        .slice(0, 12)
      const outPath = path.join(
        pluginTmpDir(),
        `proxy-${hash}.json`,
      )
      fs.writeFileSync(outPath, body, { encoding: "utf8", mode: 0o600 })
      configFilePath = outPath
      return outPath
    },
    async close() {
      for (const entry of pending.values()) {
        entry.reject(new Error(SERVER_CLOSED_MESSAGE))
      }
      pending.clear()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
      if (configFilePath) {
        try {
          fs.unlinkSync(configFilePath)
        } catch {}
        configFilePath = null
      }
    },
  }

  return api
}

/** CLI-ready list of Claude tool names to disable, for each proxied tool. */
export function disallowedToolFlags(tools: ProxyToolDef[]): string[] {
  // Map our lowercase MCP tool names to the Claude tool name(s) they replace.
  // `edit` covers both `Edit` and `MultiEdit` because opencode has no
  // MultiEdit equivalent; without disabling MultiEdit, Claude can batch
  // file changes through it and bypass opencode's permission UI.
  // `task` disables Claude CLI's `Agent` tool (its built-in subagent
  // dispatcher) so subagent calls flow through opencode's `task` tool
  // instead — which lets opencode's configured subagent set (`build`,
  // `general`, custom subagents in opencode.json) execute the work
  // under opencode's permission/lifecycle, rather than Claude's
  // internal-only general-purpose / Explore / Plan options.
  const nameMap: Record<string, string[]> = {
    bash: ["Bash"],
    read: ["Read"],
    write: ["Write"],
    edit: ["Edit", "MultiEdit"],
    glob: ["Glob"],
    grep: ["Grep"],
    webfetch: ["WebFetch"],
    task: ["Agent"],
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (const t of tools) {
    const mapped = nameMap[t.name.toLowerCase()]
    if (!mapped) continue
    for (const claudeTool of mapped) {
      if (seen.has(claudeTool)) continue
      seen.add(claudeTool)
      out.push(claudeTool)
    }
  }
  return out
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

function writeJson(res: ServerResponse, body: unknown): void {
  const payload = JSON.stringify(body)
  res.statusCode = 200
  res.setHeader("Content-Type", "application/json")
  res.setHeader("Content-Length", Buffer.byteLength(payload).toString())
  res.end(payload)
}
