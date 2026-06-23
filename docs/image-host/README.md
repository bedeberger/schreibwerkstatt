# Bild-Host: LocalAI auf RTX 3060 (8 GB)

Stellt der Schreibwerkstatt einen Bild-Endpunkt fuer das Buch-Chat-Tool
`generate_image` bereit (siehe [../image.md](../image.md)) — über
**[LocalAI](https://localai.io)**, das das OpenAI-Image-Protokoll **nativ**
spricht. Kein Adapter, kein Graph-Capture, kein Custom-Code:

```
Schreibwerkstatt
  └─ POST /v1/images/generations
       └─ LocalAI (:8080)   ← Admin-Tab "Bilder" zeigt hierhin
            └─ diffusers-Backend → SD/SDXL auf der RTX 3060
```

> **Verhältnis zu InvokeAI:** LocalAI ist eine eigene Engine mit eigenen
> Modell-Dateien und bedient die App. Deine InvokeAI kannst du für manuelles
> Arbeiten behalten — auf der einen 8-GB-Karte aber nicht gleichzeitig
> generieren. LocalAI entlädt sein Modell nach Leerlauf selbst (Idle-Watchdog),
> dann ist der VRAM wieder für InvokeAI frei.

## Dateien

| Datei | Zweck |
|-------|-------|
| [docker-compose.yml](docker-compose.yml) | LocalAI, GPU-reserviert, Single-Active-Backend + Idle-Watchdog, persistente `./backends`-Volume |
| [models/dreamshaper.yaml](models/dreamshaper.yaml) | SD 1.5 — sicherer 8-GB-Default |
| [models/sdxl.yaml](models/sdxl.yaml) | SDXL — bessere Qualität, knapp auf 8 GB (CPU-Offload) |

> **Backends sind modular.** Das `latest-gpu`-Image bringt die Python-Backends
> (u. a. `diffusers` für SD/SDXL) **nicht** mehr mit — sie liegen in einer
> Backend-Gallery und werden einmalig installiert (Schritt 3). Ohne diesen
> Schritt scheitert jeder Bild-Request mit `backend not found: diffusers`.

## Einrichtung

### 1. NVIDIA Container Toolkit (Host)

```bash
sudo apt install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
nvidia-smi   # Treiber prüft
```

### 2. Starten

```bash
docker compose up -d
```

Die Modell-YAMLs in [models/](models/) werden von LocalAI beim Start eingelesen.
Die Gewichte zieht es **beim ersten Bild-Request** von HuggingFace (kann ein
paar Minuten dauern) und cacht sie unter `models/`.

### 3. diffusers-Backend installieren

Beide Modell-YAMLs nutzen `backend: diffusers`. Dieses Backend liegt in der
Gallery und wird einmalig in die `./backends`-Volume installiert (überlebt
dadurch Container-Recreates und `:latest`-Pulls):

```bash
docker compose exec localai /local-ai backends list           # diffusers in der Gallery?
docker compose exec localai /local-ai backends install diffusers
```

Der Binary liegt im Container unter `/local-ai` (nicht im `$PATH` für
`exec` — darum der absolute Pfad). Landet das Backend nicht unter `/backends`,
zeigt die Install-Ausgabe den tatsächlichen Pfad; dann das Volume-Mapping in
der [docker-compose.yml](docker-compose.yml) entsprechend anpassen.

### 4. Modell wählen

Auf 8 GB ist **SD 1.5 (`dreamshaper`) der empfohlene Default** — passt locker,
schnell. SDXL (`sdxl`) geht nur knapp und mit CPU-Offload (langsamer). Beide
YAMLs liegen bei; im Admin-Tab entscheidet das **Modell-Feld**, welches benutzt
wird. Weitere Modelle: einfach eine YAML in `models/` ergänzen, oder
`docker exec -it <container> local-ai models list` / `... install <name>`.

### 5. Admin-Tab „Bilder" in der Schreibwerkstatt

| Feld | Wert |
|------|------|
| Bild-Generierung aktivieren | ✓ |
| Host | `http://<docker-host>:8080` |
| Modell | `dreamshaper` (oder `sdxl`) — der `name:` aus der YAML |
| Bildgrösse | SD 1.5: `768x768` · SDXL: `1024x1024` |
| Timeout (ms) | `180000` (erster Lauf lädt das Modell in den VRAM) |
| API-Key | leer (LocalAI lokal ohne Auth) |

### 6. Verifizieren

Erst der Admin-Test-Button („Bild-Host prüfen" → pingt `/v1/models`). Dann
End-to-End per curl:

```bash
curl -s http://<docker-host>:8080/v1/images/generations \
  -H 'Content-Type: application/json' \
  -d '{"model":"dreamshaper","prompt":"a lighthouse at dusk, oil painting","size":"768x768","response_format":"b64_json"}' \
  | head -c 120
# erwartet: {"created":...,"data":[{"b64_json":"iVBORw0KGgo…
```

Danach im Buch-Chat (Provider Claude): „Zeichne mir ein Porträt von <Figur>".

## VRAM-Richtwerte (RTX 3060, 8 GB, float16)

| Modell | 8 GB? | Hinweis |
|--------|-------|---------|
| SD 1.5 (512–768 px) | ✅ sicher | ~3–4 GB, schnell. Bester Start. |
| SDXL (1024 px) | ⚠️ knapp | nur mit `low_vram: true` (CPU-Offload), langsamer |
| Flux.1 (GGUF Q4/Q5) | ⚠️ nur quantisiert | über LocalAI-Galerie; deutlich langsamer |

Faustregel auf 8 GB: SD 1.5 als Default, SDXL nur wenn die Qualität es wert ist.

## Troubleshooting

- **`backend not found: diffusers`** (HTTP 500 auf `/v1/images/generations`) —
  das diffusers-Backend ist nicht installiert. Schritt 3 ausführen
  (`/local-ai backends install diffusers`). Nach einem `:latest`-Pull oder
  `docker compose down`/Recreate ist es weg, falls die `./backends`-Volume
  fehlt — Mapping in der Compose prüfen.
- **CUDA out of memory** — Bildgröße senken (SDXL → `768x768`, SD 1.5 → `512x512`),
  sicherstellen dass `f16: true` (+ bei SDXL `low_vram: true`) greift, und dass
  `LOCALAI_SINGLE_ACTIVE_BACKEND=true` gesetzt ist. Notfalls InvokeAI stoppen,
  solange LocalAI generiert.
- **`low_vram`-Key wird ignoriert/abgelehnt** — versionsabhängig. Zeile aus
  [models/sdxl.yaml](models/sdxl.yaml) entfernen und auf SD 1.5 ausweichen.
- **Erster Request hängt lange** — LocalAI lädt das HF-Modell herunter und in
  den VRAM. Timeout im Admin-Tab hochsetzen; danach ist es gecacht.
- **VRAM bleibt belegt** — Idle-Watchdog entlädt das Modell erst nach
  `LOCALAI_WATCHDOG_IDLE_TIMEOUT` (5m) Inaktivität. Kürzer = VRAM früher frei,
  aber nächster Request muss neu laden. Wert in der Compose-Datei anpassen.

## Sicherheit / Betrieb

- Host + API-Key bleiben **server-seitig** in den App-Settings; `/config`
  liefert sie nie (siehe [../image.md](../image.md)).
- LocalAI sollte **nicht** offen ins Internet — nur im internen Netz / hinter
  Reverse-Proxy, da der Endpunkt ungebremst Generierungen anstößt.
