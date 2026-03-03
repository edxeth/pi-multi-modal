/**
 * GLM Image Summary Extension
 *
 * When using non-vision GLM models (glm-4.6, glm-4.7, glm-4.7-flash, glm-5), this
 * extension intercepts image/video reads and sends them to glm-4.6v for detailed
 * analysis.
 *
 * Usage:
 *   pi -e npm:pi-glm-image-summary --provider zai --model glm-4.7
 */

import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { BorderedLoader, createReadTool } from "@mariozechner/pi-coding-agent";
import {
	extractTextFromPiOutput,
	isImageFile,
	isVideoFile,
	needsVisionProxy,
	VISION_MODEL,
	VISION_PROVIDER,
} from "./utils.js";

// Embedded skill prompt for GLM-4.6v
const IMAGE_ANALYSIS_PROMPT = `You are analyzing an image. Follow these steps:

## Step 1: Classify

First, identify what type of image this is and state your classification:

**Category**: [one of: ui-screenshot, code-screenshot, error-screenshot, diagram, chart, general]

Categories:
- ui-screenshot — Web or mobile interface (buttons, forms, navigation, dashboard)
- code-screenshot — Source code visible in editor or terminal
- error-screenshot — Error message, stack trace, terminal error, build failure
- diagram — Architecture, flowchart, UML, ER, sequence diagram, system design
- chart — Data visualization (bar chart, line graph, pie chart, dashboard metrics)
- general — Photo, logo, illustration, or anything else

## Step 2: Analyze

Based on your classification, provide the appropriate analysis:

### For ui-screenshot:
- Describe the layout structure (sidebar, header, main content, footer)
- List all visible UI components (buttons, forms, cards, tables, navigation)
- Note the color scheme and visual style
- Extract all visible text (labels, buttons, headings, data values)
- Identify interactive elements and their likely functionality

### For code-screenshot:
- Identify the programming language
- Extract the complete code with 100% accuracy
- Preserve exact indentation and formatting
- Include line numbers if visible
- Note any imports, function definitions, or key patterns
- Output the code in a properly formatted code block

### For error-screenshot:
- Identify the error type (syntax, runtime, build, network, etc.)
- Extract the exact error message
- Analyze the stack trace if present (file paths, line numbers, function names)
- Identify the root cause
- Suggest a fix with code examples if applicable

### For diagram:
- Identify the diagram type (architecture, flowchart, UML, ER, sequence, etc.)
- List all components/nodes shown
- Describe relationships and connections between elements
- Explain the data flow or structure depicted
- Note any labels, protocols, or annotations

### For chart:
- Identify the chart type (bar, line, pie, scatter, combination, etc.)
- Extract the title, axis labels, and legend
- Describe the data ranges and values
- Identify trends, patterns, or anomalies
- Summarize the key insights from the data

### For general:
- Describe the primary subject
- List all visible objects and elements
- Note colors, composition, and style
- Describe the mood or context
- Highlight notable or interesting features

## Output Format

Always start your response with:

**Category**: [category-name]

Then provide your detailed analysis using the appropriate template above.`;

const VIDEO_ANALYSIS_PROMPT = `You are analyzing a video represented as chronological keyframes.

Output exactly:
- **Category**: [one of: ui-demo, code-demo, error-demo, screencast, general-video]
- A short timeline summary (3-6 bullets).
- Any visible text/errors worth noting.`;

interface AnalyzeImageOptions {
	absolutePath: string;
	signal?: AbortSignal;
}

interface AnalyzeVideoOptions {
	absolutePath: string;
	signal?: AbortSignal;
}

interface AnalyzeWithPiOptions {
	attachmentPaths: string[];
	prompt: string;
	signal?: AbortSignal;
}

