# Open Source Higgsfield contest: compatibility check

Rules read on 2026-10-22 from https://comfy.org/open-source-higgsfield. The page's "App requirements" and "Prepare your submission" sections were empty, so re-read it before submitting.

| Rule | Status |
|---|---|
| Working app built with ComfyUI | Yes. Every operation runs as a ComfyUI graph on the user's own ComfyUI; the `StemStudio` node pack and `workflows/` work without the desktop app. |
| Code under an open-source license, with setup instructions | MIT (`LICENSE`), install steps in `README.md`. Check that the GitHub repository is public. |
| Open Weights Only: no partner nodes or closed APIs | No partner nodes or hosted APIs are used. All weights are downloadable: MRX MIT; BandIt CC BY-SA; SFC CC BY-NC-SA; USS Apache; PANNs CC BY; GuideSep MIT; HTDemucs MIT; Stable Audio 3 Community License; MMAudio CC BY-NC; SAM Audio is gated on Hugging Face (open but needs approval). |
| One main category and one model-provider bonus per entry | Pick Open Weights Only or Most Innovative. No LTX, FLUX 3 or MiniMax H3 core model, so no provider bonus. |
| Demo video | Required for Most Innovative; judges value showing it working and how it was built. Not in the repository yet. |
| Deadline | Submissions close 2026-10-30 09:00 PT (19:00 in Istanbul). |

Risks to close before submitting: the installer in `release/` is older than the source (0.12.x is not packaged); most 0.12.x features have only been checked statically; the installer is unsigned; SAM, SFC and MMAudio licenses restrict use, which the README already states.
