# Output-Intent-ICC für PDF/X-3-Export

Der PDF/X-Export ([lib/pdfx-convert.js](../../lib/pdfx-convert.js)) bettet ein
Output-Intent-ICC als Druckbedingung ein. RGB-Inhalt bleibt erhalten — die
Druckerei separiert selbst gegen dieses Profil. Es findet **keine** CMYK-Bild-
Separation in der App statt.

## Profil bereitstellen

Default-Pfad (wird automatisch genutzt, wenn vorhanden):

    assets/icc/PSOuncoated_v3_FOGRA52.icc

Alternativ per ENV überschreiben:

    PDFX_ICC_PATH=/pfad/zu/profil.icc

Empfohlene Profile (ECI, frei redistribuierbar — https://www.eci.org):

- **PSO Uncoated v3 (FOGRA52)** — Werkdruckpapier / Roman (Default)
- **PSO Coated v3 (FOGRA51)** — gestrichenes Papier

Die `.icc`-Binärdateien sind **nicht** im Repo eingecheckt. Beim Deployment in
diesen Ordner legen (oder `PDFX_ICC_PATH` setzen). Fehlt das Profil, liefert der
Export non-fatal das unkonvertierte PDF mit Warnung.
