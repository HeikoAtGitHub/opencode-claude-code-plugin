---
artifact_type: handover
implementation_authority: none
next_session_requires_plan: true
source_plan_title: Claude-Code Proxy-Respawn reparieren_T_proxy-respawn-mcp-erhalt
repo: opencode-claude-code-plugin
branch: local/submit-plan-proxy
head_at_export: d627562
created: 2026-09-02
---

# Claude-Code Proxy-Respawn reparieren — Handover_T_proxy-respawn-mcp-erhalt

## Zweck und Status

Dieses Handover dokumentiert einen reproduzierbaren Verlust des
`opencode_proxy`-MCP bei Claude-Code-Resume-Prozessen. Es autorisiert keine
Implementierung und ersetzt keinen genehmigten Plan.

Diagnosestatus: Root Cause durch produktive Session- und Plugin-Logs sowie
aktuellen Quellcode belegt. Code wurde nicht geaendert. Tests wurden nicht
ausgefuehrt.

## Nutzersichtbares Symptom

Nach anfangs funktionierenden Proxy-Aufrufen meldet Claude innerhalb derselben
OpenCode-Session:

> OpenCode-Proxy ist gerade wieder getrennt — submit_plan momentan nicht
> verfuegbar.

Betroffen sind alle ueber `opencode_proxy` transportierten Tools, insbesondere
`submit_plan`, `workstream_manage`, `bash`, `edit`, `write`, `webfetch` und
`task`. Claude-native Read-/Glob-Pfade koennen weiter erscheinen, wodurch der
Fehler wie eine partielle Permission- oder Toolfreigabe-Stoerung wirkt.

## Verifizierte Log-Evidenz

Primaerlog:

`~/.local/share/opencode-claude-code/plugin.log`

Produktive Session:

`ses_f9ede3cabffeKD6BzcoZpPc1O7`

Relevante Sequenz am 2. September 2026:

1. Erststart `plugin.log:16013-16015`: Proxy-MCP-Server startet. Der
   Claude-Aufruf erhaelt unter `--mcp-config` sowohl
   `mcp-c6677169fa5a.json` als auch `proxy-93d9a9826eb7.json`.
2. `plugin.log:16109`: `system prompt changed, respawning claude`.
3. `plugin.log:16110`: alter Claude-Prozess endet mit Code 143. Das ist der
   absichtliche Respawn, kein ungeplanter Absturz.
4. `plugin.log:16112`: Resume-Aufruf enthaelt nur noch
   `mcp-c6677169fa5a.json`. Die `proxy-*.json` fehlt.
5. Session-Inhalt 10:19-10:20 lokal: Claude erkennt danach
   `workstream_manage`, `submit_plan`, Proxy-Bash und weitere Proxytools als
   nicht verfuegbar.
6. Dasselbe wiederholt sich `plugin.log:16300-16303`: erneuter
   Systemprompt-Respawn, erneut Resume ohne `proxy-*.json`.

Gesamtauswertung des aktuellen Logs:

- 11 Treffer `system prompt changed, respawning claude`;
- 11 zugehoerige Resume-Spawns ohne `proxy-*.json`;
- 0 zugehoerige Resume-Spawns mit `proxy-*.json`.

Der bekannte 296- bis 300-Sekunden-Idle-Timeout ist ein separater Befund. Er
erklaert diese konkrete Sequenz nicht: Hier zeigt das Log einen expliziten
Systemprompt-Refresh und kontrollierten Prozesswechsel.

## Root Cause im aktuellen Code

Owner:

`src/claude-code-language-model.ts`

Kausalkette:

1. `effectiveMcpConfig()` fuegt einen vorhandenen `proxyConfigPath` korrekt
   der MCP-Pfaddliste hinzu (`:939-965`).
2. Spawn-Vorbereitung erzeugt bzw. aktualisiert den Proxyserver vor der
   Systemprompt-Hash-Pruefung (`:2616-2635`).
3. Bei veraendertem Systemprompt wird der aktive Prozess geloescht und lokal
   `proxyServer = null` gesetzt (`:2664-2685`).
4. Direkt danach baut `effectiveMcpConfig()` die neue CLI-Konfiguration aus
   `proxyServer?.configPath()` (`:2701-2706`). Wegen des gerade gesetzten
   `null` fehlt der Proxy-Pfad.
5. Es gibt zwischen dem Nullsetzen und `buildCliArgs()`/`spawnClaudeProcess()`
   keinen erneuten `ensureProxyServer()`-Schritt (`:2707-2749`).

Damit entsteht der Resume-Prozess mit deaktivierten Claude-Builtins, aber ohne
den vorgesehenen Proxy-MCP. Ein spaeter gestarteter Proxyserver hilft dem
bereits laufenden Claude-Prozess nicht, solange dessen `--mcp-config` diesen
Server nicht enthaelt.

## Abgrenzung zu vorhandener Respawn-Logik

`src/session-manager.ts::respawnActiveProcess()` (`:306-374`) behandelt den
Start-Watchdog-Pfad. Dieser Pfad verwendet bereits gebaute `cliArgs` weiter und
erhaelt dadurch darin eingebettete MCP-/Proxy-Pfade.

Der Fehler liegt dagegen im Systemprompt-Refresh-Pfad von `doStream`: Dort
wird der alte Prozess samt Proxyserver verworfen und die CLI-Argumentliste neu
gebaut, ohne vorher den Proxyserver wiederherzustellen.

