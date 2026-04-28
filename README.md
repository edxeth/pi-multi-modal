# pi-multi-modal

`pi-multi-modal` lets pi work with local images, videos, and PDFs without making you change how you talk to the agent.

Point at a file with `@./path`, or emit an image from bash with `__PI_IMAGE__`. If the active model can see images, pi gets the image directly. If it cannot, this extension quietly asks a configured vision model to analyze the media and gives the active agent a clean text summary.

## The short version

```text
Compare @./before.png and @./after.png
Analyze @./screenshot.png and explain the error
Summarize @./demo.mp4
Review @./report.pdf
```

For generated images:

```bash
python make-chart.py && __PI_IMAGE__ chart.png
```

That is the whole idea: local media should feel like normal pi context.

## How it behaves

### Image-capable models

When the current model supports image input, explicit image references are attached as real image blocks:

```text
Compare @./before.png and @./after.png
```

The extension attaches the image data for the model. In the UI you are more likely to see an attachment indicator or preview, while the prompt text stays readable. This direct attachment path is for images only.

### Text-only models

When the current model cannot see images, `@path` becomes an intentional request to make that media analyzable.

```text
Analyze @./screenshot.png
```

If the agent later reads that same path, `pi-multi-modal` intercepts the read, sends the media to the configured vision backend, and returns a structured summary instead of raw bytes.

Plain paths are left alone. The extension only analyzes media that was explicitly referenced with `@`.

### Bash-produced images

The extension adds a small shell helper named `__PI_IMAGE__` to bash tool calls:

```bash
agent-browser open https://example.com \
  && agent-browser wait --load networkidle \
  && agent-browser screenshot page.png \
  && __PI_IMAGE__ page.png
```

For image-capable models, the result includes the image itself. For text-only models, the result includes a vision-backend summary.

## Backend configuration

The built-in default is:

```text
zai/glm-4.6v
```

Set another backend from inside pi:

```text
/multi-modal nahcrof/kimi-k2.5-lightning
/multi-modal nahcrof/kimi-k2.6-precision:high
/multi-modal google/gemini-3-flash-preview:high
```

The command writes this shape to `~/.pi/agent/settings.json`:

```json
{
  "multiModal": {
    "provider": "nahcrof",
    "model": "kimi-k2.6-precision",
    "thinkingLevel": "high",
    "analysisSession": "isolated"
  }
}
```

If you leave off `:thinking`, no thinking flag is passed to the backend.

The backend model must exist in your pi model registry and must support image input.

## Conversation awareness

Media analysis runs in a short-lived backend pi process. `analysisSession` controls how much conversation that backend can see:

- `"isolated"` starts the analyzer with no prior conversation. This is the default. It is best when you want the media summary to stand on its own.
- `"fork"` gives the analyzer a temporary fork of the current pi session. This is useful when the image only makes sense with earlier chat context, for example “compare this to the previous screenshot.”

Both modes are ephemeral. Isolated analysis uses `--no-session`. Forked analysis writes into a temporary session directory and deletes it after the analysis finishes. If pi cannot find the current session file, fork mode safely falls back to isolated mode.

The analyzer is also told which mode it is in, so it knows whether it can rely on previous conversation or must only use the media and the analysis prompt.

## Compatibility with custom tool providers

By default, `pi-multi-modal` registers its own `read` and `bash` tools so it can intercept media reads and inject the `__PI_IMAGE__` helper.

That is perfect for normal pi. It can be wrong if your setup already provides replacement `read` or `bash` tools — for example a local wrapper, company launcher, performance extension, or another pi extension that reserves the same tool names. In that case two extensions may try to own `read` or `bash`, and pi-multi-modal should wrap the existing tools instead of registering competing ones.

Set this before launching pi:

```bash
export PI_MULTI_MODAL_WRAP_EXISTING_TOOLS=1
```

In wrap mode, `pi-multi-modal` does **not** register public `read` or `bash` tools. Instead, it listens around whatever tools already exist and only changes the media-specific parts:

- ordinary text reads stay with your existing `read` tool
- ordinary bash commands stay with your existing `bash` tool
- explicit media reads can become vision summaries
- bash commands using `__PI_IMAGE__` can return inline images or summaries

Use this mode only when another package already owns `read` or `bash`. If you are unsure, leave it unset.

Example wrapper setup:

```bash
export PI_MULTI_MODAL_WRAP_EXISTING_TOOLS=1
alias pi='my-pi-wrapper pi'
```

The internal analyzer also clears inherited package-launcher state before it starts the backend pi process, so the media analysis subprocess does not accidentally recurse through the same wrapper environment.

## Supported formats

Native image attachment:

- `.jpg`, `.jpeg`
- `.png`
- `.gif`
- `.webp`

Vision-backend analysis:

- images: `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`
- videos: `.mp4`, `.mkv`, `.mov`
- PDFs: `.pdf`

Video analysis needs `ffmpeg` and `ffprobe` in `PATH`.
PDF analysis needs Ghostscript's `gs` in `PATH`.

## Commands

```text
/multi-modal <provider/model[:thinking]>
/analyze-image <path>
/analyze-video <path>
```

`/multi-modal` changes the backend used for media summaries. The analyze commands are manual shortcuts when you want to inspect media directly.

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

## Development

```bash
npm install
npm test
npx tsc --noEmit
```

Full local check:

```bash
npm run check
```

Integration tests call a real vision backend. Pick an explicit pi-registered image model:

```bash
PI_MULTI_MODAL_TEST_BACKEND=nahcrof/kimi-k2.5-lightning npm run test:integration
```

Do not rely on personal `~/.pi/agent/settings.json` for integration tests.

To benchmark whether `analysisSession` is behaving correctly across live pi runs:

```bash
npm run benchmark:analysis-session
```

The benchmark checks the important contract: isolated analyzers should not see a prior conversation tag; forked analyzers should.

Use a narrower model set when you want a cheaper run:

```bash
PI_MULTI_MODAL_BENCH_MODELS=nahcrof/kimi-k2.5-lightning \
PI_MULTI_MODAL_BENCH_REPEATS=1 \
npm run benchmark:analysis-session
```

See [test-fixtures/README.md](./test-fixtures/README.md) for fixture details.

## License

MIT
