---
artifact_type: handover
implementation_authority: none
next_session_requires_plan: true
source_plan_title: Lokalen Plugin-Clone auf Upstream zurueckbauen_T_upstream-rueckbau-mcp-tools
repo: opencode-claude-code-plugin
branch: local/submit-plan-proxy
head_at_export: 83202ab
created: 2026-09-24
---

# Lokalen Plugin-Clone auf Upstream zurueckbauen — Handover_T_upstream-rueckbau-mcp-tools

## Zweck und Status

Klaerungs-Handover fuer eine eigene Session: Kann der lokale Clone
`/home/heiko/repos/opencode-claude-code-plugin` (Branch
`local/submit-plan-proxy`) aufgegeben und das Upstream-Paket
`@khalilgharbaoui/opencode-claude-code-plugin` (aktuell v0.27.1) direkt
genutzt werden? Dieses Dokument autorisiert keine Implementierung und
ersetzt keinen Plan. Jede Umstellung braucht neuen SSOT-Scan und genehmigten
Plan.

Stand der Analyse: Code- und Log-Evidenz gesammelt, **nichts live
verifiziert**, keine Datei ausser diesem Handover geaendert.

## Ausgangslage

- Aktive Einbindung: `~/.config/opencode/opencode.jsonc` Zeile ~111,
  `"file:///home/heiko/repos/opencode-claude-code-plugin/dist/index.js"`.
- Provider-Optionen (`opencode.jsonc` ~Zeile 205):
  `proxyTools: ["Bash","Edit","Write","WebFetch","Task","submit_plan","repo_policy_scope","workstream_manage"]`,
  `bridgeOpencodeMcp: true`, `proxyOpencodeMcpTools: true`,
  `interactive: false`, `ignoreAnthropicApiKey: true`, `logging.file: true`.
- Lokaler Branch = Upstream v0.25.0 + lokale Commits. Letzte zwei lokale
  Fixes vom 2026-09-23: `eb3c37d` (Overage-False-Positive) und `83202ab`
  (Abort an Proxy-Tool-Grenze haelt geparkten Call).
- Lokale AGENTS.md, Abschnitt "Local governance variant": lokalen Clone
  nicht entfernen, bevor genehmigte Migration **und** Live-Verifikation
  vorliegen. Diese Vorgabe bleibt bis zur Umstellung bindend.

## Befunde v0.25.0 → v0.27.1

| Lokales Problem / Feature | Upstream-Stand | Evidenz |
|---|---|---|
| Overage-False-Positive (`eb3c37d`) | geloest in `65379ea` "Stop a served turn opening the failover form" | Diff `src/cli-events.ts`, gleiche Semantik |
| Abort an Tool-Grenze (`83202ab`, `isSessionStopped`) | geloest in `494d921` "Stop opencode tool-boundary aborts cancelling live calls" (`settleSessionRunState`) | Diff `src/runtime-status.ts`; nur `busy` haelt Call |
| Proxy-Deadline waehrend Permission-Prompt | neu in `0124280` (`isProxyCallStillServed`, generisch fuer alle Proxy-Calls) | `src/proxy-mcp.ts` v0.27.1 Zeile ~169 |
| SSE-Keepalive (`42f426d`), AGENTS.md-Dedup (`25260a4`) | frueher schon absorbiert | Upstream-AGENTS.md, Credits |
| `submit_plan`, `repo_policy_scope`, `workstream_manage` | Upstream kennt sie **nicht** in `proxyTools`; Ersatz: `proxyOpencodeTools`-Allowlist forwardet beliebige Registry-Tools | Log 2026-09-23T11:51 `ignoring unknown proxyTools entries`; `resolveProxyOpencodeToolDefs` v0.27.1 Zeile 1443 |
| Runtime-only MCP-Server (mcp-tools / `nvim-tools`) | **keine Entsprechung**; Layer-5-Overlay in `mcp-bridge.ts` ueberlagert nur Disk-Server | `git show v0.27.1:src/mcp-bridge.ts` ~Zeile 550 |
| Request-Exposure-Gate, Caller-Context-Validierung, vendored Workstream-Vertrag v1.6 | keine Entsprechung; fachliche Pruefung liegt aber ohnehin nativ in `~/.config/opencode/plugins/oc-hooks.ts` (nutzt `context.agent`/`context.sessionID`) | `oc-hooks.ts` Zeilen ~301–540 |
| Proxy-Runtime-Hint im System-Prompt | keine Entsprechung; Komfort, nicht tragend | lokaler Diff `claude-code-language-model.ts` |

