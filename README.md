# pi-multi-modal

A [pi](https://github.com/badlogic/pi-mono) extension for local image, video, and PDF paths.

It does three jobs depending on the active model and workflow:

- **Models with native image input**: explicit `@./image.png` paths are attached as real image inputs.
- **Models without native image input**: explicit `@./image.png`, `@./video.mp4`, or `@./file.pdf` paths opt into media analysis when the agent reads that same file.
- **Bash image workflows**: the bash tool gets a built-in `__PI_IMAGE__` helper so any command that creates a local image file can return it inline in the same tool result.

## Behavior

### 1) Native image-input models

For models that already support images, the extension keeps the normal explicit-attachment workflow:

```text
Compare @./before.png and @./after.png
```

What happens:
- the image files are attached to the current conversation
- the visible path text is rewritten to placeholders like `[Image #1]`
- the active model handles the image directly

This path is for **images only**.

### 2) Non-vision models

For text-only models, `@path` becomes an explicit opt-in for media analysis.

```text
Analyze @./screenshot.png
Summarize @./demo.mp4
Review @./report.pdf
```

What happens:
- the `@path` marks that file as intentionally analyzable media
- if the agent later uses the `read` tool on that same path, the extension intercepts it
- the file is analyzed with the configured pi-multi-modal backend
- the agent receives a structured summary instead of raw file contents

Plain paths without `@` are left alone.

### 3) Inline bash images

The extension injects a `__PI_IMAGE__` shell helper into the bash tool.

```bash
python make-chart.py && __PI_IMAGE__ chart.png
my-tool-that-generates-an-image && __PI_IMAGE__ output.png
```

What happens:
- the helper emits markers for real local image paths
- pi-multi-modal replaces those markers before the model sees the tool result
- vision models receive the actual image block inline
- non-vision models receive an inline analysis from the configured backend instead

## TIA compatibility

If you run pi through TIA and keep TIA's `fast-tools.ts` enabled, set:

```bash
export PI_MULTI_MODAL_WRAP_EXISTING_TOOLS=1
```

In this mode, pi-multi-modal does **not** register public `read` or `bash` tools. TIA keeps ownership of those fast tools, and pi-multi-modal wraps them through pi's tool events:

- normal text `read` stays on TIA's fast `read`
- normal/safe `bash` stays on TIA's fast `bash`
- image/video/PDF `read` results are replaced with pi-multi-modal media-aware results when applicable
- `bash` commands using `__PI_IMAGE__` get the helper preamble and marker processing

This avoids duplicate `read`/`bash` tool conflicts while preserving media handling.

Example shell setup:

```bash
export PI_MULTI_MODAL_WRAP_EXISTING_TOOLS=1
alias pi='tia pi'
alias p='tia pi'
```

Notes:
- explicit media analysis still uses `@path` opt-in semantics for non-vision models
- video analysis requires explicit media references such as `@./demo.mp4`
- the internal media-analysis subprocess clears inherited `PI_PACKAGE_DIR` so it can run normal pi correctly under TIA

## Backend configuration

Default backend:

```text
zai/glm-4.6v
```

Set a different backend in interactive mode:

```text
/multi-modal zai/glm-4.6v
/multi-modal google/gemini-3-flash-preview:high
```

This saves to `~/.pi/agent/settings.json` under:

```json
{
  "multiModal": {
    "provider": "google",
    "model": "gemini-3-flash-preview",
    "thinkingLevel": "high"
  }
}
```

If `:thinking` is omitted, pi-multi-modal does not pass `--thinking` to the backend subprocess.

Requirements for the configured backend:
- the model must exist in Pi's model registry
- the model must support image input

## Features

- explicit `@path` handling for native image-input models
- explicit opt-in media analysis for non-vision models
- configurable backend via `/multi-modal`
- inline bash image ingestion via `__PI_IMAGE__`
- image classification for screenshots, diagrams, charts, and general images
- video analysis via local keyframe extraction with `ffmpeg`
- PDF analysis via rendered page images
- manual commands:
  - `/analyze-image <path>`
  - `/analyze-video <path>`

## Installation

Install globally:

```bash
pi install git:github.com/edxeth/pi-multi-modal
```

Install for the current project:

```bash
pi install -l git:github.com/edxeth/pi-multi-modal
```

Try it without installing:

```bash
pi -e git:github.com/edxeth/pi-multi-modal
```

## Usage

Example with a vision-capable model:

```text
Compare @./before.png and @./after.png
```

Example with a non-vision model:

```text
Analyze @./screenshot.png and explain the error
```

If the agent reads `./screenshot.png`, the extension routes that read through the configured backend.

`agent-browser` example in one bash result:

```bash
agent-browser open https://example.com \
  && agent-browser wait --load networkidle \
  && agent-browser screenshot page.png \
  && __PI_IMAGE__ page.png
```

## Supported formats

### Native attachment path
- JPEG (`.jpg`, `.jpeg`)
- PNG (`.png`)
- GIF (`.gif`)
- WebP (`.webp`)

### Media analysis path
- Images: `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`
- Videos: `.mp4`, `.mkv`, `.mov`
- PDFs: `.pdf`

Video analysis requires `ffmpeg` and `ffprobe` in `PATH`.
PDF analysis requires `gs` (Ghostscript) in `PATH`.

## Development

```bash
npm install
npm test
npx tsc --noEmit
```

See [test-fixtures/README.md](./test-fixtures/README.md) for fixture details and benchmarks.

## License

MIT
