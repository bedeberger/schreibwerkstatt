# STT-Host (Diktat-Backend)

Self-hosted Speech-to-Text für das [STT-Diktat-Feature](../stt.md). Liefert einen OpenAI-kompatiblen `/v1/audio/transcriptions`-Endpunkt (Whisper), den der App-Proxy [routes/stt.js](../../routes/stt.js) pro VAD-Segment anspricht.

**Engine:** [speaches](https://github.com/speaches-ai/speaches) (vormals `faster-whisper-server`) — faster-whisper / CTranslate2, GPU.

**Modell (Default):** `deepdml/faster-whisper-large-v3-turbo-ct2` — für Kurzdiktat die beste Wahl: ~4–8× schneller als large-v3 bei nahezu gleicher DE/EN-Qualität, robuster bei GPU-Contention. Maximale Qualität ohne Zeitdruck: `Systran/faster-whisper-large-v3` (langsamer, ~3 GB) — dann `WHISPER__MODEL` **und** `PRELOAD_MODELS` in der Compose umstellen.

## Zuverlässigkeit: Modell warm halten

Die Compose ist so eingestellt, dass das Modell **beim Start vorgeladen** (`PRELOAD_MODELS`) und **nie entladen** wird (`WHISPER__TTL=-1`). Das ist entscheidend: ohne diese beiden Settings entlädt speaches das Modell nach 5 Min Idle, und der nächste Diktat-Request läuft in den App-Timeout (Modell-Reload dauert Sekunden) → das Segment geht verloren. Genau dieser Cold-Start war die häufigste Ausfallursache.

## Start

```bash
cd docs/stt-host
docker compose up -d
docker compose logs -f
```

Voraussetzung: NVIDIA-Container-Toolkit am Host (`docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi`).

Das Modell wird beim **Container-Start** geladen (turbo ~1.6 GB) und im `hf-hub-cache`-Volume gehalten. Bereitschaft prüfen:

```bash
curl http://localhost:8001/v1/models
```

## In der App eintragen (Admin → „Diktat")

| Feld | Wert |
|---|---|
| Aktiv | ✓ |
| Host | `http://<gpu-host>:8001` |
| Modell | `deepdml/faster-whisper-large-v3-turbo-ct2` |
| Fallback-Sprache | `de` (nur ohne Buchscope; sonst gewinnt die Buch-Locale) |
| Temperatur | `0` (deterministisch, weniger Halluzinationen) |
| Upstream-Timeout (ms) | `30000` (großzügig; deckt Last-/Reload-Spitzen) |

Dann **„Whisper-Host prüfen"** (pingt `/v1/models`) → **„Diktat aktiv"**. Die VAD-Schwellen (Stille/Threshold/Max-Segment) bleiben App-seitig.

## Reverse-Proxy (NGINX vor der App)

Audiosegmente gehen als rohes Binary an `/stt/transcribe`. Der NGINX-Default `client_max_body_size` (1 MB) würde längere Segmente **vor** der App mit `413` abweisen → intermittierende Ausfälle. Die Standard-Konfiguration [deploy/nginx.conf](../../deploy/nginx.conf) deckt das bereits ab (globales `client_max_body_size 32m` ≫ App-Cap von 5 MB, `proxy_read_timeout 300s` ≫ App-Upstream-Timeout von 30 s) — kein eigener `/stt/`-Block nötig. Eine selbstgebaute Config muss das Limit entsprechend großzügig setzen.

## Schnelltest

```bash
curl http://localhost:8001/v1/audio/transcriptions \
  -F "file=@probe.webm" \
  -F "model=deepdml/faster-whisper-large-v3-turbo-ct2" \
  -F "language=de"
```

## Koexistenz mit dem TTS-Host

Dieser Container belegt **Port 8001**, der [TTS-Host](../tts-host/) **8000** — beide laufen parallel auf einer Box. Teilen sie sich **eine GPU**, kann gleichzeitige Last (Diktat + Vorlesen, oder Bild-Generierung) Latenzspitzen erzeugen; bei knappem VRAM die Backends auf getrennte GPUs legen oder das kleinere STT-Modell behalten. Du kannst die `services:`-Blöcke beider Compose-Dateien auch in eine zusammenziehen.
