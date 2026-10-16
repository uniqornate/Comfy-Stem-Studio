# StemStudio - Agent Instructions

<!-- handoff-standard:v1 -->
## Mandatory handoff lifecycle

1. Inspect existing work; never erase or claim changes you did not create.
2. Read the CONTROL BLOCK in `docs/HANDOFF.md`.
3. Read `docs/HANDOFF_PROTOCOL.md`.
4. Reconcile project plans with the control block before editing.
5. Register substantial work with a `W-YYYYMMDD-NN` ID.
6. Before finishing, validate, update the control block, and sign the log.

`AGENTS.md` is canonical. Provider adapter files only point here.

## Project-specific instructions

- The user owns live testing. Do not launch the app or automate its UI, play media, run real ComfyUI jobs, or perform live connection/model tests unless the user explicitly requests that specific testing. Ask the user to perform live checks and report results. Static checks and packaging may be run when appropriate.
- Never generate images unless explicitly requested. Do not use em dashes in user-facing output unless requested.
- Keep implemented, planned, and user-verified features distinct. Never show simulated separation output as real inference.

- Build all future Windows releases into the fixed `release/` directory. Keep installer names `Stem-Studio-Setup.exe` and `Stem-Studio-Core.exe`, overwriting previous builds. Increment application version metadata without creating version-specific output folders.
