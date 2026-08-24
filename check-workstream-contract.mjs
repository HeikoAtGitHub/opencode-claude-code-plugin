import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname)
const vendoredPath = resolve(root, "contracts/workstream-manager-actions.v1.json")
const metadataPath = resolve(root, "contracts/workstream-manager-actions.v1.metadata.json")
const metadata = JSON.parse(readFileSync(metadataPath, "utf8"))
const vendored = readFileSync(vendoredPath)
const sha256 = createHash("sha256").update(vendored).digest("hex")

if (sha256 !== metadata.sha256) {
  throw new Error(`vendored contract SHA drift: metadata=${metadata.sha256} actual=${sha256}`)
}
const parsed = JSON.parse(vendored.toString("utf8"))
if (parsed.version !== metadata.version) {
  throw new Error(`vendored contract version drift: metadata=${metadata.version} actual=${parsed.version}`)
}

const canonicalPath = metadata.canonical_source.replace(/^~(?=\/)/, homedir())
if (existsSync(canonicalPath)) {
  const canonical = readFileSync(canonicalPath)
  if (!canonical.equals(vendored)) {
    throw new Error(`vendored contract differs from canonical bytes at ${canonicalPath}`)
  }
}

console.log(`workstream contract parity OK: v${metadata.version} sha256=${sha256}`)
