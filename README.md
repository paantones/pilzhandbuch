# Pilzhandbuch

Begleit-App zum eBook **„Das Kosmos Handbuch Pilze“** (Andreas Gminder, Peter Karasch; Kosmos 2023) für unsere Pilzgruppe.

- Durchklickbarer Bestimmungsschlüssel mit Merkmalszeichnungen und Beispielarten
- Artbeschreibungen als gut lesbarer Text, Tafelbilder, Suche (auch im Volltext)
- Gemeinsame Fund-Datenbank mit Standort, Fotos, Karte und Kommentaren

## Wichtig: Diese App enthält keine Buchinhalte

Alle Texte und Bilder liest die App zur Laufzeit aus dem **eigenen, gekauften eBook-PDF** der jeweiligen Nutzer*innen. Die Datei bleibt auf dem Gerät und wird nirgendwohin hochgeladen. Dieses Repo enthält nur Code und ein Register (Artnamen, Seitenzahlen, Koordinaten der Textstellen).

Das eBook gibt es z. B. bei Kosmos, Thalia oder ebook.de als PDF mit Wasserzeichen. Bitte die eigene Datei nicht weitergeben.

## Technik

- Statische Web-App (GitHub Pages), installierbar und offline nutzbar
- PDF-Verarbeitung mit [pdf.js](https://mozilla.github.io/pdf.js/) (in `vendor/`, Worker so angepasst, dass weiche Trennstriche erhalten bleiben)
- Fund-Datenbank: Supabase (`supabase/schema.sql`), Karte: Leaflet + OpenStreetMap
- `tools/`: Skripte, mit denen `kosmos-index.json` aus dem PDF erzeugt wurde

Die App ersetzt keine Pilzberatung. Vor dem Verzehr Funde immer von Pilzsachverständigen prüfen lassen.
