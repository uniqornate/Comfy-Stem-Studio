# Unified setup, 0.3.0

## First-run flow

1. Run the custom Setup.exe and select the existing local ComfyUI folder. The portable parent is also accepted and normalized to the folder containing main.py.
2. Review the required SFC and optional USS/PANNs files, native model destination, start/restart preference and combined consent. Press Prepare everything.
3. Setup installs the app, verifies/reuses existing weights, downloads missing weights, copies the audio integration, prepares the private API Proxy runtime and checks engine/proxy readiness. The selected profile is marked complete only after all stages succeed.
4. Open Stem Studio, choose a video and press Separate stems. Successful setup needs no repeated folder selection, proxy installation or Install integration action inside the app.

Models are installed under ComfyUI/models/audio_separation. The custom node registers that category with ComfyUI folder_paths and references the verified SFC checkpoint through its runtime.json. Valid legacy downloads are copied from LOCALAPPDATA/Stem Studio/models, with originals preserved. A repeat installation checks sizes and hashes before skipping network download. Config files are also verified. Interrupted downloads at the new destination are resumable; incomplete legacy partials are not migrated.

ComfyUI's normal torch/torchaudio/numpy/einops/packaging dependencies are required. No training, Mamba or aiaccel dependencies are installed into ComfyUI. Unknown unmarked StemStudio node folders are preserved and reported. Manual Install integration remains a repair fallback and now shows model verification, file-copy progress and a persistent success/error dialog. Both a model category root and its sfc-locoformer-dnr subfolder are accepted there.

Automatic engine start/restart requires the displayed installer checkbox. A running engine must match the selected main.py and known portable/venv Python. Setup waits for idle queue state, rechecks the PID/interpreter/creation time and queue, then restarts using existing arguments. It refuses unknown processes, occupied ports or ambiguous state. Without this option, an unloaded integration requires a manual restart. The current engine startup supports local existing portable/venv installations; it does not provision ComfyUI or discover custom --base-directory/model overrides.

## Processing and exports

The official @comfyorg/sdk creates the workflow, uploads the source, submits through API Proxy and polls the job. LoadAudio decodes the source; StemStudioSeparate runs SFC DnR; SaveAudio writes three FLAC outputs. The app receives each through SDK Output.toFile into userData/stem-cache. Only a complete three-output result is presented as success. Cancellation uses the job-specific SDK endpoint.

Dialogue/Music/Effects follow the published DnR source order. This pinned Medium model is MONO and resamples to 44100 Hz. The source is unchanged. Synchronized video comparison, remux/export parity and stereo preservation are not implemented. FLAC conversion, boundaries, numerical parity and audio quality require user acceptance.

Each stem has independent audio controls and a native Save dialog. Download all writes the three cached files to a unique child folder. It is not a ZIP. Partial copy failures report the number saved. Caches persist locally; automatic cleanup and cross-restart recovery are pending. Upload limits depend on ComfyUI and its proxy.

## Validation limits

Vendor modules are pinned to b-sigpro/spectral-feature-compression bf61e1e37471d7a28bc5727d3d07d6cb8b177370 with MIT/Apache notices. Relative imports and the musical-only band configuration avoid unused training/librosa/spafe dependencies. The adapter loads tensor-only checkpoint state with strict keys, using serial 12-second chunks, 6-second shifts and overlap averaging. Very short signals are padded for STFT and trimmed. All-silent chunks are zeroed. Weights remain CC BY-NC-SA 4.0.

Model memory is released before/after separation. Peak VRAM, speed, seams, real source-order correctness and quality are unverified. Agent checks use offline fixtures, mocked network/process behavior, Python AST parsing and static/build checks. The agent does not start the installer/app, probe real services, install into the user's ComfyUI, download model/runtime binaries or run inference. First live acceptance belongs to the user and should use a short clip with three stem previews and individual/batch saves.

0.3.2 compatibility note: the vendored SFC self-attention permits PyTorch MATH SDPA alongside the requested fused backend. This avoids forcing an unavailable fused kernel on Windows or unsupported head dimensions/dtypes. It does not change checkpoint weights. Actual inference quality/performance and memory remain user-unverified. Successful setup now explicitly states that ComfyUI is already running in the background; starting the CUDA preparation BAT again is unnecessary and its port guard will refuse a duplicate launch.

## 0.4.0 comparison/detail release

Supersedes earlier USS-future statements: select SFC, BandIt v2 or MRX in Soundtrack and Separate stems. The same source can produce up to 12 session result takes, each with separate exports. New video selection resets them. USS Detail recovery chooses original/current-take audio, an AudioSet sound class and detection threshold, then returns target and remainder as a new take.

BandIt uses the official multilingual 48 kHz checkpoint with the published musical-64 GRU8 configuration and source order speech/music/sfx. MRX uses adapted-loudness weights at 44.1 kHz, remapping music/speech/sfx into the product channel order; chunks are half-overlapped, without original LUFS normalization/mixture consistency. USS is mono 32 kHz, at_soft 527-class query conditioning on masked Cnn14 probabilities, 2-second half-overlap chunks and a configurable activity threshold. The remainder is input minus target, not a separately predicted source. No arbitrary text or all-class auto-splitting is claimed. Inference adapters and original license files are bundled under vendor_extra; revisions are documented in node NOTICE.

The waveform timeline uses real decoded FLAC buffers, shared AudioContext scheduling, common playhead/transport/seek, zoom and independent mute/solo/level. Gains apply only to audition, not export bytes. Timeline playback and video preview are separate. Instant synchronized A/B, stereo preservation, new-model numerical parity, measured VRAM and actual new-model inference remain pending user acceptance. The user confirmed SFC 0.3.2 actual three-stem success before these changes. No new adapter or live UI was run by the agent.

## 0.4.3 All-mode contract

StemStudioExtract exposes All alongside527 AudioSet labels; capability discovery only returns All if optional StemStudioExtractAll is present. The shared probe adds that fifth per-class request without global inventory. All workflow is LoadAudio -> StemStudioExtractAll output node. It scans/cache-tags once, computes each detected class serially and calls the current ComfyUI UI.AudioSaveHelper.get_save_audio_ui(...).as_dict() to save FLAC using built-in codec behavior. It returns legacy-compatible {'ui':{'audio':[saved results]}} with no AUDIO tensors retained for a subsequent graph-wide list. The proxy maps the audio UI key generically; SDK Output.name exposes class-index filenames. Main validates IDs/uniqueness and maps names against engine-advertised original class order, with up to527 downloads. Empty/invalid/duplicate output sets fail. No invented All remainder or top-N truncation. Single-target generator closes model resources in finally; All closes it on encoding/cancellation errors. Parent/child labels can overlap, so default timeline preview solos the first All channel. No live run was performed.
