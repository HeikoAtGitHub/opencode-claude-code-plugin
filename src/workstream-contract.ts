import contractJson from "../contracts/workstream-manager-actions.v1.json"
import metadataJson from "../contracts/workstream-manager-actions.v1.metadata.json"

type ContractAction = {
  args: string[]
}

type WorkstreamContract = {
  version: string
  identifier_pattern: string
  actions: Record<string, ContractAction>
}

export const WORKSTREAM_CONTRACT = contractJson as WorkstreamContract
export const WORKSTREAM_CONTRACT_CANONICAL_SOURCE = metadataJson.canonical_source
export const WORKSTREAM_CONTRACT_VERSION = WORKSTREAM_CONTRACT.version
export const WORKSTREAM_CONTRACT_SHA256 = metadataJson.sha256
export const WORKSTREAM_ACTIONS = Object.freeze(Object.keys(WORKSTREAM_CONTRACT.actions))
export const WORKSTREAM_IDENTIFIER_PATTERN = WORKSTREAM_CONTRACT.identifier_pattern

const identifierSchema = {
  type: "string",
  pattern: WORKSTREAM_IDENTIFIER_PATTERN,
}

function propertySchema(name: string): Record<string, unknown> {
  if (name === "members") {
    return { type: "array", items: identifierSchema }
  }
  if (name === "planned_paths") {
    return {
      type: "array", minItems: 1, maxItems: 100,
      items: { type: "string", minLength: 1, maxLength: 1000 },
    }
  }
  if (name === "repo_roots") {
    return {
      type: "array", maxItems: 20,
      items: { type: "string", minLength: 1, maxLength: 1000 },
    }
  }
  if (name === "repo_root") return { type: "string", minLength: 1, maxLength: 1000 }
  if (name === "scope") return { type: "string", enum: ["current", "all"] }
  if (name === "on_conflict") return { type: "string", enum: ["skip", "stop"] }
  return identifierSchema
}

function isSafePlannedPath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 1000) return false
  if (value.startsWith("/") || value.endsWith("/") || value.includes("\\")) return false
  return value.split("/").every(
    (part) => part !== "" && part !== "." && part !== ".." && !/[*?[\]]/.test(part),
  )
}

export const WORKSTREAM_INPUT_SCHEMA: Record<string, unknown> = {
  oneOf: WORKSTREAM_ACTIONS.map((action) => {
    const args = WORKSTREAM_CONTRACT.actions[action].args
    const properties: Record<string, unknown> = {
      action: { const: action },
    }
    const required = ["action"]
    for (const rawArg of args) {
      const optional = rawArg.endsWith("?")
      const arg = optional ? rawArg.slice(0, -1) : rawArg
      properties[arg] = propertySchema(arg)
      if (!optional) required.push(arg)
    }
    return {
      type: "object",
      additionalProperties: false,
      properties,
      required,
    }
  }),
}

/**
 * Claude Code's MCP client requires each exposed tool schema to have an
 * object root.  Keep the exact action-specific contract above for internal
 * evidence, but expose this object-root projection at the MCP boundary.
 * Runtime validation remains action-specific in validateWorkstreamInput.
 */
export const WORKSTREAM_PROXY_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: WORKSTREAM_ACTIONS },
    slug: propertySchema("slug"),
    group_id: propertySchema("group_id"),
    members: propertySchema("members"),
    planned_paths: propertySchema("planned_paths"),
    repo_root: propertySchema("repo_root"),
    repo_roots: propertySchema("repo_roots"),
    scope: propertySchema("scope"),
    on_conflict: propertySchema("on_conflict"),
  },
  required: ["action"],
}

export function validateWorkstreamInput(input: Record<string, unknown>): string | null {
  const action = typeof input.action === "string" ? input.action : ""
  const rule = WORKSTREAM_CONTRACT.actions[action]
  if (!rule) {
    return `workstream_manage action must be one of: ${WORKSTREAM_ACTIONS.join(", ")}`
  }

  const args = rule.args.map((arg) => ({
    name: arg.endsWith("?") ? arg.slice(0, -1) : arg,
    optional: arg.endsWith("?"),
  }))
  const accepted = new Set(["action", ...args.map((arg) => arg.name)])
  if (Object.keys(input).some((key) => !accepted.has(key))) {
    return `workstream_manage ${action} accepts only ${[...accepted].join(", ")}`
  }

  const identifier = new RegExp(WORKSTREAM_IDENTIFIER_PATTERN)
  for (const { name, optional } of args) {
    const value = input[name]
    if (value === undefined) {
      if (!optional) return `${action} requires ${name}`
      continue
    }
    if (name === "members") {
      if (!Array.isArray(value) || value.some((member) =>
        typeof member !== "string" || !identifier.test(member)
      )) return "workstream_manage members are invalid"
    } else if (name === "planned_paths") {
      if (!Array.isArray(value) || value.length < 1 || value.length > 100 || value.some((path) => !isSafePlannedPath(path))) {
        return "workstream_manage planned_paths are invalid"
      }
    } else if (name === "repo_roots") {
      if (!Array.isArray(value) || value.length > 20 || value.some((repo) =>
        typeof repo !== "string" || !repo || repo.length > 1000
      )) return "workstream_manage repo_roots are invalid"
    } else if (name === "repo_root") {
      if (typeof value !== "string" || !value || value.length > 1000) return "workstream_manage repo_root is invalid"
    } else if (name === "scope") {
      if (value !== "current" && value !== "all") return "workstream_manage scope is invalid"
    } else if (name === "on_conflict") {
      if (value !== "skip" && value !== "stop") return "workstream_manage on_conflict is invalid"
    } else if (typeof value !== "string" || !identifier.test(value)) {
      return `workstream_manage ${name} is invalid`
    }
  }
  return null
}