Registry-Check live (opencode Port 4096): `submit_plan`,
`repo_policy_scope`, `workstream_manage`, `change_regime` sind als native
Tools registriert, also fuer `proxyOpencodeTools` erreichbar.

Nutzung laut `plugin.log` + `plugin.log.1`: `submit_plan` 209,
`repo_policy_scope` 260, `workstream_manage` 221 Calls; runtime MCP
`nvim-tools` 211 Proxy-Logzeilen (28 Tools), alle am 2026-09-22.

## Zentraler offener Punkt: mcp-tools-Anbindung

Begriffe: Plugin `mcp-tools.nvim` (lokaler Fork
`/home/heiko/repos/nvim_plugins/mcp-tools.nvim`, lazy-Name
`mcp-tools-local`) registriert sich bei opencode als MCP-Server namens
`nvim-tools`. Registrierung per `<leader>kt` / `<leader>km` aus
`~/.config/nvim/lua/plugins/ai/opencode.lua` (Status-Check ab Zeile ~376
per `curl <url>/mcp`, Schluessel `nvim-tools`). SSOT laut Kommentar:
`/home/heiko/.config/nvim/OPENCODE_NAMESPACE_SSOT.md` (Abschnitt MCP
Integration). Weitere Doku im Fork: `LOCAL_PATCHES.md`,
`NEOVIM-MCP-TOOLS.md`, `opencode.jsonc`, `bridge/`.

Warum zentral: Der Server existiert nur zur Laufzeit im opencode-Prozess,
nicht in `opencode.jsonc`. Lokale Variante (`b3b9218`, `53524f2`) liest
solche Server aus dem Request-Tool-Set und proxied sie. Upstream bridged nur
Disk-Server, `proxyOpencodeMcpTools` discovert zwar aus dem Model-Tool-Set,
filtert aber auf aktivierte Disk-Server-Namen. Ergebnis ohne Loesung: in
nvim-gestuetzten opencode-Sessions fehlen die 28 nvim-Tools unter
claude-code-Modellen.

Zu klaeren in der Folgesession:

1. Wie genau registriert mcp-tools bei opencode (Endpoint, Payload,
   `local` mit Command vs. `remote` mit URL, dynamischer Port/Socket pro
   nvim-Instanz)? Quellen: `opencode.lua` ab ~Zeile 366, Fork `bridge/`,
   `OPENCODE_NAMESPACE_SSOT.md`.
2. Ist das Startkommando statisch genug fuer einen Disk-Eintrag in
   `opencode.jsonc` (dann reicht Upstream mit `proxyOpencodeMcpTools`)?
   Achtung: mehrere nvim-Instanzen (`nvim-tools-nvim`, `-heiko`,
   `-isolier_stoesse_tp` in `~/.claude.json`) deuten auf instanzgebundene
   Namen hin.
3. Falls nicht statisch: Upstream-PR an Khalil fuer Runtime-only-Server
   (Maintainer absorbiert Fork-Arbeit laut Upstream-AGENTS.md aktiv), oder
   minimale lokale Patch-Schicht nur dafuer.
4. Pruefen, ob Upstream-`proxyOpencodeMcpTools` einen Runtime-Server
   ueberhaupt im Model-Tool-Set sieht (Namen `nvim-tools_<tool>`), und ob
   nur der Server-Namensfilter blockiert. Das waere der kleinste PR.

