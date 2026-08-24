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
  return identifierSchema
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
    } else if (typeof value !== "string" || !identifier.test(value)) {
      return `workstream_manage ${name} is invalid`
    }
  }
  return null
}
