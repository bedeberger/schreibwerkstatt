# Bild-Host: LocalAI auf RTX 5060 Ti (16 GB, Blackwell)

Stellt der Schreibwerkstatt einen Bild-Endpunkt fuer das Buch-Chat-Tool
`generate_image` bereit (siehe [../image.md](../image.md)) — über
**[LocalAI](https://localai.io)**, das das OpenAI-Image-Protokoll **nativ**
spricht. Kein Adapter, kein Graph-Capture, kein Custom-Code:

```
Schreibwerkstatt
  └─ POST /v1/images/generations
       └─ LocalAI (:8080)   ← Admin-Tab "Bilder" zeigt hierhin
            └─ cuda13-diffusers-Backend → SD/SDXL auf der RTX 5060 Ti
```

Die Karte ist **Blackwell** (Compute Capability sm_120) mit Treiber 580.x /
**CUDA 13** — darum durchgehend der cuda-13-Stack (Image + Backend). Ältere
cuda-12-Builds haben keine Kernels für sm_120 und scheitern mit
`no kernel image is available for execution on the device`.

> **Verhältnis zu InvokeAI:** LocalAI ist eine eigene Engine mit eigenen
> Modell-Dateien und bedient die App. Deine InvokeAI kannst du für manuelles
> Arbeiten behalten. `LOCALAI_SINGLE_ACTIVE_BACKEND=true` hält pro LocalAI
> immer nur ein Modell im VRAM; nach Leerlauf entlädt der Idle-Watchdog es
> selbst und gibt den VRAM wieder frei.

## Dateien

| Datei | Zweck |
|-------|-------|
| [docker-compose.yml](docker-compose.yml) | LocalAI (cuda-13-Image), GPU-reserviert, Single-Active-Backend + Idle-Watchdog, persistente `./backends`-Volume |
| [models/sdxl.yaml](models/sdxl.yaml) | SDXL — empfohlener Default bei 16 GB, `1024x1024` |
| [models/dreamshaper.yaml](models/dreamshaper.yaml) | SD 1.5 — schneller, leichter Fallback |

> **Backends sind modular.** Das `latest-gpu`-Image bringt die Python-Backends
> (u. a. `diffusers` für SD/SDXL) **nicht** mehr mit — sie liegen in einer
> Backend-Gallery und werden einmalig installiert (Schritt 3). Ohne diesen
> Schritt scheitert jeder Bild-Request mit `backend not found: diffusers`. Für
> Blackwell ist die **`cuda13-diffusers`**-Variante zwingend.

## Einrichtung

### 1. NVIDIA Container Toolkit (Host)

```bash
sudo apt install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
nvidia-smi   # Treiber + CUDA-Version prüfen — fuer Blackwell/CUDA 13: Treiber >= 580
```

### 2. Starten

```bash
docker compose up -d
```

Die Modell-YAMLs in [models/](models/) werden von LocalAI beim Start eingelesen.
Die Gewichte zieht es **beim ersten Bild-Request** von HuggingFace (kann ein
paar Minuten dauern) und cacht sie unter `models/`.

### 3. diffusers-Backend installieren (cuda13)

Beide Modell-YAMLs nutzen `backend: cuda13-diffusers`. Dieses Backend liegt in
der Gallery und wird einmalig in die `./backends`-Volume installiert (überlebt
dadurch Container-Recreates und `:latest`-Pulls):

```bash
docker compose exec localai /local-ai backends list | grep -i diffus   # Varianten zeigen
docker compose exec localai /local-ai backends install cuda13-diffusers
```

Der Binary liegt im Container unter `/local-ai` (nicht im `$PATH` für
`exec` — darum der absolute Pfad). **Wichtig:** auf Blackwell (RTX 50-Serie)
zwingend `cuda13-diffusers` — das generische `diffusers` löst auf einem
cuda-12-Image zur cuda12-Variante auf, die keine sm_120-Kernels hat
(`no kernel image …`). Landet das Backend nicht unter `/backends`, zeigt die
Install-Ausgabe den tatsächlichen Pfad; dann das Volume-Mapping in der
[docker-compose.yml](docker-compose.yml) entsprechend anpassen.

### 4. Modell wählen

Bei 16 GB ist **SDXL (`sdxl`) der empfohlene Default** — `1024x1024` passt
locker ohne CPU-Offload. `dreamshaper` (SD 1.5) bleibt als schneller, leichter
Fallback bei. Im Admin-Tab entscheidet das **Modell-Feld**, welches benutzt
wird. Weitere Modelle: einfach eine YAML in `models/` ergänzen (jeweils mit
`backend: cuda13-diffusers`).

### 5. Admin-Tab „Bilder" in der Schreibwerkstatt

| Feld | Wert |
|------|------|
| Bild-Generierung aktivieren | ✓ |
| Host | `http://<docker-host>:8080` |
| Modell | `sdxl` (oder `dreamshaper`) — der `name:` aus der YAML |
| Bildgrösse | SDXL: `1024x1024` · SD 1.5: `768x768` |
| Timeout (ms) | `180000` (erster Lauf lädt das Modell in den VRAM) |
| API-Key | leer (LocalAI lokal ohne Auth) |

### 6. Verifizieren

Erst der Admin-Test-Button („Bild-Host prüfen" → pingt `/v1/models`). Dann
End-to-End per curl:

```bash
curl -s http://<docker-host>:8080/v1/images/generations \
  -H 'Content-Type: application/json' \
  -d '{"model":"sdxl","prompt":"a lighthouse at dusk, oil painting","size":"1024x1024","response_format":"b64_json"}' \
  | head -c 120
# erwartet: {"created":...,"data":[{"b64_json":"iVBORw0KGgo…
```

Danach im Buch-Chat (Provider Claude): „Zeichne mir ein Porträt von <Figur>".

## VRAM-Richtwerte (RTX 5060 Ti, 16 GB, float16)

| Modell | 16 GB? | Hinweis |
|--------|--------|---------|
| SD 1.5 (512–768 px) | ✅ locker | ~3–4 GB, sehr schnell. |
| SDXL (1024 px) | ✅ locker | ~8–10 GB, kein CPU-Offload nötig. Bester Default. |
| Flux.1 (GGUF Q4/Q5) | ✅ möglich | über LocalAI-Galerie; langsamer, aber passt. |

## Troubleshooting

- **`backend not found: diffusers`** (HTTP 500 auf `/v1/images/generations`) —
  das Backend ist nicht installiert. Schritt 3 ausführen
  (`/local-ai backends install cuda13-diffusers`). Nach einem `:latest`-Pull
  oder `docker compose down`/Recreate ist es weg, falls die `./backends`-Volume
  fehlt — Mapping in der Compose prüfen.
- **`no kernel image is available for execution on the device`** (HTTP 500,
  Backend lädt, GPU belegt, aber kein Kernel startet) — CUDA-Variante passt
  nicht zur GPU-Architektur. Auf Blackwell (sm_120): cuda-13-Image **und**
  `cuda13-diffusers` verwenden, nicht die cuda12-Builds. `nvidia-smi` muss
  CUDA 13 zeigen.
- **CUDA out of memory** — Bildgröße senken (SDXL → `768x768`, SD 1.5 →
  `512x512`), sicherstellen dass `f16: true` greift und
  `LOCALAI_SINGLE_ACTIVE_BACKEND=true` gesetzt ist. Notfalls InvokeAI stoppen,
  solange LocalAI generiert.
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
