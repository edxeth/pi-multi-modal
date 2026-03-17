# glm-vision

A [pi](https://github.com/badlogic/pi-mono) extension that proxies media analysis through GLM-4.6v for models without native image support.

## Why?

Some models have no vision capabilities. GLM-4.6v does. This extension detects when the active model lacks native image support and proxies media analysis through GLM-4.6v:

1. **Images** are sent directly to GLM-4.6v with a structured classification prompt.
2. **Videos** are sampled into keyframes locally (via `ffmpeg`), then analyzed by GLM-4.6v in chronological order.

This approach is [48% faster and produces higher quality output](./test-fixtures/README.md#performance-comparison-generic-vs-structured-prompt) compared to a generic "analyze this image" prompt.

## Features

- **Automatic media interception**: Supported image/video file reads are redirected to glm-4.6v when the active model has no native image support
- **Image classification**: Images are categorized (UI, code, error, diagram, chart, general) for targeted analysis
- **Video support for local files**: Videos are converted to chronological keyframes via `ffmpeg`, then summarized by GLM-4.6v
- **Specialized prompts**:
  - **Code screenshots**: Extracts actual code with line numbers
  - **Error screenshots**: Provides root cause analysis and fix suggestions
  - **Diagrams**: Lists components, relationships, and protocols
  - **Charts**: Extracts data values, trends, and insights
- **Manual analysis commands**: `/analyze-image <path>` and `/analyze-video <path>`

## Installation

Install globally:

```bash
pi install git:github.com/Whamp/glm-vision
```

Or install for a specific project (writes to `.pi/settings.json`):

```bash
pi install -l git:github.com/Whamp/glm-vision
```

To try it without installing:

```bash
pi -e git:github.com/Whamp/glm-vision
```

## Usage

Once installed, the extension loads automatically when you start pi:

```bash
pi --provider zai-messages --model glm-5
```

Media analysis uses:

- provider: `zai` when available, otherwise `zai-legacy`
- model: `glm-4.6v`

### Automatic Mode

When the extension detects:
1. The current model has no native image support
2. A file being read is a supported image/video format

It will automatically spawn a subprocess with glm-4.6v to analyze the media and return a structured summary.

### Manual Analysis

Use the manual commands:

```
/analyze-image ./screenshot.png
/analyze-video ./recording.mp4
```

## Supported Formats

### Images
- JPEG (.jpg, .jpeg)
- PNG (.png)
- GIF (.gif)
- WebP (.webp)

### Videos
- MP4 (.mp4)
- Matroska (.mkv)
- QuickTime (.mov)

## Development

```bash
# Install dependencies
npm install

# Run unit tests
npm run test

# Run integration tests
npm run test:integration

# Type check
npm run typecheck

# Lint and format
npm run check
npm run format
```

See [test-fixtures/README.md](./test-fixtures/README.md) for test image details and performance benchmarks.

## Configuration

Vision backend:

```bash
provider = zai | zai-legacy
model = glm-4.6v
```

The extension prefers `zai` and automatically falls back to `zai-legacy`. Make sure at least one of them is configured in pi. Credentials can come from environment variables, `~/.pi/agent/auth.json`, or `~/.pi/agent/models.json`, depending on how the provider is configured in pi.

Video analysis also requires `ffmpeg`/`ffprobe` to be available in your PATH.

## License

MIT