async function analyzeWithPi({ attachmentPaths, prompt, signal }: AnalyzeWithPiOptions): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		const args = [
			...attachmentPaths.map((path) => `@${path}`),
			"--provider",
			VISION_PROVIDER,
			"--model",
			VISION_MODEL,
			"--print",
			"--json",
			"--no-extensions",
			"-p",
			prompt,
		];

		const child = spawn("pi", args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});

		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (data: Buffer) => {
			stdout += data.toString();
		});

		child.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		child.on("error", (err: Error) => {
			reject(err);
		});

		child.on("close", (code: number | null) => {
			if (code !== 0) {
				reject(new Error(`pi subprocess failed (${code}): ${stderr}`));
			} else {
				resolvePromise(extractTextFromPiOutput(stdout.trim()));
			}
		});

		if (signal) {
			const onAbort = () => {
				child.kill();
				reject(new Error("Operation aborted"));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			child.on("close", () => {
				signal.removeEventListener("abort", onAbort);
			});
		}
	});
}

async function analyzeImage({ absolutePath, signal }: AnalyzeImageOptions): Promise<string> {
	return analyzeWithPi({
		attachmentPaths: [absolutePath],
		prompt: IMAGE_ANALYSIS_PROMPT,
		signal,
	});
}

async function getVideoDurationSeconds(absolutePath: string, signal?: AbortSignal): Promise<number | null> {
	return new Promise((resolvePromise, reject) => {
		const args = [
			"-v",
			"error",
			"-show_entries",
			"format=duration",
			"-of",
			"default=nokey=1:noprint_wrappers=1",
			absolutePath,
		];

		const child = spawn("ffprobe", args, {
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (data: Buffer) => {
			stdout += data.toString();
		});

		child.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		child.on("error", (err: Error) => reject(err));

		child.on("close", (code: number | null) => {
			if (code !== 0) {
				reject(new Error(`ffprobe failed (${code}): ${stderr}`));
				return;
			}
			const duration = Number.parseFloat(stdout.trim());
			resolvePromise(Number.isFinite(duration) && duration > 0 ? duration : null);
		});

		if (signal) {
			const onAbort = () => {
				child.kill();
				reject(new Error("Operation aborted"));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			child.on("close", () => signal.removeEventListener("abort", onAbort));
		}
	});
}

async function extractVideoFrames(absolutePath: string, framesDir: string, signal?: AbortSignal): Promise<string[]> {
	const duration = await getVideoDurationSeconds(absolutePath, signal);
	const interval = duration ? Math.max(duration / 3, 0.75) : 2;
	const fpsFilter = `fps=1/${interval.toFixed(2)}`;
	const outputPattern = join(framesDir, "frame_%03d.jpg");

	await new Promise<void>((resolvePromise, reject) => {
		const args = [
			"-hide_banner",
			"-loglevel",
			"error",
			"-i",
			absolutePath,
			"-vf",
			fpsFilter,
			"-frames:v",
			"3",
			outputPattern,
		];

		const child = spawn("ffmpeg", args, {
			stdio: ["ignore", "ignore", "pipe"],
		});

		let stderr = "";
		child.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		child.on("error", (err: Error) => reject(err));
		child.on("close", (code: number | null) => {
			if (code !== 0) {
				reject(new Error(`ffmpeg failed (${code}): ${stderr}`));
			} else {
				resolvePromise();
			}
		});

		if (signal) {
			const onAbort = () => {
				child.kill();
				reject(new Error("Operation aborted"));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			child.on("close", () => signal.removeEventListener("abort", onAbort));
		}
	});

	const files = await readdir(framesDir);
	return files
		.filter((name) => name.toLowerCase().endsWith(".jpg"))
		.sort((a, b) => a.localeCompare(b))
		.map((name) => join(framesDir, name));
}

async function analyzeVideo({ absolutePath, signal }: AnalyzeVideoOptions): Promise<string> {
	const framesDir = await mkdtemp(join(process.cwd(), ".glm-vision-frames-"));
	let succeeded = false;

	try {
		const frames = await extractVideoFrames(absolutePath, framesDir, signal);
		if (frames.length === 0) {
			throw new Error("No frames could be extracted from video");
		}

		const analysis = await analyzeWithPi({
			attachmentPaths: frames,
			prompt: VIDEO_ANALYSIS_PROMPT,
			signal,
		});
		succeeded = true;
		return analysis;
	} finally {
		if (succeeded) {
			await rm(framesDir, { recursive: true, force: true });
		} else {
			setTimeout(() => {
				void rm(framesDir, { recursive: true, force: true });
			}, 30_000);
		}
	}
}

export default function (pi: ExtensionAPI) {
	const localRead = createReadTool(process.cwd());

	// Override read to intercept image/video reads for non-vision models
	pi.registerTool({
		...localRead,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { path } = params;
			const absolutePath = resolve(ctx.cwd, path);
			const image = isImageFile(absolutePath);
			const video = isVideoFile(absolutePath);

			if (!needsVisionProxy(ctx.model?.id) || (!image && !video)) {
				return localRead.execute(toolCallId, params, signal, onUpdate);
			}

			const mediaType = video ? "video" : "image";
			onUpdate?.({
				content: [
					{
						type: "text",
						text: video
							? `[Extracting keyframes and analyzing video with ${VISION_MODEL}...]`
							: `[Analyzing image with ${VISION_MODEL}...]`,
					},
				],
				details: {},
			});

			try {
				const summaryText = video
					? await analyzeVideo({ absolutePath })
					: await analyzeImage({ absolutePath });

				if (signal?.aborted) {
					throw new Error("Operation aborted");
				}

				const label = video ? "Video" : "Image";
				const result = {
					content: [{ type: "text" as const, text: `[${label} analyzed with ${VISION_MODEL}]\n\n${summaryText}` }],
					details: {},
				};

				onUpdate?.(result);
				return result;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`${mediaType[0].toUpperCase()}${mediaType.slice(1)} analysis failed: ${message}`);
			}
		},
	});

	// Command for manual image analysis
	pi.registerCommand("analyze-image", {
		description: `Analyze an image file using ${VISION_MODEL}`,
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("analyze-image requires interactive mode", "error");
				return;
			}

			const imagePath = args.trim();
			if (!imagePath) {
				ctx.ui.notify("Usage: /analyze-image <path-to-image>", "error");
				return;
			}

			const absolutePath = resolve(ctx.cwd, imagePath);

			if (!isImageFile(absolutePath)) {
				ctx.ui.notify("Not a supported image file", "error");
				return;
			}

			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, `Analyzing ${imagePath}...`);
				loader.onAbort = () => done(null);

				analyzeImage({ absolutePath, signal: loader.signal })
					.then((text) => done(text))
					.catch((err) => {
						ctx.ui.notify(`Analysis failed: ${err.message}`, "error");
						done(null);
					});

				return loader;
			});

			if (result === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			await ctx.ui.editor("Image Analysis", result);
		},
	});

	// Command for manual video analysis
	pi.registerCommand("analyze-video", {
		description: `Analyze a video file using ${VISION_MODEL}`,
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("analyze-video requires interactive mode", "error");
				return;
			}

			const videoPath = args.trim();
			if (!videoPath) {
				ctx.ui.notify("Usage: /analyze-video <path-to-video>", "error");
				return;
			}

			const absolutePath = resolve(ctx.cwd, videoPath);
			if (!isVideoFile(absolutePath)) {
				ctx.ui.notify("Not a supported video file", "error");
				return;
			}

			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, `Analyzing ${videoPath}...`);
				loader.onAbort = () => done(null);

				analyzeVideo({ absolutePath, signal: loader.signal })
					.then((text) => done(text))
					.catch((err) => {
						ctx.ui.notify(`Analysis failed: ${err.message}`, "error");
						done(null);
					});

				return loader;
			});

			if (result === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			await ctx.ui.editor("Video Analysis", result);
		},
	});
}
