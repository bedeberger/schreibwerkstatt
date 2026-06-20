# STT-Host (Diktat-Backend)

Self-hosted Speech-to-Text für das [STT-Diktat-Feature](../stt.md). Liefert einen OpenAI-kompatiblen `/v1/audio/transcriptions`-Endpunkt (Whisper), den der App-Proxy [routes/stt.js](../../routes/stt.js) pro VAD-Segment anspricht.

**Engine:** [speaches](https://github.com/speaches-ai/speaches) (vormals `faster-whisper-server`) — faster-whisper / CTranslate2, GPU.

**Modell (DE + EN, beste Qualität):** `Systran/faster-whisper-large-v3`. Mit reichlich VRAM die erste Wahl. Schnellere Alternative bei kaum Qualitätsverlust: `deepdml/faster-whisper-large-v3-turbo-ct2`.

## Start

```bash
cd docs/stt-host
docker compose up -d
docker compose logs -f
```

Voraussetzung: NVIDIA-Container-Toolkit am Host (`docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi`).

Das Modell wird beim **ersten Diktat-Request** automatisch geladen (large-v3 ~3 GB) und im `hf-hub-cache`-Volume gehalten. Optional vorab prüfen/anstossen:

```bash
curl http://localhost:8001/v1/models
```

## In der App eintragen (Admin → „Diktat")

| Feld | Wert |
|---|---|
| Aktiv | ✓ |
| Host | `http://<gpu-host>:8001` |
| Modell | `Systran/faster-whisper-large-v3` |
| Fallback-Sprache | `de` (nur ohne Buchscope; sonst gewinnt die Buch-Locale) |
| Temperatur | `0` (deterministisch, weniger Halluzinationen) |

Dann **„Whisper-Host prüfen"** (pingt `/v1/models`) → **„Diktat aktiv"**. Die VAD-Schwellen (Stille/Threshold/Max-Segment) bleiben App-seitig.

## Schnelltest

```bash
curl http://localhost:8001/v1/audio/transcriptions \
  -F "file=@probe.webm" \
  -F "model=Systran/faster-whisper-large-v3" \
  -F "language=de"
```

## Koexistenz mit dem TTS-Host

Dieser Container belegt **Port 8001**, der [TTS-Host](../tts-host/) **8000** — beide laufen parallel auf einer Box. Du kannst die `services:`-Blöcke beider Compose-Dateien auch in eine zusammenziehen.
