# Sicherheitsmeldungen

Bitte Sicherheitslücken vertraulich an
[office@metricvision.at](mailto:office@metricvision.at) melden,
Betreff: `MetricCAD Sicherheitsmeldung`.

Hilfreich sind betroffene Version oder Commit, Betriebssystem, reproduzierbare
Schritte und die erwartete Auswirkung. Keine aktiven Zugangsdaten mitsenden.
Sicherheitsrelevante Details bitte nicht zuerst in einem öffentlichen Issue posten.

## Vorgesehener Betrieb

MetricCAD ist für den lokalen Betrieb auf dem eigenen Rechner vorgesehen.
Der CAD-Server und der optionale HTTP-MCP-Endpunkt lauschen standardmäßig auf
`127.0.0.1`. Die Datei `.metriccad/connection.json` enthält eine lokale
Sitzungskennung und gehört nicht ins Repository oder in Fehlerberichte.

Eine öffentliche Serverbereitstellung, Mehrbenutzerbetrieb und verbindliche
Reaktionszeiten für Sicherheitsmeldungen sind in dieser frühen Projektfassung
nicht zugesichert. Eine individuell vereinbarte Betreuung erfolgt separat.