## Weitere offene Punkte

- **submit_plan-Deadline:** Upstream-Default fuer forwardete Tools ist
  10 min (`resolveProxyCallTimeoutMs`); Plannotator-Reviews dauern laenger.
  Voraussichtlich `proxyToolTimeoutMs: { submit_plan: 0 }` oder hoher Wert
  noetig. Wirkung von `0` = keine Deadline, Heartbeat-WARN alle 5 min.
- **Live-Test Pflicht vor Umschalten:** Plan einreichen, >15 min im
  Plannotator liegen lassen, Approval muss zurueckkommen;
  `repo_policy_scope` und `workstream_manage list` einmal ueber claude-code.
- **Exposure-Gate-Verlust bewerten:** Ob der lokale Request-Scope-Gate
  sicherheitsrelevant ist oder nur Defense-in-Depth (native Checks in
  `oc-hooks.ts` bleiben). Falls sicherheitsrelevant: Plan-first, kein
  Planaufschub.
- **Paketquelle:** npm-Paket mit Aikido-Befund (Upstream-Commit `3ef1908`
  "Correct the npm diagnosis: it was Aikido") vor Umstellung pruefen; nach
  Umstellung Cache `~/.cache/opencode/packages/...@latest` leeren.
- **opencode 2 (`V2.md` upstream):** V1-Plugins laufen dort nicht; Upstream
  bereitet Dual-Support vor. Staerkstes Argument gegen weiteren Fork-Drift.
- **~/.claude-Spiegel:** unabhaengig vom Plugin-Rueckbau.
  `~/.claude/CLAUDE.md` (284 Zeilen Mirrors) wird auch in claude-code-
  Provider-Sessions geladen (dieser Session-Kontext zeigt es), also
  doppelter Kontext neben AGENTS.md. Native `ccp`-Nutzung laut
  `~/.claude/history.jsonl` seit 2026-09-10 fast nur Test-/Exit-Eintraege.
  Plannotator-Fork (`apps/hook` nativ, `apps/opencode-plugin` fuer
  opencode) ist vom Plugin-Rueckbau nicht betroffen. Separate Frage.
- **Agent-Sync stale:** `~/.claude/agents` zuletzt 2026-09-03, OpenCode-
  Agents bis 2026-09-16 geaendert; Sync-Script unter `~/.claude/scripts`
  nicht gefunden. Nur melden, nicht Teil dieses Rueckbaus.

## Vorgeschlagene Reihenfolge fuer Folgesession

1. mcp-tools-Registrierungsweg klaeren (Punkte 1–4 oben), read-only.
2. Entscheidung: Disk-Eintrag, Upstream-PR oder Mini-Patch.
3. Migrationsplan mit Change-Impact-Matrix (Config-Keys `proxyTools`,
   `proxyOpencodeTools`, `proxyToolTimeoutMs`, Plugin-Quelle,
   `strictMcpConfig`) via `submit_plan`.
4. Live-Test in Scratch-Config (`XDG_CONFIG_HOME`, `plugin ready` genau
   einmal im Log).
5. Umstellung, danach lokalen Clone archivieren (Branch behalten, nicht
   loeschen).

## Fortsetzungs-Prompt

> Lies `docs/exports/upstream-rueckbau-lokaler-clone-handover-2026-09-24.md`
> im Repo opencode-claude-code-plugin. Klaere read-only, wie mcp-tools.nvim
> seinen MCP-Server `nvim-tools` bei opencode registriert und ob
> Upstream v0.27.1 (`proxyOpencodeMcpTools` / Bridge) ihn ohne lokalen
> Patch erreichen kann. Danach Empfehlung: Disk-Eintrag, Upstream-PR oder
> Mini-Patch. Keine Aenderung ohne genehmigten Plan.
