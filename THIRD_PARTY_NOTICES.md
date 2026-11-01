# Externe Komponenten und Lizenzhinweise

Stand der Bestandsaufnahme: 1. November 2026.

Die Apache-Lizenz im Hauptverzeichnis bezieht sich auf den eigenen Projektcode
von MetricCAD. Sie lizenziert externe Bibliotheken nicht neu. Diese werden über
`pip` separat installiert; das Quellcodepaket enthält weder eine Python-Umgebung
noch Wheels, DLLs, Shared Libraries oder einen gebündelten Installer.

## Direkte Python-Abhängigkeiten

Die Versionsangaben entsprechen der vorhandenen Testumgebung. `requirements.txt`
enthält teilweise Versionsbereiche; eine neue Installation kann deshalb andere
Versionen erhalten. Die Lizenzdateien der tatsächlich installierten Versionen
bleiben maßgeblich.

| Paket | Vorhandene Version | Hauptlizenz | Quelle |
|---|---|---|---|
| CadQuery | 2.7.0 | Apache-2.0 | [Projekt](https://github.com/CadQuery/cadquery) |
| NumPy | 2.3.5 | BSD-3-Clause; zusätzliche Hinweise für enthaltene Fremdkomponenten | [Lizenz](https://github.com/numpy/numpy/blob/main/LICENSE.txt) |
| SciPy | 1.17.0 | BSD-3-Clause; zusätzliche Hinweise für enthaltene Fremdkomponenten | [Lizenz](https://github.com/scipy/scipy/blob/main/LICENSE.txt) |
| Pillow | 12.3.0 | MIT-CMU; eigene Hinweise für eingebundene Bildbibliotheken | [Lizenz](https://github.com/python-pillow/Pillow/blob/main/LICENSE) |
| Pydantic | 2.14.1 | MIT | [Lizenz](https://github.com/pydantic/pydantic/blob/main/LICENSE) |
| MCP Python SDK | 1.30.0 | MIT | [Version und Lizenz](https://github.com/modelcontextprotocol/python-sdk/tree/v1.30.0) |

Die Angaben wurden mit den Metadaten und Lizenzdateien dieser lokal
installierten Pakete abgeglichen. Die Quellen verweisen zusätzlich auf die
jeweiligen Herausgeber; Links zum Hauptentwicklungszweig können spätere
Versionen beschreiben.

## CAD-Kern und weitere Abhängigkeiten

CadQuery installiert zusätzliche Pakete. Besonders zu beachten sind:

| Komponente | Vorhandene Version | Lizenzhinweis | Quelle |
|---|---|---|---|
| OCP / cadquery-ocp | 7.8.1.1.post1 | Apache-2.0 für die Python-Anbindung | [OCP-Lizenz](https://github.com/CadQuery/OCP/blob/master/LICENSE) |
| Open CASCADE Technology | OCCT der 7.8-Reihe über OCP | LGPL 2.1 mit zusätzlicher Open-CASCADE-Ausnahme | [Lizenz und Ausnahme](https://dev.opencascade.org/doc/overview/html/occt_public_license.html) |
| VTK | 9.3.1 | BSD-Lizenz; Hinweise für enthaltene Fremdkomponenten beachten | [Projekt](https://vtk.org/about/) |
| CasADi | 3.7.2 | LGPL-3.0-or-later; enthaltene Solver und Plugins können weitere Lizenzen haben | [Projekt und Quellcode](https://github.com/casadi/casadi) |

MetricCAD nutzt Funktionen der **Open CASCADE Technology** über CadQuery und OCP.
Die Open-CASCADE-Ausnahme und die LGPL bleiben für diese Bibliothek gültig;
sie werden durch die Apache-Lizenz des eigenen Anwendungscodes nicht ersetzt.
CasADi ist eine Abhängigkeit von CadQuery; MetricCAD importiert es nicht direkt.

Zu den weiteren Abhängigkeiten gehören unter anderem pydantic-core und die
HTTP-/Validierungsbibliotheken des MCP SDK. NumPy-, SciPy-, Pillow-, VTK- und
CasADi-Pakete können weitere native Bibliotheken enthalten. Optionale Testwerkzeuge
wie jsdom, @napi-rs/canvas und Playwright werden separat installiert und sind
nicht in diesem Repository gebündelt.

## Umfang und Grenzen dieser Übersicht

Dies ist eine technische Bestandsaufnahme der direkten Abhängigkeiten und
ausgewählter CAD-Komponenten, keine vollständige Prüfung aller transitiven,
plattformabhängigen oder zukünftig installierten Pakete und keine juristische
Freigabe der Veröffentlichung. Die Herkunft und Rechte an ursprünglich
beigesteuertem Projektcode müssen beim Herausgeber geklärt sein.

Für einen späteren fertigen Installer, eine EXE, ein Container-Image oder ein
Paket mit mitgelieferten Bibliotheken muss die tatsächlich ausgelieferte
Abhängigkeitsmenge vollständig geprüft werden. Dann sind unter anderem die
jeweiligen Lizenztexte, Urheberrechtshinweise und gegebenenfalls Pflichten zur
Quellcodebereitstellung und zum Austausch von LGPL-Bibliotheken zu erfüllen.
Eine bloße Verlinkung in dieser Datei ersetzt solche Pflichten nicht.

Der Projektname, Firmenname und gegebenenfalls Logos werden durch die
Softwarelizenz nicht allgemein als Marken freigegeben; siehe Abschnitt 6
der [Apache License 2.0](LICENSE).
