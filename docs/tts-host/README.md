# TTS-Host (Proof-Listening-Backend)

Self-hosted Text-to-Speech für das [Proof-Listening-Feature](../tts.md). Liefert einen OpenAI-kompatiblen `/v1/audio/speech`-Endpunkt, den der App-Proxy [routes/tts.js](../../routes/tts.js) pro Satz anspricht.

**Engine:** [openedai-speech](https://github.com/matatonic/openedai-speech) — ein Container, zwei Modelle:
- **XTTS-v2** (`model: tts-1-hd`) — sehr natürlich, DE + EN, Voice-Cloning aus einem Sample. ~4–6 GB VRAM. Die satzweise Zustellung des Proxys hält XTTS stabil (kurze Eingaben).
- **Piper** (`model: tts-1`) — schnell, robust, glasklar (deutsche Thorsten-Stimme). Gut, wenn Klarheit > Ausdruck.

> **Kokoro scheidet aus:** kann kein Deutsch (nur en/es/fr/it/pt/hi/ja/zh).

## Start

```bash
cd docs/tts-host
# XTTS-Sprecher-Samples ablegen (6–30 s, mono, 22–24 kHz):
#   voices/de_sample.wav   voices/en_sample.wav
docker compose up -d
docker compose logs -f          # erster Start lädt das XTTS-Modell (~2 GB)
```

Voraussetzung: NVIDIA-Container-Toolkit am Host (`docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi`).

## Stimmen konfigurieren

In [config/voice_to_speaker.yaml](config/voice_to_speaker.yaml) eine DE- und eine EN-Stimme definieren (Beispiel liegt bei). Die dort vergebenen Namen trägst du in der App ein.

## In der App eintragen (Admin → „Vorlesen")

| Feld | Wert |
|---|---|
| Aktiv | ✓ |
| Host | `http://<gpu-host>:8000` |
| Modell | `tts-1-hd` (XTTS) — oder `tts-1` (Piper) |
| Standard-Stimme | `de_studio` |
| Stimme Deutsch | `de_studio` |
| Stimme English | `en_studio` |
| Format | `mp3` |
| Tempo | `1` |

Dann **„Speech-Host prüfen"** (pingt `/v1/models`) → **„Vorlesen aktiv"**. Die App löst die Stimme pro Buch aus der Buch-Locale auf (`tts.voice.de` / `tts.voice.en`, sonst Standard-Stimme).

## Schnelltest

```bash
curl http://localhost:8000/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model":"tts-1-hd","voice":"de_studio","input":"Den eigenen Text gehört aufzudecken Stolperstellen, die das Auge überliest."}' \
  --output probe.mp3
```

## Koexistenz mit dem STT-Host

Dieser Container belegt **Port 8000**, der [STT-Host](../stt-host/) **8001** — beide laufen parallel auf einer Box. Du kannst die `services:`-Blöcke beider Compose-Dateien auch in eine zusammenziehen.
