# MetricCAD – parametrisches CAD mit MCP

Ein Projekt der **MetricVision GmbH** · Repository: **MV_CAD**

MetricCAD ist ein lokal betriebenes CAD-Programm mit Browseroberfläche. Erstelle
bemaßte Skizzen und bearbeitbare 3D-Modelle von Hand oder steuere dieselben
Projekte mit einem MCP-Client wie Codex. Die Modellhistorie bleibt aus Skizzen
und Operationen wie Aufpolstern, Taschen, Rotation, Verrundung und Fase aufgebaut.

**Kostenlos nutzbar, auch gewerblich.** Der eigene Projektcode steht unter
[Apache 2.0](LICENSE). Für externe Bibliotheken gelten deren eigene Lizenzen;
siehe [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

**Entwicklungsstand:** frühe Version für Tests und Rückmeldungen. Aktuelle
Einschränkungen und bisherige Prüfungen stehen weiter unten.

## MetricVision GmbH

Für die Nutzung von MetricCAD ist kein Dienstleistungsvertrag erforderlich.
Die MetricVision GmbH bietet auf Anfrage kostenpflichtige Einrichtung,
individuelle Erweiterungen und Automatisierungen für betriebliche CAD-Abläufe an.

Kontakt für Anfragen: [office@metricvision.at](mailto:office@metricvision.at).

## Rückmeldungen und Tests

Fehler und Verbesserungsvorschläge können über die
[GitHub Issues](https://github.com/metricvision/MV_CAD/issues) gemeldet werden.
Hilfreich sind Betriebssystem, Python-Version, genaue Schritte und ein kleines,
öffentlich teilbares Beispiel. Bitte keine Kundendaten, Zugangsdaten oder den
Ordner `.metriccad` hochladen. Für Beiträge siehe [CONTRIBUTING.md](CONTRIBUTING.md),
für vertrauliche Sicherheitsmeldungen [SECURITY.md](SECURITY.md).

## Installation und Start

Empfohlen: **Python 3.12, 64 Bit**, sowie ein Browser mit WebGL-Unterstützung.
Für die MCP-Nutzung wird zusätzlich ein separat installierter MCP-Client benötigt.

Das Repository klonen oder über **Code → Download ZIP** herunterladen und
vollständig entpacken. Ein Terminal im Ordner öffnen, der `app.py` und
`requirements.txt` enthält. Die folgenden Befehle dort ausführen.

Windows (PowerShell):

```powershell
py -3.12 -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe app.py
```

macOS / Linux:

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python app.py
```

Der Browser öffnet `http://127.0.0.1:8765`. Der Server muss laufen, während Codex
das CAD verwendet. Der CAD-Server selbst benötigt keinen OpenAI-API-Schlüssel.

Ein bereits belegter Port lässt sich mit `python app.py --port 0` umgehen. Die
MCP-Anbindung findet den gewählten Port über die Verbindungsdatei automatisch.
`--no-browser` verhindert das automatische Öffnen des Browsers.

## Mit lokalem Codex verbinden

Voraussetzung ist eine separat installierte und angemeldete **Codex CLI**.
`pip install mcp` installiert die Python-MCP-Bibliothek, nicht die Codex CLI.
Die aktuelle Installation ist in der
[offiziellen Codex-Anleitung](https://developers.openai.com/codex/cli) beschrieben.
Codex oder ein verwendeter KI-Dienst kann eigene Nutzungsgebühren haben; diese
sind nicht Bestandteil von MetricCAD.

Wenn `codex --version` funktioniert, in einem zweiten Terminal einmalig
registrieren. **Absolute Pfade ersetzen**:

```bash
codex mcp add metriccad -- /ABSOLUTER/PFAD/MV_CAD/.venv/bin/python /ABSOLUTER/PFAD/MV_CAD/mcp_server.py
```

Unter Windows entsprechend:

```powershell
codex mcp add metriccad -- "C:\PFAD\MV_CAD\.venv\Scripts\python.exe" "C:\PFAD\MV_CAD\mcp_server.py"
```

Danach mit `codex mcp list` kontrollieren, `codex` starten und bei Bedarf
mit `/mcp` die Verbindung prüfen. `app.py` dabei weiterlaufen lassen. Eine
TOML-Alternative mit längerer Werkzeug-Laufzeit findest du in
`codex-mcp.example.toml`.

Ein erster Auftrag an Codex:

> Verwende MetricCAD. Erstelle ein neues Projekt mit einer 80 × 50 × 8 mm großen
> Grundplatte und vier Bohrungen Ø6 mm, jeweils 10 mm von den Rändern entfernt.
> Verwende vollständig bestimmte Skizzen, sinnvolle Bedingungen und übersichtliche
> Bemaßung. Prüfe die 3D- und Skizzenvorschauen und gib mir den Projektlink.

Zum Weiterarbeiten am bereits geöffneten Projekt dessen Projekt-ID aus der
Browseradresse nennen, oder Codex über `list_projects` das passende Projekt
auswählen lassen. Die Browseroberfläche bietet dafür auch eine Projektauswahl.

Die fertige Beispielplatte liegt unter `examples/plate_with_holes.json` und lässt
sich mit **Öffnen** importieren. Alternativ erzeugt
`python examples/build_plate.py` sie im laufenden Server.

## Bedienung und gemeinsamer Zustand

- Erfolgreiche Bearbeitungen werden automatisch gespeichert. **Speichern** lädt
  zusätzlich eine portable native JSON-Datei herunter.
- Der Projektbalken zeigt an, ob lokale Änderungen noch offen sind. Bei einem
  Serverfehler bleiben sie als lokaler Entwurf erhalten.
- Änderungen von Codex erscheinen in einem untätigen Projektfenster automatisch.
  Laufende Zeichenaktionen und Maßdialoge werden dabei nicht überschrieben.
- Bei gleichzeitigen Änderungen bleibt der lokale Entwurf erhalten. Du kannst
  ihn herunterladen, als neues Projekt sichern oder den Serverstand laden.
- Rückgängig/Wiederherstellen verwendet die gemeinsame Historie von Oberfläche
  und MCP. Es werden bis zu 60 Zustände pro Richtung aufbewahrt.
- Während einer Skizzenbearbeitung kann der vollständige Körperaufbau bewusst
  ausstehen. Beim Wechsel zu 3D wird er berechnet.
- Baugruppen und die vorhandenen verknüpften Part-Design-Tabs behalten ihren
  bisherigen Ablauf. Sie werden nicht mit einem anderen Part-Studio-Projekt
  vermischt.

Die Daten liegen standardmäßig im Ordner `.metriccad` neben dem Programm.
`python app.py --data-dir /anderer/ordner` wählt einen anderen Datenordner. Dann
den MCP-Start um `--connection-file /anderer/ordner/connection.json` ergänzen.
Den **projects**-Unterordner regelmäßig sichern. Nicht während des Betriebs von
Hand bearbeiten. Die Datei `connection.json` enthält eine lokale Sitzungskennung;
sie gehört nicht in geteilte Projektdateien.

## Bemaßungsstil

`modeling_preferences.json` enthält die Regeln, die Codex über
`get_capabilities` liest: Ursprung, Rand-/Mittelpunktbezüge, Gleichheits- und
Spiegelbedingungen, Namen und Prüfablauf. Diese Regeln kannst du anpassen.

Neue Maße ohne explizite Position werden automatisch angeordnet. Von Hand
verschobene Maße bleiben bei späteren Parameteränderungen an ihrer Position.
Codex kann mit `layout_dimensions(force=true)` ausdrücklich neu anordnen.
Die Anordnung verändert keine Maßwerte und keine Bedingungen.

Die funktionale Auswahl der Maße erfolgt durch Codex anhand deines Auftrags.
Der Solver prüft die Bedingungen; die Layoutfunktion platziert die Beschriftungen.
Bei sehr dichten Skizzen oder kleinen Fenstern kann manuelles Nacharbeiten nötig
sein. `get_preview` liefert auch ohne geöffneten Browser bemaßte PNG-Ansichten.

## Enthaltene Funktionen

Projekte lesen/erstellen/importieren; Skizzen erstellen/bearbeiten; Maße und
Featureparameter ändern; stabile Referenzen abfragen; Aufpolstern, Taschen,
Rotationen, Verrundungen, Fasen, Helices und Sweeps; Maßanordnung;
Modellprüfung; 3D-/Skizzenvorschauen; Undo/Redo; JSON-/STEP-/STL-Export.

Die MCP-Werkzeuge kontrollieren in dieser Version **Einzelteile**. Die bisherige
Baugruppenoberfläche bleibt enthalten; eigene MCP-Werkzeuge für Gelenke und
Baugruppen sind nicht Bestandteil dieser Version. Es gelten die bisherigen
Geometriegrenzen, etwa maximal 50 Features und die Einschränkungen bei
Verrundungen/Sweeps. Technische Zeichnungsblätter mit Ansichten und Schriftfeld
sind ebenfalls nicht Teil dieser Skizzenanbindung.

## Architektur

| Datei | Aufgabe |
|---|---|
| `app.py` | Lokaler Webserver, Sitzungsprüfung, gemeinsame CAD-Ausführung |
| `cad_service.py` | Projekte, Transaktionen, Revisionen, Historie und Exporte |
| `cad_schema.py` | Strukturierte, validierte Werkzeugparameter |
| `mcp_server.py` | MCP-Adapter zum laufenden Server |
| `project_sync.js` / `.css` | Synchronisierung und Konflikthinweise in der Oberfläche |
| `dimension_layout.py` | Maßanordnung unter Erhalt manueller Positionen |
| `cad_preview.py` | Geometriebasierte PNG-Vorschauen ohne Browser |
| `MODELING_GUIDE.md` | Modellierregeln, Referenzschema und Arbeitsablauf für Codex |
| `engine.py`, `sketches.py`, `sweeps.py` | Bestehender CAD-Kern; Vorschauvernetzung arbeitet auf Kopien |

Der MCP-Adapter startet keinen zweiten Geometriekern. Er verbindet sich mit
`app.py`. Alle Berechnungen, einschließlich der bisherigen Baugruppenendpunkte,
werden wegen der globalen Engine-Caches innerhalb eines Prozesses serialisiert.
Eine zweite App-Instanz mit demselben Datenordner wird verhindert.

Die STDIO-Anbindung ist für lokales Codex gedacht. Optional startet
`python mcp_server.py --transport streamable-http --port 8766` einen MCP-Endpunkt
auf `127.0.0.1`. Für gehostetes Codex/ChatGPT im Browser ist zusätzlich eine
passende private Tunnel-/Plugin-Anbindung nötig; eine entfernte Sitzung kann
nicht direkt auf deinen lokalen Rechner zugreifen. Dieses Paket veröffentlicht
keinen Server im Internet.

## Prüfen

Mit installierten Python-Abhängigkeiten:

```bash
python -m unittest discover -s tests -p "test_*.py" -v
```

Die Tests berechnen echte CAD-Geometrie und prüfen unter anderem die vollständig
bestimmte Beispielplatte, Maßänderungen mit konstanten Randabständen,
Verrundungen/Fasen, Rotation und Sweep, fehlgeschlagene Transaktionen,
Versionskonflikte, Historie, Neustart, Exporte und das echte STDIO-MCP-Protokoll.

Die Synchronisierung der Oberfläche kann zusätzlich ohne Browser getestet werden:

```bash
npm install --no-save jsdom @napi-rs/canvas
node tests/ui_state_integration.cjs
```

Dieser Test führt die tatsächlichen Oberflächenskripte gegen den HTTP-Server aus.
Er prüft externe Änderungen, den Maßdialog, den abschließenden Körperaufbau,
Konflikterhalt, gemeinsames Rückgängig und erneutes Öffnen. Er ersetzt keine
Prüfung der Darstellung in einem echten Browser.

Der zusätzliche Browsertest benötigt Node.js, Playwright und Chromium:

```bash
npm install --no-save playwright
npx playwright install chromium
```

Danach `node tests/browser_integration.cjs` ausführen. Der Test verwendet `python`
aus der aktiven Umgebung; alternativ `METRICCAD_TEST_PYTHON` auf deren Python
setzen. Die Testserver verwenden freie Ports und eigene temporäre Datenordner.

Für die zugrunde liegende MCP-Projektfassung wurden die 14 Python-Integrationstests
und der Test der Oberflächenlogik erfolgreich ausgeführt; die erzeugten 3D- und Skizzen-PNGs
wurden visuell geprüft. Chromium konnte in der Ausführungsumgebung nicht
gestartet werden. Der vollständige Browsertest einschließlich WebGL ist deshalb
noch nicht verifiziert.

## Lizenz und Abhängigkeiten

Der eigene Projektcode wird unter der [Apache License 2.0](LICENSE)
veröffentlicht. Bei Weitergabe sind die einschlägigen Lizenz- und
Urheberrechtshinweise zu erhalten; siehe auch [NOTICE](NOTICE).

CadQuery, Open CASCADE, NumPy, SciPy, Pillow, Pydantic und das MCP SDK bleiben
unter ihren jeweiligen Lizenzen. Dieses Repository enthält keine mitgelieferte
Python-Umgebung und keine gebündelten Binärbibliotheken. Die Abhängigkeiten
werden über `pip` installiert. Die dokumentierte Lizenzübersicht und ihre
Grenzen stehen in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Das MCP SDK ist auf `1.30.0` festgelegt. Ein Wechsel auf die 2.x-Reihe erfordert
Anpassungen und erneute Tests; die Abhängigkeit deshalb nicht ungeprüft ersetzen.

Technische Referenzen: [Codex MCP](https://developers.openai.com/codex/mcp),
[MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk).
