import assert from "node:assert/strict"
import { test } from "node:test"
import { createProxyMcpServer, DEFAULT_PROXY_TOOLS } from "./src/proxy-mcp.js"

test("DEFAULT_PROXY_TOOLS includes Plannotator submit_plan proxy schema", () => {
  const submitPlan = DEFAULT_PROXY_TOOLS.find((tool) => tool.name === "submit_plan")

  assert.ok(submitPlan, "submit_plan proxy tool should be registered")
  assert.match(submitPlan.description, /Plannotator submit_plan/)

  const schema = submitPlan.inputSchema as any
  assert.equal(schema.type, "object")
  assert.deepEqual(schema.required, ["edits"])

  const edits = schema.properties?.edits
  assert.equal(edits?.type, "array")
  assert.deepEqual(edits?.items?.required, ["start", "content"])
  assert.equal(edits?.items?.properties?.start?.type, "number")
  assert.equal(edits?.items?.properties?.end?.type, "number")
  assert.equal(edits?.items?.properties?.content?.type, "string")
})

test("proxy MCP server lists and dispatches submit_plan", async () => {
  const submitPlan = DEFAULT_PROXY_TOOLS.find((tool) => tool.name === "submit_plan")
  assert.ok(submitPlan)

  const srv = await createProxyMcpServer([submitPlan])
  try {
    const list = await rpc(srv.url, "tools/list", {})
    assert.deepEqual(
      list.result.tools.map((tool: any) => tool.name),
      ["submit_plan"],
    )

    const seen = new Promise<any>((resolve) => {
      srv.calls.once("call", (call) => {
        call.resolve({ kind: "text", text: "approved-by-test" })
        resolve(call)
      })
    })

    const callPromise = rpc(srv.url, "tools/call", {
      name: "submit_plan",
      arguments: {
        edits: [{ start: 1, content: "# Smoke Plan" }],
      },
    })

    const call = await seen
    assert.equal(call.toolName, "submit_plan")
    assert.deepEqual(call.input, {
      edits: [{ start: 1, content: "# Smoke Plan" }],
    })

    const result = await callPromise
    assert.deepEqual(result.result.content, [{ type: "text", text: "approved-by-test" }])
  } finally {
    await srv.close()
  }
})

async function rpc(url: string, method: string, params: Record<string, unknown>) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  assert.equal(response.status, 200)
  return response.json() as Promise<any>
}
