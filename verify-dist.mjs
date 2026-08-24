import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import * as provider from "./dist/index.js"

const metadata = JSON.parse(readFileSync(
  new URL("./contracts/workstream-manager-actions.v1.metadata.json", import.meta.url),
  "utf8",
))
assert.equal(provider.WORKSTREAM_CONTRACT_VERSION, metadata.version)
assert.equal(provider.WORKSTREAM_CONTRACT_SHA256, metadata.sha256)
assert.ok(provider.WORKSTREAM_ACTIONS.includes("member_adopt"))
const branches = provider.WORKSTREAM_INPUT_SCHEMA.oneOf
assert.ok(Array.isArray(branches))
assert.ok(branches.some((branch) =>
  branch?.properties?.action?.const === "member_adopt" &&
  branch.required?.includes("group_id") &&
  branch.required?.includes("slug")
))
const dist = readFileSync(new URL("./dist/index.js", import.meta.url), "utf8")
assert.match(dist, /member_adopt/)
assert.match(dist, /group_repair_push/)
console.log("dist workstream contract verification OK")
