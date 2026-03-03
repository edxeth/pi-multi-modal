# glm-vision

A [pi](https://github.com/badlogic/pi-mono) extension that intercepts image/video reads when using non-vision GLM models and sends them to GLM-4.6v for detailed analysis.

## Why?

GLM text models (glm-4.6, glm-4.7, glm-4.7-flash, glm-5) have no vision capabilities. GLM-4.6v does. This extension automatically detects when you're using a non-vision GLM model and intercepts image/video reads:

1. **Images** are sent directly to GLM-4.6v with a structured classification prompt.
2. **Videos** are sampled into keyframes locally (via `ffmpeg`), then analyzed by GLM-4.6v in chronological order.

This approach is [48% faster and produces higher quality output](./test-fixtures/README.md#performance-comparison-generic-vs-structured-prompt) compared to a generic "analyze this image" prompt.

## Features

- **Automatic media interception**: When using glm-4.6, glm-4.7, glm-4.7-flash, or glm-5, supported image/video file reads are automatically redirected to glm-4.6v
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
pi --provider zai --model glm-4.7
```

### Automatic Mode

When the extension detects:
1. Current model is `glm-4.6`, `glm-4.7`, `glm-4.7-flash`, or `glm-5`
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

# Run integration tests (requires ZAI_API_KEY)
export ZAI_API_KEY="your-api-key"
npm run test:integration

# Type check
npm run typecheck

# Lint and format
npm run check
npm run format
```

See [test-fixtures/README.md](./test-fixtures/README.md) for test image details and performance benchmarks.

## Configuration

The extension uses the ZAI provider for the vision model. Make sure you have proper API credentials configured:

```bash
export ZAI_API_KEY="your-api-key"
```

Video analysis also requires `ffmpeg`/`ffprobe` to be available in your PATH.

## License

MIT