`test-respawn.ts` prueft derzeit nur `appendResumeIfNeeded()` und den
Undefined-Zweig von `respawnActiveProcess()`. Der fehlerhafte
Systemprompt-Refresh mit realer MCP-Pfad-Neubildung ist nicht abgedeckt.

## Minimaler Umsetzungsscope

Voraussichtliche Owner-Dateien:

- `src/claude-code-language-model.ts`
- passender fokussierter Regressionstest; bevorzugt bestehendes
  `test-respawn.ts` oder ein bereits passender doStream-/Proxy-Test
- `package.json` nur falls eine neue Testdatei angelegt wird, da Tests dort
  explizit aufgelistet werden
- `AGENTS.md`/`README.md` nur wenn Verhalten oder Maintainer-Gotcha dauerhaft
  dokumentiert werden soll

Zielinvariante:

> Jeder nicht-interaktive Respawn, der Proxytools exponiert, startet mit einer
> gueltigen, zur neuen Proxyserver-Instanz gehoerenden `proxy-*.json` in
> `--mcp-config`; `--disallowedTools` darf Proxy-Builtins nicht sperren, wenn
> die Ersatztools nicht im gestarteten Prozess erreichbar sind.

Kleinste robuste Richtung:

1. Nach jedem Refresh, der `proxyServer = null` setzt, vor
   `effectiveMcpConfig()` den Proxyserver aus `combinedProxyTools` erneut
   sicherstellen; oder Reihenfolge so kapseln, dass Proxyserver-Erzeugung und
   kombinierter MCP-Argumentbau atomar fuer jeden Spawn erfolgen.
2. Keine Sonderkorrektur nur fuer `submit_plan`: alle Proxytools teilen
   denselben Owner und muessen gemeinsam erhalten bleiben.
3. Fail-closed pruefen: Wenn Proxyserver-Erzeugung fehlschlaegt, nicht mit
   deaktivierten Builtins und fehlenden Ersatztools weiterstarten.

## Change-Impact und Tests

Betroffene Vertraege:

- CLI-Argumentbau und `--mcp-config`-Reihenfolge;
- Proxyserver-Lifecycle und Cleanup;
- Claude-Session-Resume;
- Systemprompt-Hot-Refresh;
- MCP-Hot-Reload und Proxy-Exposure-Refresh auf gleichartige Reihenfolge
  pruefen;
- `submit_plan`- und `workstream_manage`-Erreichbarkeit nach Refresh.

Testklassifikation:

- `new-regression`: Systemprompt-Hash-Wechsel mit aktivem Proxy erzeugt
  Resume-CLI-Args inklusive neuem Proxy-Konfigpfad.
- `invariant`: Start-Watchdog-Respawn behaelt vorhandene CLI-Args und
  `--resume`-Semantik.
- `invariant`: Cleanup schliesst alten Proxyserver genau einmal und laesst
  keinen verwaisten Broker-/HTTP-Zustand zurueck.
- `new-regression`: Fehler bei Proxy-Neuerzeugung startet keinen Prozess mit
  gesperrten Builtins ohne Ersatztools.
- `evidence-only`: produktiver Smoke provoziert Systemprompt-Refresh und ruft
  danach `workstream_manage` oder ein unschaedliches Proxytool auf.

Empfohlene Verifikation:

1. fokussierter neuer Regressionstest;
2. `npm run typecheck`;
3. `npm test`;
4. `npm run build` und Dist-Verifikation gemaess Repo-Vertrag;
5. realer OpenCode-Smoke mit Claude-Code-Provider:
   Proxytool vor Refresh aufrufen, Systemprompt-/Repo-Scope-Refresh ausloesen,
   dasselbe Proxytool danach erneut erfolgreich aufrufen;
6. Log pruefen: jeder zugehoerige Resume-Spawn enthaelt `proxy-*.json`.

## Offene Punkte

- Systemprompt-Hash-Aenderungen treten haeufig durch request-/scope-abhaengige
  Prompt-Inhalte auf. Der Fix darf notwendige Refreshes nicht pauschal
  deaktivieren.
- Proxy-Exposure- und MCP-Hot-Reload-Pfade setzen ebenfalls Prozess und
  Proxyserver zurueck. Beide gegen denselben Verlustmechanismus pruefen.
- Den separaten Idle-Timeout-Befund nicht still als mitbehoben deklarieren.
- Kein Erfolgsclaim ohne realen Post-Refresh-Proxyaufruf im produktiven
  OpenCode→Claude-Code-Pfad.

## Fortsetzungs-Prompt

Arbeite im Repo `/home/heiko/repos/opencode-claude-code-plugin` auf dem bewusst
gewaehlten Branch/Worktree. Lies zuerst `AGENTS.md` und dieses Handover. Fuehre
SSOT-, Repo-Overlay-, Permission-, Worktree- und Change-Impact-Checks erneut
aus. Erstelle danach einen neuen Plan mit Titel
`Claude-Code Proxy-Respawn reparieren_T_proxy-respawn-mcp-erhalt`.

Behebe zentral den Verlust der `proxy-*.json` beim Systemprompt-, Proxy-
Exposure- und MCP-Hot-Refresh. Nutze keinen `submit_plan`-Sonderpfad. Sichere
CLI-Argumentbau, Proxyserver-Lifecycle, Resume und Fail-closed-Verhalten durch
Regressionstests. Fuehre danach Typecheck, gesamte Tests, Build und einen realen
OpenCode-Claude-Code-Smoke mit Proxytool-Aufruf vor und nach erzwungenem
Systemprompt-Refresh aus. Idle-Timeout separat behandeln und nicht als durch
diesen Fix geloest behaupten.
