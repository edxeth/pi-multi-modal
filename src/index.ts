/**
 * Vision fallback extension.
 *
 * For any model without native image input support, this extension can attach explicit
 * @image paths directly in the conversation, and it proxies media analysis through
 * glm-4.6v for non-vision read requests.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ImageContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { BorderedLoader, createBashTool, createReadTool } from "@mariozechner/pi-coding-agent";
import { type Component, Container, Image, Spacer, Text } from "@mariozechner/pi-tui";
import { extensionForImageMimeType, readClipboardImage } from "./clipboard-image.js";
import {
	extractTextFromPiOutput,
	findExplicitImagePaths,
	findExplicitMediaPaths,
	getAvailableVisionProviders,
	isImageFile,
	isPdfFile,
	isVideoFile,
	needsVisionProxy,
	PI_BASH_IMAGE_MARKER_PREFIX,
	parseBashImageOutput,
	pickPreferredVisionProvider,
	replaceExplicitInlineImagePathsWithPlaceholders,
	resolveShowImagesSetting,
	sanitizeImagePromptForProvider,
	shouldRetryWithFallbackVisionProvider,
	supportsNativeImageInput,
	VISION_MODEL,
	VISION_PROVIDER_CANDIDATES,
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

const PDF_ANALYSIS_PROMPT = `You are analyzing a PDF document. Follow these steps:

## Step 1: Document Overview

First, identify the document type and structure:
- **Document Type**: [one of: report, paper, manual, form, presentation, contract, other]
- **Page Count**: Number of pages
- **Title**: Document title if present

## Step 2: Content Analysis

Extract and summarize the key content:
- Main topics/sections covered
- Key findings or conclusions
- Important data, tables, or figures
- Any actionable items or recommendations

## Output Format

Always start your response with:

**Document Type**: [type]
**Title**: [title or "Not found"]
**Pages**: [count]

Then provide your detailed analysis.`;

const REFERENCED_IMAGES_MESSAGE_TYPE = "referenced-images";
const BASH_IMAGE_GUIDELINE =
	"The bash environment has a built-in `__PI_IMAGE__` helper. Use it with screenshot-producing CLIs like `agent-browser` to include image output in the same bash result. Append `&& __PI_IMAGE__ <path>` to your command, or pipe text into it with `| __PI_IMAGE__ <path>`.";
const BASH_IMAGE_PREAMBLE = [
	`__PI_IMAGE__() {`,
	`  if [ -p /dev/stdin ]; then cat; printf '\n'; fi`,
	`  for f in "$@"; do`,
	`    _pi_image_path=$(realpath "$f" 2>/dev/null)`,
	`    if [ -n "$_pi_image_path" ] && [ -f "$_pi_image_path" ]; then`,
	`      echo "${PI_BASH_IMAGE_MARKER_PREFIX}$_pi_image_path"`,
	`    else`,
	`      echo "[__PI_IMAGE__: file not found: $f]" >&2`,
	`    fi`,
	`  done`,
	`}`,
].join("\n");

type ToolTextBlock = { type: "text"; text: string };
type ToolContentBlock = ToolTextBlock | ImageContent;
type ToolResult = { content: ToolContentBlock[]; details: Record<string, never> };
type PreviewCtx = {
	cwd: string;
	ui: {
		setWidget: (
			key: string,
			content: string[] | undefined,
			options?: { placement?: "aboveEditor" | "belowEditor" },
		) => void;
		getEditorText: () => string;
		theme: { fg: (color: string, value: string) => string; bold: (value: string) => string };
	};
};

const IMAGE_PREVIEW_WIDGET_KEY = "multi-modal-image-preview";
const IMAGE_PREVIEW_POLL_MS = 250;

function mimeTypeForImagePath(path: string): ImageContent["mimeType"] | undefined {
	const ext = path.split(".").pop()?.toLowerCase();
	switch (ext) {
		case "jpg":
		case "jpeg":
			return "image/jpeg";
		case "png":
			return "image/png";
		case "gif":
			return "image/gif";
		case "webp":
			return "image/webp";
		default:
			return undefined;
	}
}

function resolveUserPath(cwd: string, inputPath: string): string {
	if (inputPath === "~") {
		return homedir();
	}
	if (inputPath.startsWith("~/")) {
		return join(homedir(), inputPath.slice(2));
	}
	return resolve(cwd, inputPath);
}

async function loadImageAttachment(cwd: string, inputPath: string): Promise<ImageContent | null> {
	const absolutePath = resolveUserPath(cwd, inputPath);
	if (!isImageFile(absolutePath)) {
		return null;
	}

	try {
		await access(absolutePath);
	} catch {
		return null;
	}

	const mimeType = mimeTypeForImagePath(absolutePath);
	if (!mimeType) {
		return null;
	}

	const data = (await readFile(absolutePath)).toString("base64");
	return { type: "image", data, mimeType };
}

interface ReferencedImagePreviewItem {
	path: string;
	data: string;
	mimeType: ImageContent["mimeType"];
}

interface ReferencedImagePreviewDetails {
	showImages: boolean;
	images: ReferencedImagePreviewItem[];
}

async function readJsonFileIfExists(path: string): Promise<unknown | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf-8"));
	} catch {
		return undefined;
	}
}

async function getShowImagesSetting(cwd: string): Promise<boolean> {
	const [globalSettings, projectSettings] = await Promise.all([
		readJsonFileIfExists(join(homedir(), ".pi", "agent", "settings.json")),
		readJsonFileIfExists(join(cwd, ".pi", "settings.json")),
	]);
	return resolveShowImagesSetting(globalSettings, projectSettings);
}

async function loadReferencedImagePreviews(cwd: string, text: string): Promise<ReferencedImagePreviewItem[]> {
	const previews: ReferencedImagePreviewItem[] = [];

	for (const imagePath of findExplicitImagePaths(text)) {
		const loaded = await loadImageAttachment(cwd, imagePath);
		if (!loaded) {
			continue;
		}
		previews.push({ path: resolveUserPath(cwd, imagePath), data: loaded.data, mimeType: loaded.mimeType });
	}

	return previews;
}

function isInTmux(): boolean {
	return Boolean(process.env.TMUX);
}

function createReferencedImagesComponent(
	details: ReferencedImagePreviewDetails,
	theme: {
		fg: (color: "customMessageText", value: string) => string;
	},
): Component {
	const container = new Container();
	if (isInTmux()) {
		const count = details.images.length;
		container.addChild(
			new Text(
				theme.fg("customMessageText", count === 1 ? "📎 1 image attached" : `📎 ${count} images attached`),
				0,
				0,
			),
		);
		return container;
	}
	for (const [index, image] of details.images.entries()) {
		container.addChild(
			new Image(
				image.data,
				image.mimeType,
				{ fallbackColor: (text: string) => theme.fg("customMessageText", text) },
				{ maxWidthCells: 60 },
			),
		);
		if (index < details.images.length - 1) {
			container.addChild(new Spacer(1));
		}
	}
	return container;
}

function createPreviewController() {
	let tracked = new Set<string>();
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let latestCtx: PreviewCtx | null = null;

	function refreshWidget(): void {
		if (!latestCtx) return;
		if (tracked.size === 0) {
			latestCtx.ui.setWidget(IMAGE_PREVIEW_WIDGET_KEY, undefined);
			return;
		}

		const count = tracked.size;
		latestCtx.ui.setWidget(
			IMAGE_PREVIEW_WIDGET_KEY,
			[count === 1 ? "📎 1 image attached" : `📎 ${count} images attached`],
			{ placement: "aboveEditor" },
		);
	}

	function resetWidget(ctx?: PreviewCtx | null): void {
		if (ctx) latestCtx = ctx;
		tracked = new Set();
		latestCtx?.ui.setWidget(IMAGE_PREVIEW_WIDGET_KEY, undefined);
	}

	async function scanEditorText(): Promise<void> {
		if (!latestCtx) return;
		if (!(await getShowImagesSetting(latestCtx.cwd))) {
			if (tracked.size > 0) resetWidget();
			return;
		}

		const text = latestCtx.ui.getEditorText();
		if (!text) {
			if (tracked.size > 0) resetWidget();
			return;
		}

		const currentPaths = new Set(findExplicitImagePaths(text));
		const changed =
			currentPaths.size !== tracked.size || [...currentPaths].some((imagePath) => !tracked.has(imagePath));
		tracked = currentPaths;
		if (changed) refreshWidget();
	}

	return {
		attach(ctx: PreviewCtx) {
			latestCtx = ctx;
			resetWidget(ctx);
			if (pollTimer) clearInterval(pollTimer);
			pollTimer = setInterval(() => {
				void scanEditorText();
			}, IMAGE_PREVIEW_POLL_MS);
		},
		reset(ctx?: PreviewCtx | null) {
			resetWidget(ctx);
		},
		clear(ctx?: PreviewCtx | null) {
			if (pollTimer) {
				clearInterval(pollTimer);
				pollTimer = null;
			}
			resetWidget(ctx);
		},
	};
}

function createVisionAnalysisResult(label: string, summaryText: string): ToolResult {
	return {
		content: [{ type: "text", text: `[${label} analyzed with ${VISION_MODEL}]\n\n${summaryText}` }],
		details: {},
	};
}

async function analyzeMediaToolResult(
	absolutePath: string,
	options: {
		image: boolean;
		video: boolean;
		pdf: boolean;
		preferredProvider: string;
		signal?: AbortSignal;
		onUpdate?: (result: ToolResult) => void;
	},
): Promise<ToolResult> {
	const { video, pdf, preferredProvider, signal, onUpdate } = options;
	const mediaType = video ? "video" : pdf ? "PDF" : "image";
	onUpdate?.({
		content: [
			{
				type: "text",
				text: video
					? `[Extracting keyframes and analyzing video with ${VISION_MODEL}...]`
					: pdf
						? `[Analyzing PDF with ${VISION_MODEL}...]`
						: `[Analyzing image with ${VISION_MODEL}...]`,
			},
		],
		details: {},
	});

	try {
		const summaryText = video
			? await analyzeVideo({ absolutePath, preferredProvider, signal })
			: pdf
				? await analyzePdf({ absolutePath, preferredProvider, signal })
				: await analyzeImage({ absolutePath, preferredProvider, signal });

		if (signal?.aborted) {
			throw new Error("Operation aborted");
		}

		const result = createVisionAnalysisResult(video ? "Video" : pdf ? "PDF" : "Image", summaryText);
		onUpdate?.(result);
		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${mediaType[0].toUpperCase()}${mediaType.slice(1)} analysis failed: ${message}`);
	}
}

interface AnalyzeImageOptions {
	absolutePath: string;
	preferredProvider: string;
	signal?: AbortSignal;
}

interface AnalyzeVideoOptions {
	absolutePath: string;
	preferredProvider: string;
	signal?: AbortSignal;
}

interface AnalyzePdfOptions {
	absolutePath: string;
	preferredProvider: string;
	signal?: AbortSignal;
}

interface AnalyzeWithPiBaseOptions {
	attachmentPaths: string[];
	prompt: string;
	model: string;
	signal?: AbortSignal;
}

interface AnalyzeWithPiOptions extends AnalyzeWithPiBaseOptions {
	preferredProvider: string;
}

interface AnalyzeWithPiProviderOptions extends AnalyzeWithPiBaseOptions {
	provider: string;
}

function resolvePreferredVisionProvider(modelRegistry: {
	getAvailable(): Array<{ provider: string; id: string }>;
}): string {
	return pickPreferredVisionProvider(getAvailableVisionProviders(modelRegistry.getAvailable()));
}

async function analyzeWithPiProvider({
	attachmentPaths,
	prompt,
	provider,
	model,
	signal,
}: AnalyzeWithPiProviderOptions): Promise<string> {
	return new Promise((resolvePromise, reject) => {
		const args = [
			...attachmentPaths.map((path) => `@${path}`),
			"--provider",
			provider,
			"--model",
			model,
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

async function analyzeWithPi({
	attachmentPaths,
	prompt,
	model,
	preferredProvider,
	signal,
}: AnalyzeWithPiOptions): Promise<string> {
	const providers = [
		preferredProvider,
		...VISION_PROVIDER_CANDIDATES.filter((provider) => provider !== preferredProvider),
	];
	let lastError: unknown;

	for (const [index, provider] of providers.entries()) {
		try {
			return await analyzeWithPiProvider({ attachmentPaths, prompt, provider, model, signal });
		} catch (error) {
			lastError = error;
			const hasFallback = index < providers.length - 1;
			if (!hasFallback || !shouldRetryWithFallbackVisionProvider(error)) {
				throw error;
			}
		}
	}

	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function analyzeImage({ absolutePath, preferredProvider, signal }: AnalyzeImageOptions): Promise<string> {
	return analyzeWithPi({
		attachmentPaths: [absolutePath],
		prompt: IMAGE_ANALYSIS_PROMPT,
		model: VISION_MODEL,
		preferredProvider,
		signal,
	});
}

async function extractPdfPages(absolutePath: string, pagesDir: string, signal?: AbortSignal): Promise<string[]> {
	const outputPattern = join(pagesDir, "page_%03d.png");

	await new Promise<void>((resolvePromise, reject) => {
		const args = [
			"-dNOPAUSE",
			"-dBATCH",
			"-sDEVICE=png16m",
			"-r144",
			"-dFirstPage=1",
			"-dLastPage=6",
			`-sOutputFile=${outputPattern}`,
			absolutePath,
		];

		const child = spawn("gs", args, {
			stdio: ["ignore", "ignore", "pipe"],
		});

		let stderr = "";
		child.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		child.on("error", (err: Error) => reject(err));
		child.on("close", (code: number | null) => {
			if (code !== 0) {
				reject(new Error(`gs failed (${code}): ${stderr}`));
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

	const files = await readdir(pagesDir);
	return files
		.filter((name) => name.toLowerCase().endsWith(".png"))
		.sort((a, b) => a.localeCompare(b))
		.map((name) => join(pagesDir, name));
}

async function analyzePdf({ absolutePath, preferredProvider, signal }: AnalyzePdfOptions): Promise<string> {
	const pagesDir = await mkdtemp(join(process.cwd(), ".glm-vision-pdf-"));
	let succeeded = false;

	try {
		const pages = await extractPdfPages(absolutePath, pagesDir, signal);
		if (pages.length === 0) {
			throw new Error("No pages could be extracted from PDF");
		}

		const analysis = await analyzeWithPi({
			attachmentPaths: pages,
			prompt: `${PDF_ANALYSIS_PROMPT}\n\nThe attached images are rendered pages from a PDF in order.`,
			model: VISION_MODEL,
			preferredProvider,
			signal,
		});
		succeeded = true;
		return analysis;
	} finally {
		if (succeeded) {
			await rm(pagesDir, { recursive: true, force: true });
		} else {
			setTimeout(() => {
				void rm(pagesDir, { recursive: true, force: true });
			}, 30_000);
		}
	}
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

async function analyzeVideo({ absolutePath, preferredProvider, signal }: AnalyzeVideoOptions): Promise<string> {
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
			model: VISION_MODEL,
			preferredProvider,
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

const WINDOWS_POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
const MAX_CLIPBOARD_TEXT_BYTES = 5 * 1024 * 1024;

function setWeztermUserVar(name: string, value: string): void {
	if (!process.stdout.isTTY) {
		return;
	}

	const encoded = Buffer.from(value, "utf-8").toString("base64");
	const sequence = `\u001b]1337;SetUserVar=${name}=${encoded}\u0007`;
	if (process.env.TMUX) {
		process.stdout.write(`\u001bPtmux;${sequence.split("\u001b").join("\u001b\u001b")}\u001b\\`);
		return;
	}

	const isWezTerm =
		process.env.TERM_PROGRAM === "WezTerm" ||
		Boolean(process.env.WEZTERM_PANE) ||
		Boolean(process.env.WEZTERM_EXECUTABLE);
	if (!isWezTerm) {
		return;
	}

	process.stdout.write(sequence);
}

function clipboardHasImageHint(): boolean {
	const hasImage = (text: string) =>
		text
			.split(/\r?\n/)
			.map((line) => line.trim().toLowerCase().split(";")[0])
			.some((line) => line.startsWith("image/"));

	if (process.env.WAYLAND_DISPLAY) {
		const result = spawnSync("wl-paste", ["--list-types"], { timeout: 1000, maxBuffer: 64 * 1024 });
		if (!result.error && result.status === 0 && hasImage(result.stdout?.toString("utf-8") ?? "")) {
			return true;
		}
	}

	if (process.env.DISPLAY) {
		const result = spawnSync("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], {
			timeout: 1000,
			maxBuffer: 64 * 1024,
		});
		if (!result.error && result.status === 0 && hasImage(result.stdout?.toString("utf-8") ?? "")) {
			return true;
		}
	}

	return false;
}

function readClipboardText(): string | null {
	const normalize = (text: string) => text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const fromResult = (result: ReturnType<typeof spawnSync>): string | null => {
		if (result.error || result.status !== 0) {
			return null;
		}
		const text = normalize(result.stdout?.toString("utf-8") ?? "");
		return text.length > 0 ? text : null;
	};

	if (process.env.WAYLAND_DISPLAY) {
		const text = fromResult(
			spawnSync("wl-paste", ["--no-newline"], { timeout: 1000, maxBuffer: MAX_CLIPBOARD_TEXT_BYTES }),
		);
		if (text) {
			return text;
		}
	}

	if (process.env.DISPLAY) {
		const text = fromResult(
			spawnSync("xclip", ["-selection", "clipboard", "-o"], {
				timeout: 1000,
				maxBuffer: MAX_CLIPBOARD_TEXT_BYTES,
			}),
		);
		if (text) {
			return text;
		}
	}

	if (process.env.WSL_INTEROP) {
		return fromResult(
			spawnSync(
				WINDOWS_POWERSHELL,
				[
					"-NoLogo",
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					'[Console]::Out.Write((Get-Clipboard -Raw).ToString().Replace("`r", ""))',
				],
				{ timeout: 3000, maxBuffer: MAX_CLIPBOARD_TEXT_BYTES },
			),
		);
	}

	return null;
}

async function pasteClipboardIntoEditor(
	ctx: Parameters<NonNullable<ExtensionAPI["registerShortcut"]>>[1]["handler"] extends (ctx: infer T) => unknown
		? T
		: never,
): Promise<boolean> {
	const ui = ctx.ui as typeof ctx.ui & { pasteToEditor?: (text: string) => void };
	const forceRender = () => ui.setWidget("__smart_paste_render", undefined);
	const paste = (text: string) => {
		if (typeof ui.pasteToEditor === "function") {
			ui.pasteToEditor(text);
		} else {
			ui.setEditorText(ui.getEditorText() + text);
		}
		forceRender();
	};
	const hasImageHint = clipboardHasImageHint();

	if (hasImageHint) {
		const image = await readClipboardImage();
		if (image) {
			const ext = extensionForImageMimeType(image.mimeType) ?? "png";
			const filePath = join(tmpdir(), `pi-clipboard-${randomUUID()}.${ext}`);
			await writeFile(filePath, image.bytes);
			paste(`@${filePath}`);
			return true;
		}
	}

	const text = readClipboardText();
	if (text) {
		paste(text);
		return true;
	}

	if (!hasImageHint) {
		const image = await readClipboardImage();
		if (image) {
			const ext = extensionForImageMimeType(image.mimeType) ?? "png";
			const filePath = join(tmpdir(), `pi-clipboard-${randomUUID()}.${ext}`);
			await writeFile(filePath, image.bytes);
			paste(`@${filePath}`);
			return true;
		}
	}

	return false;
}

async function resolveInlineBashImageContent(
	path: string,
	options: {
		localRead: ReturnType<typeof createReadTool>;
		ctx: Parameters<ExtensionAPI["on"]>[1] extends (event: never, ctx: infer T) => unknown ? T : never;
		signal?: AbortSignal;
	},
): Promise<ToolContentBlock[] | { error: string }> {
	const { localRead, ctx, signal } = options;
	const absolutePath = resolveUserPath(ctx.cwd, path);
	if (!isImageFile(absolutePath)) {
		return { error: `not a supported image (png/jpg/gif/webp): ${path}` };
	}

	if (needsVisionProxy(ctx.model?.input)) {
		const preferredProvider = resolvePreferredVisionProvider(ctx.modelRegistry);
		const result = await analyzeMediaToolResult(absolutePath, {
			image: true,
			video: false,
			pdf: false,
			preferredProvider,
			signal,
		});
		return result.content;
	}

	const result = await localRead.execute("__pi_image__", { path: absolutePath }, signal);
	const hasImage = result.content.some((block): block is ImageContent => block.type === "image");
	if (!hasImage) {
		return { error: `not a supported image (png/jpg/gif/webp): ${path}` };
	}
	return result.content as ToolContentBlock[];
}

async function processBashResult(
	result: { content: ToolContentBlock[]; details?: unknown },
	options: {
		localRead: ReturnType<typeof createReadTool>;
		ctx: Parameters<ExtensionAPI["on"]>[1] extends (event: never, ctx: infer T) => unknown ? T : never;
		signal?: AbortSignal;
	},
): Promise<{ content: ToolContentBlock[]; details?: unknown; foundMarkers: boolean }> {
	const content: ToolContentBlock[] = [];
	let foundMarkers = false;

	for (const block of result.content) {
		if (block.type !== "text") {
			content.push(block);
			continue;
		}

		const parsed = parseBashImageOutput(block.text ?? "");
		foundMarkers ||= parsed.foundMarkers;

		for (const part of parsed.parts) {
			if (part.type === "text") {
				content.push(part);
				continue;
			}

			try {
				const resolved = await resolveInlineBashImageContent(part.path, options);
				if ("error" in resolved) {
					content.push({ type: "text", text: `[__PI_IMAGE__: ${resolved.error}]` });
				} else {
					content.push(...resolved);
				}
			} catch (error) {
				content.push({
					type: "text",
					text: `[__PI_IMAGE__: ${error instanceof Error ? error.message : String(error)}]`,
				});
			}
		}
	}

	return { content, details: result.details, foundMarkers };
}

export default function (pi: ExtensionAPI) {
	const localRead = createReadTool(process.cwd());
	const localBash = createBashTool(process.cwd(), {
		spawnHook: ({ command, cwd, env }) => ({
			command: `${BASH_IMAGE_PREAMBLE}\n${command}`,
			cwd,
			env,
		}),
	});
	let explicitMediaAnalysisPaths = new Set<string>();
	const previewController = createPreviewController();

	const handleSmartPaste = async (
		ctx: Parameters<NonNullable<ExtensionAPI["registerShortcut"]>>[1]["handler"] extends (ctx: infer T) => unknown
			? T
			: never,
	) => {
		if (!ctx.hasUI) {
			return;
		}
		const pasted = await pasteClipboardIntoEditor(ctx);
		if (!pasted) {
			ctx.ui.notify("Clipboard is empty or unsupported", "warning");
		}
	};

	pi.registerShortcut("ctrl+shift+v", {
		description: "Smart paste image or text from clipboard",
		handler: handleSmartPaste,
	});

	pi.registerShortcut("f11", {
		description: "Internal smart paste dispatch",
		handler: handleSmartPaste,
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.hasUI) {
			setWeztermUserVar("PI_SMART_PASTE", "1");
			previewController.attach(ctx as PreviewCtx);
		}
	});

	pi.on("session_switch", async (_event, ctx) => {
		if (ctx.hasUI) {
			previewController.attach(ctx as PreviewCtx);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) {
			setWeztermUserVar("PI_SMART_PASTE", "0");
			previewController.clear(ctx as PreviewCtx);
		}
	});

	pi.registerMessageRenderer<ReferencedImagePreviewDetails>(
		REFERENCED_IMAGES_MESSAGE_TYPE,
		(message, _options, theme) => {
			const details = message.details;
			if (!details || !Array.isArray(details.images) || details.images.length === 0 || !details.showImages) {
				return undefined;
			}
			return createReferencedImagesComponent(details, theme);
		},
	);

	pi.registerTool({
		...localBash,
		description: `${localBash.description} ${BASH_IMAGE_GUIDELINE}`,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const result = await localBash.execute(toolCallId, params, signal, onUpdate);
			const processed = await processBashResult(result as { content: ToolContentBlock[]; details?: unknown }, {
				localRead,
				ctx,
				signal,
			});
			if (!processed.foundMarkers) {
				return result;
			}
			return { content: processed.content, details: processed.details };
		},
	});

	pi.on("turn_end", () => {
		explicitMediaAnalysisPaths = new Set<string>();
	});

	pi.on("input", async (event, ctx) => {
		explicitMediaAnalysisPaths = new Set(
			findExplicitMediaPaths(event.text).map((path) => resolveUserPath(ctx.cwd, path)),
		);
		if (ctx.hasUI) {
			previewController.reset(ctx as PreviewCtx);
		}

		if (!supportsNativeImageInput(ctx.model?.input)) {
			return { action: "continue" };
		}

		const explicitImagePaths = findExplicitImagePaths(event.text);
		if (explicitImagePaths.length === 0) {
			return { action: "continue" };
		}

		const attachments = [...(event.images ?? [])];
		let changed = false;

		for (const imagePath of explicitImagePaths) {
			const loaded = await loadImageAttachment(ctx.cwd, imagePath);
			if (!loaded) {
				continue;
			}

			attachments.push(loaded);
			changed = true;
		}

		if (!changed) {
			return { action: "continue" };
		}

		return {
			action: "transform",
			text: event.text,
			images: attachments,
		};
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!ctx.hasUI) {
			return undefined;
		}

		const showImages = await getShowImagesSetting(ctx.cwd);
		if (!showImages) {
			return undefined;
		}

		const images = await loadReferencedImagePreviews(ctx.cwd, event.prompt);
		if (images.length === 0) {
			return undefined;
		}

		return {
			message: {
				customType: REFERENCED_IMAGES_MESSAGE_TYPE,
				content: "",
				display: true,
				details: {
					showImages,
					images,
				},
			},
		};
	});

	pi.on("context", (event, ctx) => {
		const messages = structuredClone(event.messages).filter(
			(message) => message.role !== "custom" || message.customType !== REFERENCED_IMAGES_MESSAGE_TYPE,
		);
		let changed = messages.length !== event.messages.length;

		if (!supportsNativeImageInput(ctx.model?.input)) {
			return changed ? { messages } : undefined;
		}

		for (const message of messages) {
			if (message.role !== "user") {
				continue;
			}
			if (typeof message.content === "string") {
				const sanitized = replaceExplicitInlineImagePathsWithPlaceholders(
					sanitizeImagePromptForProvider(message.content),
				);
				if (sanitized !== message.content) {
					message.content = sanitized;
					changed = true;
				}
				continue;
			}

			const imageBlocks = message.content.filter((block) => block.type === "image");
			const textBlocks = message.content
				.filter((block) => block.type === "text")
				.map((block) => {
					const sanitized = replaceExplicitInlineImagePathsWithPlaceholders(sanitizeImagePromptForProvider(block.text));
					if (sanitized !== block.text) {
						changed = true;
					}
					return { ...block, text: sanitized };
				});
			const otherBlocks = message.content.filter((block) => block.type !== "image" && block.type !== "text");

			if (imageBlocks.length > 0) {
				const reordered = [...imageBlocks, ...textBlocks, ...otherBlocks];
				if (JSON.stringify(reordered) !== JSON.stringify(message.content)) {
					message.content = reordered;
					changed = true;
				}
			} else if (textBlocks.length > 0 || otherBlocks.length > 0) {
				const rebuilt = [...textBlocks, ...otherBlocks];
				if (JSON.stringify(rebuilt) !== JSON.stringify(message.content)) {
					message.content = rebuilt;
					changed = true;
				}
			}
		}

		return changed ? { messages } : undefined;
	});

	// Override read to intercept image/video/PDF reads for non-vision models
	pi.registerTool({
		...localRead,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { path } = params;
			const absolutePath = resolveUserPath(ctx.cwd, path);
			const image = isImageFile(absolutePath);
			const video = isVideoFile(absolutePath);
			const pdf = isPdfFile(absolutePath);

			if (!needsVisionProxy(ctx.model?.input) || (!image && !video && !pdf)) {
				return localRead.execute(toolCallId, params, signal, onUpdate);
			}

			if (!explicitMediaAnalysisPaths.has(absolutePath)) {
				return localRead.execute(toolCallId, params, signal, onUpdate);
			}

			const preferredProvider = resolvePreferredVisionProvider(ctx.modelRegistry);
			return analyzeMediaToolResult(absolutePath, {
				image,
				video,
				pdf,
				preferredProvider,
				signal,
				onUpdate,
			});
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

			const preferredProvider = resolvePreferredVisionProvider(ctx.modelRegistry);
			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, `Analyzing ${imagePath}...`);
				loader.onAbort = () => done(null);

				analyzeImage({ absolutePath, preferredProvider, signal: loader.signal })
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

			const preferredProvider = resolvePreferredVisionProvider(ctx.modelRegistry);
			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, `Analyzing ${videoPath}...`);
				loader.onAbort = () => done(null);

				analyzeVideo({ absolutePath, preferredProvider, signal: loader.signal })
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
