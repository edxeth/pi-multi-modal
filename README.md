# pi-multi-modal

A [pi](https://github.com/badlogic/pi-mono) extension for local media paths.

It does two different jobs depending on the active model:

- **Models with native image input**: explicit `@./image.png` paths are attached as real image inputs.
- **Models without native image input**: explicit `@./image.png`, `@./video.mp4`, or `@./file.pdf` paths opt into GLM-based media analysis when the agent reads that same file.

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
- the file is analyzed with `glm-4.6v`
- the agent receives a structured summary instead of raw file contents

Plain paths without `@` are left alone. That means requests like these stay safe:

```text
Add ./preview-1.png and ./preview-2.png to my README
List all image paths mentioned in this document
```

## Vision backend

Media proxy analysis uses:

- provider: `zai` when available, otherwise `zai-legacy`
- model: `glm-4.6v`

Provider selection is resolved from the current pi instance without the slow `pi --list-models` subprocess probe.

## Features

- explicit `@path` handling for native image-input models
- explicit opt-in media analysis for non-vision models
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

```bash
pi --provider zai-messages --model glm-5
```

Then in the prompt:

```text
Compare @./before.png and @./after.png
```

Example with a non-vision model:

```text
Analyze @./screenshot.png and explain the error
```

If the agent reads `./screenshot.png`, the extension routes that read through `glm-4.6v`.

## Supported formats

### Native attachment path
- JPEG (`.jpg`, `.jpeg`)
- PNG (`.png`)
- GIF (`.gif`)
- WebP (`.webp`)

### Non-vision media proxy path
- Images: `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`
- Videos: `.mp4`, `.mkv`, `.mov`
- PDFs: `.pdf`

## Configuration

```text
provider = zai | zai-legacy
model = glm-4.6v
```

The extension prefers `zai` and falls back to `zai-legacy`.

Video analysis requires `ffmpeg` and `ffprobe` in `PATH`.
PDF analysis requires `gs` (Ghostscript) in `PATH`.

## Development

```bash
npm install
npm run check
npm test
npm run test:integration
```

See [test-fixtures/README.md](./test-fixtures/README.md) for fixture details and benchmarks.

## License

MIT
