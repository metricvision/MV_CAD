# MV_CAD: neue Ordnerstruktur

Ausgangspunkt: Commit `b8f36f891552950614c5dc306487bd9071cf9954` von
`https://github.com/metricvision/MV_CAD`, einschließlich der bereits gewünschten
Entfernung der defekten Dokumentationslinks aus der README.

## Was du machen musst

Du musst keinen Code einfügen oder einzelne Dateien zusammensuchen.
Die ZIP enthält das vollständige Projekt im Ordner `MV_CAD`.

1. Beende den bisherigen CAD-Server mit **Strg+C** und sichere den bisherigen
   Projektordner. Speichere eine offene Baugruppe bei Bedarf als JSON.
2. Entpacke die ZIP zunächst in einen separaten Ordner. Nicht einfach über den
   alten Ordner entpacken: Dabei würden die verschobenen Dateien zusätzlich am
   alten Ort liegen bleiben.
3. Falls du die gemeinsamen Projekte übernehmen möchtest, kopiere den Ordner
   `.metriccad` aus der bisherigen Installation in den neuen `MV_CAD`-Ordner.
   Er enthält auch den bisherigen Undo-/Redo-Verlauf. Bei einem eigenen
   `--data-dir` oder `METRICCAD_DATA_DIR` verwende weiterhin denselben Datenordner.
   Es darf nur ein Server gleichzeitig auf diesen Datenordner zugreifen.
4. Falls du eigene Modellierungsvorgaben eingetragen hast, kopiere den Inhalt
   deiner bisherigen `modeling_preferences.json` nach
   `config/modeling_preferences.json`.
5. Richte im neuen Projektordner die Python-Umgebung wie in der README ein und
   starte anschließend wie bisher `python app.py` mit diesem Python.
   Die Abhängigkeiten in `requirements.txt` sind unverändert.

Die Oberfläche bleibt unter `http://127.0.0.1:8765` erreichbar. Verwende denselben
Browser und dieselbe Adresse einschließlich Port, damit auch die bisher im
Browser gespeicherte Baugruppe verfügbar bleibt. Exportierte Teil- und
Baugruppen-JSON-Dateien können wie bisher geöffnet werden.

`app.py` und `mcp_server.py` bleiben im Hauptordner. MCP wird inzwischen über
„MCP starten“ in der Projektleiste aktiviert und über „MCP stoppen“ beendet.
Ersetze den bisherigen MCP-Client-Eintrag mit Python-Pfad und Startbefehl durch
die URL-Konfiguration aus `integrations/codex-mcp.example.toml`.
Standardadresse: `http://127.0.0.1:8766/mcp`. Der Client muss auf demselben Rechner
laufen. Der frühere stdio-Startweg entfällt; das CAD-Programm verwaltet den
MCP-Prozess und reicht auch einen eigenen Datenordner automatisch weiter.

## Was geändert wurde

Es wurden Dateien verschoben, notwendige Python-Imports und Dateipfade angepasst
und die Inhalte der bisherigen Inline-JavaScript- und CSS-Blöcke ausgelagert.
Die Funktionskörper, Berechnungen, Beschriftungen, CSS-Regeln und JavaScript-Logik
wurden nicht umgeschrieben. JavaScript bleibt ein klassisches Skript mit derselben
Ausführungsreihenfolge; es wurden keine ES-Module oder neuen Laufzeitabhängigkeiten
eingeführt.

Die vorhandenen CAD-HTTP-Adressen, Projektformate, Standard-Datenpfade
und MCP-Werkzeugnamen bleiben erhalten. Der oben beschriebene MCP-Startweg ersetzt
die frühere Client-Prozesskonfiguration. Für die ausgelagerten Inhalte sind nur
die beiden zusätzlichen Ressourcen `/part_studio.js` und `/part_studio.css`
hinzugekommen.

| Bisher | Jetzt |
|---|---|
| `app.py`, `mcp_server.py` | Unverändert im Hauptordner; nur Imports und Ressourcenpfade angepasst |
| `cad_service.py`, `cad_schema.py` | `backend/` |
| `engine.py`, `sketches.py`, `sweeps.py` | `backend/geometry/` |
| `dimension_layout.py`, `cad_preview.py` | `backend/geometry/` |
| `assembly.py`, `assembly_parts.py`, `assembly_solver.py` | `backend/assembly/` |
| `index.html`, `assembly.html` | `frontend/` |
| JavaScript in `index.html` | `frontend/js/part_studio.js` |
| CSS in `index.html` | `frontend/css/part_studio.css` |
| `assembly.js`, `project_sync.js` | `frontend/js/` |
| `assembly.css`, `project_sync.css` | `frontend/css/` |
| `modeling_preferences.json` | `config/modeling_preferences.json` |
| `codex-mcp.example.toml` | `integrations/codex-mcp.example.toml` |
| `MODELING_GUIDE.md` | `docs/MODELING_GUIDE.md` |
| `tests/`, `examples/`, `docs/images/` | Bisherige Ordner beibehalten |

Die drei leeren `__init__.py`-Dateien kennzeichnen die neuen Python-Pakete.
README, Lizenzdateien sowie die üblichen GitHub-Dateien `CONTRIBUTING.md` und
`SECURITY.md` bleiben im Hauptordner.

## Prüfung

- Quelltextvergleich mit der Ausgangsversion: alle bisherigen Dateien vollständig
  erhalten; Unterschiede nur in den ausdrücklich angepassten Imports, Pfaden und
  HTML-Einbindungen. Ausgelagertes JavaScript und CSS sind inhaltlich identisch.
- 12 CAD-Service-Integrationstests bestanden.
- 2 MCP-/HTTP-Protokolltests bestanden, einschließlich echtem stdio-Aufruf.
- Vorhandener UI-Test mit jsdom und Software-Canvas bestanden: Laden,
  externe Änderungen, Maßdialog, verzögerter Neuaufbau, Konflikterhalt, Undo und
  erneutes Laden.
- Alle zehn HTML-/JavaScript-/CSS-Routen geprüft.
- Baugruppenbeispiel über HTTP aufgebaut, Schubgelenk angetrieben und STEP
  exportiert.
- Python- und JavaScript-Syntax geprüft.

Ein vollständiger Browser-/WebGL-Test und ein Screenshot-Vergleich konnten hier
nicht abgeschlossen werden: Der verfügbare Chromium-Prozess beendet sich beim
Start. Der UI-Test prüft Verhalten in einer DOM-Umgebung, nicht die Darstellung
in einem echten Browser. Eine uneingeschränkte visuelle Gleichheitsgarantie wird
deshalb nicht aus den Tests abgeleitet.

Die ZIP enthält keine Python-Umgebung, Testinstallationen, Zugangsdaten,
persönlichen Projekte oder Git-Historie.
