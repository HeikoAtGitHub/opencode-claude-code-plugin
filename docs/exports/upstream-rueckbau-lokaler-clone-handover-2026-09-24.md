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

## Nachtrag 2026-09-24: mcp-tools-Klaerung und Live-Probe

### Registrierungsweg (read-only geklaert)

- `mcp-tools.nvim/lua/mcp-tools/integrations/opencode.lua:71-95`:
  `POST <opencode-url>/mcp` mit
  `{name:"nvim-tools", config:{type:"remote", url:"http://127.0.0.1:<port>", headers:{Authorization:"Bearer <token>"}}}`.
- Port ephemer (`MCP_PORT=0`, `bridge.lua:203`), Bridge an je eine
  nvim-Instanz gebunden; Token pro Start rotierend (opencode-Pfad).
- Ausloeser: `<leader>kt`/`<leader>km` → `opencode_register_mcp` →
  `McpToolsRegisterOpencodeVdyk`, erst wenn opencode laeuft.
- Voller Disk-Eintrag mit echter URL daher nicht moeglich.
- Upstream-Blocker (Code): `resolveMcpProxyToolDefs` matcht korrekt auf
  `nvim-tools_*`, aber Servernamen stammen nur aus Disk-Config; Layer-5-
  Overlay (`mcp-bridge.ts:550-563`) iteriert nur Disk-Namen.

### Loesungsweg ohne Code: deaktivierter Disk-Platzhalter

```jsonc
"mcp": {
  "nvim-tools": { "type": "remote", "url": "http://127.0.0.1:1", "enabled": false }
}
```

plus Provider-Optionen `proxyOpencodeMcpTools: true`,
`bridgeOpencodeMcp: true`, `strictMcpConfig: true`.

Mechanik: Platzhalter liefert den Namen fuer den Filter, `POST /mcp` von
nvim ersetzt ihn in opencode zur Laufzeit, Overlay setzt ihn bei
`connected` auf enabled, Proxy routet `nvim-tools_*` ueber opencode (das die
echte dynamische Verbindung haelt). Platzhalter-URL geht nicht an Claude,
solange der Proxy den Server abdeckt.

### Live-Probe (verifiziert, Scratch-Umgebung)

Aufbau: Upstream v0.27.1 per `git archive` nach `/tmp/ocprobe`, gebaut;
`opencode serve` 1.18.32 mit Scratch-`XDG_*` und **ohne** vererbtes
`OPENCODE_CONFIG_DIR` (sonst laedt der lokale Clone mit: `plugin ready`
zweimal); `plugin ready` genau einmal (0.27.1). Headless nvim mit
mcp-tools + nvim-dap, echte Bridge, Registrierung mit exakt dem
mcp-tools-Payload; Modell `claude-code/claude-haiku-4-5`.

| Schritt | Ergebnis |
|---|---|
| Platzhalter `enabled:false` | opencode-Status `disabled`; Modell sieht keine nvim-Tools |
| `POST /mcp` (echte URL + Token) | HTTP 200, `connected`; Platzhalter ersetzt, nicht abgelehnt |
| Folgeturn in vorher gestarteter Session | Respawn `opencode MCP config changed, respawning claude` (Status-Wechsel aendert Hash) |
| frische Session | `routing opencode MCP tools through the proxy` (22 Tools), `--strict-mcp-config`, `proxy-mcp tool call received nvim-tools_nvim_dap_status` |
| Tool-Resultat | `{"active": false, "message": "No active debug session", "agent_takeover": false}` |

Ergebnis: Upstream ohne lokalen Clone erreicht dynamischen nvim-DAP-Server
fuer claude-code-Modelle, geroutet ueber opencode.

Offene Grenzen:

- Erste Test-nvim hatte 0 Tools (nvim-dap unter `--clean` nicht geladen,
  `pcall(require)` still). Dann lieferte opencode keine `nvim-tools_*`, das
  Plugin bridgte den Server direkt mit Platzhalter-URL an Claude → Timeout,
  `failed`. Risiko real: registriert nvim, bevor Tools geladen sind, erbt der
  respawnte Prozess den kaputten Direktweg bis zur naechsten neuen Session.
- Re-Registrierung mit neuem Port bei bereits `connected` erzeugt keinen
  Respawn. Im Proxy-Fall unkritisch (URL nur in opencode), plausibel, aber
  nicht direkt verifiziert.
- `proxyOpencodeTools` fuer `submit_plan`/`repo_policy_scope`/
  `workstream_manage` in dieser Probe nicht getestet.
- Keine Nebenwirkung: mcp-tools-Integrationen default `false`,
  `~/.claude.json` ohne `ocprobe`-Eintrag. Dort nur `nvim-tools-<slug>`
  (claudecode-Integration, feste Ports 99xx), durch `strictMcpConfig`
  neutralisiert. Scratch-Prozesse beendet, `/tmp/ocprobe` verbleibt.

Konsequenz fuer Reihenfolge: Punkt 1–2 der Folgesession erledigt;
Entscheidung = Disk-Platzhalter, Upstream-PR nur optional (Komfort:
Runtime-Server ohne Platzhalter; Guard gegen Direkt-Bridge mit
Platzhalter-URL waere sinnvoller PR-Inhalt).

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
- **Alternative ianjwhite99/opencode-with-claude:** Offene Frage, noch nicht
  analysiert: Was wuerde sich bei Umstieg auf
  <https://github.com/ianjwhite99/opencode-with-claude> aendern, und ist das
  ueberhaupt eine gangbare Option? Vergleichsachsen fuer die Folgesession:
  Transport (CLI-Wrapper vs. anderer Weg), Abrechnung/Account-Modell,
  Weiterleitung nativer opencode-Tools (`submit_plan`, `repo_policy_scope`,
  `workstream_manage`), MCP-Anbindung inkl. Runtime-Server `nvim-tools`,
  Plannotator-Flow, Wartungsstand und opencode-2-Kompatibilitaet.
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

Aktualisiert nach Nachtrag 2026-09-24:

> Lies den Handover inkl. Nachtrag. mcp-tools-Frage ist per Live-Probe
> geklaert (Disk-Platzhalter). Naechster Schritt: Migrationsplan mit
> Change-Impact-Matrix (Plugin-Quelle, `proxyTools` → `proxyOpencodeTools`,
> `proxyToolTimeoutMs.submit_plan`, `strictMcpConfig`, Platzhalter
> `nvim-tools`), vorher Live-Probe fuer `submit_plan` (>15 min),
> `repo_policy_scope`, `workstream_manage list` in Scratch-Config.
