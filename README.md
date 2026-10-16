# Stem Studio

Desktop workspace for separating a video's soundtrack into editable stems with your own local ComfyUI. Everything runs on your machine through the official ComfyUI SDK and a private API Proxy. No partner nodes and no cloud APIs are used. Application code is MIT licensed; model, code and data licenses remain independent (see below).

Download the latest installers from [Releases](https://github.com/uniqornate/Comfy-Stem-Studio/releases): `Stem-Studio-Setup.exe` (recommended, unified setup) or `Stem-Studio-Core.exe` (app only). Builds are unsigned and Windows only.

## Features

- Separate dialogue, music and effects with **MERL MRX (default)**, BandIt v2 or SFC-Locoformer.
- Waveform timeline with shared video/stem transport, mute/solo, zoom, range loop and non-destructive clip trim, split and gain edits.
- Extract named sounds with USS/PANNs (AudioSet classes, or All with Auto thresholds) and, experimentally, SAM Audio with text, time examples and visual boxes.
- Projects with autosave, last-session restore, takes for model comparison and native SaveVideo export (lossless MKV/FLAC), plus individual or batch stem downloads.

## Requirements

- Windows 10/11 and a local ComfyUI (portable or venv) with a recent ComfyUI build.
- NVIDIA GPU recommended; SAM Audio requires CUDA.
- Internet on first setup for model weights and the managed API Proxy runtime.

## Install

1. Run `Stem-Studio-Setup.exe` with Stem Studio closed and select your ComfyUI folder.
2. Review the model packs and licenses, approve the changes and choose Prepare everything. MRX is selected by default; verified existing files are reused.
3. Allow the setup to install the ComfyUI integration and safely restart an idle ComfyUI.
4. Open Stem Studio, pick a video, choose a model and press Separate stems (Ctrl+Enter).

SAM Audio is optional: it needs your own Hugging Face account, approval of the SAM Audio and PE-AV model pages and a read token (`hf_...`). The token is used only for preparation and is not saved.

## Models and licenses

| Model | Use | Weights license | Open weights only? |
|---|---|---|---|
| MERL MRX (adapted loudness) | Default separator | MIT | Yes |
| BandIt v2 multilingual | Separator | CC BY-SA 4.0 (code Apache 2.0) | Yes |
| USS at_soft + PANNs Cnn14 | Named sound extraction | Apache 2.0 / CC BY 4.0 | Yes |
| SFC-Locoformer Medium DnR | Optional separator | CC BY-NC-SA 4.0 | Non-commercial only |
| SAM Audio (small/large tv) | Experimental extraction | SAM license, gated on Hugging Face | Gated access, review the license |

Pinned sources, sizes and hashes: `setup/models.json`. Vendored code revisions and notices: `comfy_nodes/StemStudio/NOTICE.md`. Third-party mirrors are pinned by revision and verified by hash.

## Status

Separation with SFC was confirmed by a user on real media. Other adapters, the timeline, SAM Audio and exports are implemented but awaiting wider live acceptance. Quality, VRAM use and long-media behavior are not benchmarked. PromptSep is shown as unavailable because its public repository contains no runnable model.

## Development

Node 22+: `npm ci`, `npm run dev`, `npm run build`, `npm test`. `npm run dist:win` builds `release/Stem-Studio-Setup.exe` and `release/Stem-Studio-Core.exe` (needs the .NET Framework C# compiler). Architecture notes are in `docs/`; agent handoff state is in `docs/HANDOFF.md`.
