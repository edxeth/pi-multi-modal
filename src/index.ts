/**
 * Media fallback extension.
 *
 * For any model without native image input support, this extension can attach explicit
 * @image paths directly in the conversation, and it proxies media analysis through
 * a configurable backend for non-vision read requests.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ImageContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { BorderedLoader, createBashTool, createReadTool, getAgentDir } from "@mariozechner/pi-coding-agent";
import { type Component, Container, Image, Spacer, Text } from "@mariozechner/pi-tui";
import { extensionForImageMimeType, readClipboardImage } from "./clipboard-image.js";
import {
	type AnalysisSessionMode,
	DEFAULT_ANALYSIS_SESSION_MODE,
	DEFAULT_MULTI_MODAL_BACKEND,
	extractErrorFromPiOutput,
	extractTextFromPiOutput,
	findExplicitImagePaths,
	findExplicitMediaPaths,
	formatMultiModalBackend,
	isImageFile,
	isPdfFile,
	isVideoFile,
	type MultiModalBackendConfig,
	needsVisionProxy,
	PI_BASH_IMAGE_MARKER_PREFIX,
	parseBashImageOutput,
	parseMultiModalBackend,
	readAnalysisSessionModeSetting,
	readMultiModalBackendSetting,
	resolveShowImagesSetting,
	supportsNativeImageInput,
} from "./utils.js";

const CLIPBOARD_IMAGE_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function createClipboardImageId(length = 8): string {
	let id = "";
	for (let index = 0; index < length; index += 1) {
		id += CLIPBOARD_IMAGE_ID_ALPHABET[randomInt(CLIPBOARD_IMAGE_ID_ALPHABET.length)];
	}
	return id;
}

// Embedded analysis prompt for the configured media backend
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
type ReadParams = { path: string; offset?: number; limit?: number };
type AttachmentIndicatorCtx = {
	cwd: string;
	ui: {
		setWidget: (
			key: string,
			content: string[] | undefined,
			options?: { placement?: "aboveEditor" | "belowEditor" },
		) => void;
		getEditorText: () => string;
	};
};

const ATTACHMENT_INDICATOR_WIDGET_KEY = "multi-modal-attachment-indicator";
const ATTACHMENT_INDICATOR_POLL_MS = 250;
const EXPLICIT_MEDIA_ANALYSIS_CONCURRENCY = 3;

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

function envFlagEnabled(name: string): boolean {
	return /^(1|true|yes|on)$/i.test(process.env[name] ?? "");
}

function wrapExistingToolsEnabled(): boolean {
	return envFlagEnabled("PI_MULTI_MODAL_WRAP_EXISTING_TOOLS");
}

function fastHelpersEnabled(): boolean {
	return envFlagEnabled("PI_MULTI_MODAL_FAST_HELPERS");
}

function fastToolsDir(): string {
	return process.env.PI_MULTI_MODAL_FAST_TOOLS_DIR ?? join(getAgentDir(), "fast-tools");
}

function fastToolPath(name: string): string {
	return join(fastToolsDir(), name);
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
	return signal?.aborted || (error instanceof Error && error.name === "AbortError");
}

async function runFastBinaryCapture(cmd: string, args: string[], signal?: AbortSignal): Promise<string> {
	const proc = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], signal });
	let stdout = "";
	let stderr = "";

	proc.stdout.setEncoding("utf8");
	proc.stderr.setEncoding("utf8");
	proc.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	proc.stderr.on("data", (chunk) => {
		stderr += chunk;
	});

	const code = await new Promise<number | null>((resolve, reject) => {
		proc.once("error", reject);
		proc.once("exit", resolve);
	});

	if (code !== 0) {
		throw new Error(stderr.trim() || `${cmd} exited with code ${code}`);
	}

	return stdout;
}

async function tryFastTextRead(
	cwd: string,
	params: ReadParams,
	signal?: AbortSignal,
): Promise<{ content: ToolTextBlock[]; details: undefined } | undefined> {
	if (!fastHelpersEnabled()) {
		return undefined;
	}

	const bin = fastToolPath("fastread-window");
	if (!existsSync(bin)) {
		return undefined;
	}

	const absolutePath = resolveUserPath(cwd, params.path);
	const startLine = Math.max(1, params.offset ?? 1);
	const maxLines = Math.max(1, params.limit ?? 2000);

	try {
		const text = await runFastBinaryCapture(bin, [absolutePath, String(startLine), String(maxLines)], signal);
		return { content: [{ type: "text", text }], details: undefined };
	} catch (error) {
		if (isAbortError(error, signal)) {
			throw error;
		}
		return undefined;
	}
}

async function tryFastBash(
	cwd: string,
	command: string,
	signal?: AbortSignal,
): Promise<{ content: ToolTextBlock[]; details: undefined } | undefined> {
	if (!fastHelpersEnabled() || command.includes("__PI_IMAGE__") || command.includes(PI_BASH_IMAGE_MARKER_PREFIX)) {
		return undefined;
	}

	const fastDrain = fastToolPath("fastdrain");
	const fastCopy = fastToolPath("fastcopy");
	if (!existsSync(fastDrain) || !existsSync(fastCopy)) {
		return undefined;
	}

	const steps: Array<() => Promise<void>> = [];
	const parts = command
		.split("&&")
		.map((part) => part.trim())
		.filter(Boolean);
	if (parts.length === 0) {
		return undefined;
	}

	for (const part of parts) {
		const catMatch = part.match(/^cat\s+(\S+)\s*>\s*\/dev\/null$/);
		if (catMatch) {
			const file = resolveUserPath(cwd, catMatch[1]);
			steps.push(async () => {
				await runFastBinaryCapture(fastDrain, [file], signal);
			});
			continue;
		}

		const cpMatch = part.match(/^cp\s+(\S+)\s+(\S+)$/);
		if (cpMatch) {
			const src = resolveUserPath(cwd, cpMatch[1]);
			const dst = resolveUserPath(cwd, cpMatch[2]);
			steps.push(async () => {
				await mkdir(dirname(dst), { recursive: true });
				await runFastBinaryCapture(fastCopy, [src, dst], signal);
			});
			continue;
		}

		const rmMatch = part.match(/^rm\s+(\S+)$/);
		if (rmMatch) {
			const target = resolveUserPath(cwd, rmMatch[1]);
			steps.push(async () => {
				await rm(target, { force: true });
			});
			continue;
		}

		return undefined;
	}

	try {
		for (const step of steps) {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}
			await step();
		}
		return { content: [{ type: "text", text: "(no output)" }], details: undefined };
	} catch (error) {
		if (isAbortError(error, signal)) {
			throw error;
		}
		return undefined;
	}
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

const GLOBAL_SETTINGS_PATH = join(getAgentDir(), "settings.json");

async function readJsonFileIfExists(path: string): Promise<unknown | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf-8"));
	} catch {
		return undefined;
	}
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function getMultiModalBackend(): Promise<MultiModalBackendConfig> {
	return readMultiModalBackendSetting(await readJsonFileIfExists(GLOBAL_SETTINGS_PATH));
}

async function getAnalysisSessionMode(): Promise<AnalysisSessionMode> {
	return readAnalysisSessionModeSetting(await readJsonFileIfExists(GLOBAL_SETTINGS_PATH));
}

async function getAnalysisSessionOptions(ctx: {
	sessionManager?: { getSessionFile?: () => string | undefined };
}): Promise<AnalysisSessionOptions> {
	const mode = await getAnalysisSessionMode();
	if (mode !== "fork") {
		return { mode };
	}
	return { mode, sourceSessionFile: ctx.sessionManager?.getSessionFile?.() };
}

function writeBackendIntoSettings(settings: Record<string, unknown>, config: MultiModalBackendConfig): void {
	const currentMultiModal = settings.multiModal;
	const multiModal: Record<string, unknown> =
		currentMultiModal && typeof currentMultiModal === "object" && !Array.isArray(currentMultiModal)
			? { ...currentMultiModal }
			: {};
	multiModal.provider = config.provider;
	multiModal.model = config.model;
	if (config.thinkingLevel) {
		multiModal.thinkingLevel = config.thinkingLevel;
	} else {
		delete multiModal.thinkingLevel;
	}
	if (multiModal.analysisSession !== "isolated" && multiModal.analysisSession !== "fork") {
		multiModal.analysisSession = DEFAULT_ANALYSIS_SESSION_MODE;
	}
	settings.multiModal = multiModal;
}

async function saveMultiModalBackend(config: MultiModalBackendConfig): Promise<void> {
	const current = await readJsonFileIfExists(GLOBAL_SETTINGS_PATH);
	const settings = current && typeof current === "object" && !Array.isArray(current) ? { ...current } : {};
	writeBackendIntoSettings(settings as Record<string, unknown>, config);
	await writeJsonFile(GLOBAL_SETTINGS_PATH, settings);
}

async function getShowImagesSetting(cwd: string): Promise<boolean> {
	const [globalSettings, projectSettings] = await Promise.all([
		readJsonFileIfExists(GLOBAL_SETTINGS_PATH),
		readJsonFileIfExists(join(cwd, ".pi", "settings.json")),
	]);
	return resolveShowImagesSetting(globalSettings, projectSettings);
}

async function countAttachableImages(cwd: string, text: string): Promise<number> {
	let count = 0;
	for (const imagePath of findExplicitImagePaths(text)) {
		const absolutePath = resolveUserPath(cwd, imagePath);
		if (!isImageFile(absolutePath) || !mimeTypeForImagePath(absolutePath)) {
			continue;
		}
		try {
			await access(absolutePath);
			count += 1;
		} catch {}
	}
	return count;
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

function createAttachmentIndicatorController() {
	let latestCtx: AttachmentIndicatorCtx | null = null;
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let lastCount = 0;

	function renderCount(count: number): void {
		if (!latestCtx) return;
		latestCtx.ui.setWidget(
			ATTACHMENT_INDICATOR_WIDGET_KEY,
			count > 0 ? [count === 1 ? "📎 1 image attached" : `📎 ${count} images attached`] : undefined,
			{ placement: "aboveEditor" },
		);
	}

	function reset(ctx?: AttachmentIndicatorCtx | null): void {
		if (ctx) latestCtx = ctx;
		lastCount = 0;
		latestCtx?.ui.setWidget(ATTACHMENT_INDICATOR_WIDGET_KEY, undefined);
	}

	async function scan(): Promise<void> {
		if (!latestCtx) return;
		const count = await countAttachableImages(latestCtx.cwd, latestCtx.ui.getEditorText());
		if (count === lastCount) return;
		lastCount = count;
		renderCount(count);
	}

	return {
		attach(ctx: AttachmentIndicatorCtx) {
			latestCtx = ctx;
			reset(ctx);
			if (pollTimer) clearInterval(pollTimer);
			pollTimer = setInterval(() => {
				void scan();
			}, ATTACHMENT_INDICATOR_POLL_MS);
		},
		reset,
		clear(ctx?: AttachmentIndicatorCtx | null) {
			if (pollTimer) {
				clearInterval(pollTimer);
				pollTimer = null;
			}
			reset(ctx);
		},
	};
}

function createReferencedImagesComponent(
	details: ReferencedImagePreviewDetails,
	theme: {
		fg: (color: "customMessageText", value: string) => string;
	},
): Component {
	const container = new Container();
	const count = details.images.length;
	container.addChild(
		new Text(theme.fg("customMessageText", count === 1 ? "📎 1 image attached" : `📎 ${count} images attached`), 0, 0),
	);
	if (isInTmux() || !details.showImages) {
		return container;
	}
	container.addChild(new Spacer(1));
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

function createVisionAnalysisResult(label: string, summaryText: string, backend: MultiModalBackendConfig): ToolResult {
	return {
		content: [{ type: "text", text: `[${label} analyzed with ${formatMultiModalBackend(backend)}]\n\n${summaryText}` }],
		details: {},
	};
}

function mediaFlagsForPath(absolutePath: string): { image: boolean; video: boolean; pdf: boolean } | undefined {
	const image = isImageFile(absolutePath);
	const video = isVideoFile(absolutePath);
	const pdf = isPdfFile(absolutePath);
	return image || video || pdf ? { image, video, pdf } : undefined;
}

async function analyzeMediaToolResult(
	absolutePath: string,
	options: {
		image: boolean;
		video: boolean;
		pdf: boolean;
		backend: MultiModalBackendConfig;
		session?: AnalysisSessionOptions;
		signal?: AbortSignal;
		onUpdate?: (result: ToolResult) => void;
	},
): Promise<ToolResult> {
	const { video, pdf, backend, session, signal, onUpdate } = options;
	const mediaType = video ? "video" : pdf ? "PDF" : "image";
	const backendLabel = formatMultiModalBackend(backend);
	onUpdate?.({
		content: [
			{
				type: "text",
				text: video
					? `[Extracting keyframes and analyzing video with ${backendLabel}...]`
					: pdf
						? `[Analyzing PDF with ${backendLabel}...]`
						: `[Analyzing image with ${backendLabel}...]`,
			},
		],
		details: {},
	});

	try {
		const summaryText = video
			? await analyzeVideo({ absolutePath, backend, session, signal })
			: pdf
				? await analyzePdf({ absolutePath, backend, session, signal })
				: await analyzeImage({ absolutePath, backend, session, signal });

		if (signal?.aborted) {
			throw new Error("Operation aborted");
		}

		const result = createVisionAnalysisResult(video ? "Video" : pdf ? "PDF" : "Image", summaryText, backend);
		onUpdate?.(result);
		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${mediaType[0].toUpperCase()}${mediaType.slice(1)} analysis failed: ${message}`);
	}
}

interface AnalysisSessionOptions {
	mode: AnalysisSessionMode;
	sourceSessionFile?: string;
}

interface AnalyzeImageOptions {
	absolutePath: string;
	backend: MultiModalBackendConfig;
	session?: AnalysisSessionOptions;
	signal?: AbortSignal;
}

interface AnalyzeVideoOptions {
	absolutePath: string;
	backend: MultiModalBackendConfig;
	session?: AnalysisSessionOptions;
	signal?: AbortSignal;
}

interface AnalyzePdfOptions {
	absolutePath: string;
	backend: MultiModalBackendConfig;
	session?: AnalysisSessionOptions;
	signal?: AbortSignal;
}

interface AnalyzeWithPiOptions {
	attachmentPaths: string[];
	prompt: string;
	backend: MultiModalBackendConfig;
	session?: AnalysisSessionOptions;
	signal?: AbortSignal;
}

type EffectiveAnalysisSessionMode = "isolated" | "fork";

export function getAnalysisSessionAwarenessInstruction(mode: EffectiveAnalysisSessionMode): string {
	if (mode === "fork") {
		return [
			"Conversation awareness: you are analyzing attached media inside a temporary fork of the current Pi conversation.",
			"You may use available prior conversation context to interpret the user's intent, but ground every visual, video, or document claim in the attached media.",
			"If the conversation context and the media conflict, say so explicitly instead of inventing missing evidence.",
		].join(" ");
	}

	return [
		"Conversation awareness: you are analyzing attached media without access to the prior conversation.",
		"Do not assume unstated context from earlier chat turns; use only the attached media and this analysis prompt.",
		"Ground every visual, video, or document claim in the attached media.",
	].join(" ");
}

async function createAnalysisSessionArgs(
	session: AnalysisSessionOptions | undefined,
): Promise<{ args: string[]; mode: EffectiveAnalysisSessionMode; cleanup: () => Promise<void> }> {
	if (session?.mode === "fork" && session.sourceSessionFile && existsSync(session.sourceSessionFile)) {
		const sessionDir = await mkdtemp(join(tmpdir(), "pi-multi-modal-session-"));
		return {
			args: ["--fork", session.sourceSessionFile, "--session-dir", sessionDir],
			mode: "fork",
			cleanup: () => rm(sessionDir, { recursive: true, force: true }),
		};
	}

	return { args: ["--no-session"], mode: "isolated", cleanup: async () => undefined };
}

export const createAnalysisSessionArgsForTest = createAnalysisSessionArgs;

async function analyzeWithPi({
	attachmentPaths,
	prompt,
	backend,
	session,
	signal,
}: AnalyzeWithPiOptions): Promise<string> {
	const analysisSession = await createAnalysisSessionArgs(session);
	const promptWithAwareness = `${getAnalysisSessionAwarenessInstruction(analysisSession.mode)}\n\n${prompt}`;
	try {
		return await new Promise((resolvePromise, reject) => {
			const args = [
				...attachmentPaths.map((path) => `@${path}`),
				...analysisSession.args,
				"--provider",
				backend.provider,
				"--model",
				backend.model,
				...(backend.thinkingLevel ? ["--thinking", backend.thinkingLevel] : []),
				"--print",
				"--mode",
				"json",
				"--no-skills",
				"--no-context-files",
				"--no-extensions",
				"-p",
				promptWithAwareness,
			];

			const childEnv = { ...process.env };
			delete childEnv.PI_PACKAGE_DIR;

			const child = spawn("pi", args, {
				stdio: ["ignore", "pipe", "pipe"],
				env: childEnv,
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
					return;
				}

				const output = stdout.trim();
				const error = extractErrorFromPiOutput(output);
				if (error) {
					reject(new Error(error));
					return;
				}

				const text = extractTextFromPiOutput(output);
				if (text === output && output.startsWith("{")) {
					reject(new Error("pi subprocess returned no assistant text"));
					return;
				}

				resolvePromise(text);
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
	} finally {
		await analysisSession.cleanup();
	}
}

async function analyzeImage({ absolutePath, backend, session, signal }: AnalyzeImageOptions): Promise<string> {
	return analyzeWithPi({
		attachmentPaths: [absolutePath],
		prompt: IMAGE_ANALYSIS_PROMPT,
		backend,
		session,
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

async function analyzePdf({ absolutePath, backend, session, signal }: AnalyzePdfOptions): Promise<string> {
	const pagesDir = await mkdtemp(join(process.cwd(), ".pi-multi-modal-pdf-"));
	let succeeded = false;

	try {
		const pages = await extractPdfPages(absolutePath, pagesDir, signal);
		if (pages.length === 0) {
			throw new Error("No pages could be extracted from PDF");
		}

		const analysis = await analyzeWithPi({
			attachmentPaths: pages,
			prompt: `${PDF_ANALYSIS_PROMPT}\n\nThe attached images are rendered pages from a PDF in order.`,
			backend,
			session,
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

async function analyzeVideo({ absolutePath, backend, session, signal }: AnalyzeVideoOptions): Promise<string> {
	const framesDir = await mkdtemp(join(process.cwd(), ".pi-multi-modal-frames-"));
	let succeeded = false;

	try {
		const frames = await extractVideoFrames(absolutePath, framesDir, signal);
		if (frames.length === 0) {
			throw new Error("No frames could be extracted from video");
		}

		const analysis = await analyzeWithPi({
			attachmentPaths: frames,
			prompt: VIDEO_ANALYSIS_PROMPT,
			backend,
			session,
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

const SMART_PASTE_DISPATCH_SEQUENCE = "\u001b[24~";

function baseMimeTypeForSmartPaste(mimeType: string): string {
	return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}

function selectClipboardImageMimeType(typesText: string): string | null {
	const types = typesText
		.split(/\r?\n/)
		.map((type) => type.trim())
		.filter(Boolean);
	const preferred = ["image/png", "image/jpeg", "image/webp", "image/gif"];
	for (const mimeType of preferred) {
		const match = types.find((type) => baseMimeTypeForSmartPaste(type) === mimeType);
		if (match) return match;
	}
	return types.find((type) => baseMimeTypeForSmartPaste(type).startsWith("image/")) ?? null;
}

function readClipboardImageSync(): { bytes: Buffer; mimeType: string } | null {
	if (process.env.WAYLAND_DISPLAY) {
		const list = spawnSync("wl-paste", ["--list-types"], { timeout: 1000, maxBuffer: 64 * 1024 });
		if (!list.error && list.status === 0) {
			const mimeType = selectClipboardImageMimeType(list.stdout?.toString("utf-8") ?? "");
			if (mimeType) {
				const data = spawnSync("wl-paste", ["--type", mimeType, "--no-newline"], {
					timeout: 3000,
					maxBuffer: 50 * 1024 * 1024,
				});
				if (!data.error && data.status === 0 && Buffer.isBuffer(data.stdout) && data.stdout.length > 0) {
					return { bytes: data.stdout, mimeType: baseMimeTypeForSmartPaste(mimeType) };
				}
			}
		}
	}

	if (process.env.DISPLAY) {
		const targets = spawnSync("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], {
			timeout: 1000,
			maxBuffer: 64 * 1024,
		});
		if (!targets.error && targets.status === 0) {
			const mimeType = selectClipboardImageMimeType(targets.stdout?.toString("utf-8") ?? "");
			if (mimeType) {
				const data = spawnSync("xclip", ["-selection", "clipboard", "-t", mimeType, "-o"], {
					timeout: 3000,
					maxBuffer: 50 * 1024 * 1024,
				});
				if (!data.error && data.status === 0 && Buffer.isBuffer(data.stdout) && data.stdout.length > 0) {
					return { bytes: data.stdout, mimeType: baseMimeTypeForSmartPaste(mimeType) };
				}
			}
		}
	}

	return null;
}

function readClipboardSmartPasteText(): string | null {
	const image = readClipboardImageSync();
	if (image) {
		const ext = extensionForImageMimeType(image.mimeType) ?? "png";
		const filePath = join(tmpdir(), `clipboard-${createClipboardImageId()}.${ext}`);
		writeFileSync(filePath, image.bytes);
		return `@${filePath}`;
	}
	return readClipboardText();
}

function bracketedPaste(text: string): string {
	return `\u001b[200~${text}\u001b[201~`;
}

function handleSmartPasteTerminalInput(data: string): { consume?: boolean; data?: string } | undefined {
	if (!data.includes(SMART_PASTE_DISPATCH_SEQUENCE)) {
		return undefined;
	}

	const text = readClipboardSmartPasteText();
	if (!text) {
		return { consume: true };
	}

	return { data: data.split(SMART_PASTE_DISPATCH_SEQUENCE).join(bracketedPaste(text)) };
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
			const filePath = join(tmpdir(), `clipboard-${createClipboardImageId()}.${ext}`);
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
			const filePath = join(tmpdir(), `clipboard-${createClipboardImageId()}.${ext}`);
			await writeFile(filePath, image.bytes);
			paste(`@${filePath}`);
			return true;
		}
	}

	return false;
}

async function analyzeExplicitMediaReferences(
	paths: string[],
	options: {
		cwd: string;
		backend: MultiModalBackendConfig;
		session?: AnalysisSessionOptions;
	},
): Promise<string> {
	const references: Array<{
		path: string;
		absolutePath: string;
		flags: { image: boolean; video: boolean; pdf: boolean };
	}> = [];
	const seen = new Set<string>();

	for (const path of paths) {
		const absolutePath = resolveUserPath(options.cwd, path);
		if (seen.has(absolutePath)) {
			continue;
		}
		seen.add(absolutePath);

		const flags = mediaFlagsForPath(absolutePath);
		if (!flags) {
			continue;
		}
		references.push({ path, absolutePath, flags });
	}

	if (references.length === 0) {
		return "";
	}

	const sections = new Array<string>(references.length);
	let nextIndex = 0;
	const workerCount = Math.min(EXPLICIT_MEDIA_ANALYSIS_CONCURRENCY, references.length);

	await Promise.all(
		Array.from({ length: workerCount }, async () => {
			while (nextIndex < references.length) {
				const index = nextIndex;
				nextIndex += 1;
				const reference = references[index];

				try {
					const result = await analyzeMediaToolResult(reference.absolutePath, {
						...reference.flags,
						backend: options.backend,
						session: options.session,
					});
					const text = result.content
						.filter((block): block is ToolTextBlock => block.type === "text")
						.map((block) => block.text)
						.join("\n\n");
					sections[index] = `Path: ${reference.path}\n${text}`;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					sections[index] = `Path: ${reference.path}\n[Media analysis failed]\n\n${message}`;
				}
			}
		}),
	);

	return [
		"The following explicit @media references were analyzed before the agent response. Use these results as the contents of the referenced files.",
		...sections,
	].join("\n\n");
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
		const backend = await getMultiModalBackend();
		const result = await analyzeMediaToolResult(absolutePath, {
			image: true,
			video: false,
			pdf: false,
			backend,
			session: await getAnalysisSessionOptions(ctx),
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
	let smartPasteTerminalInputUnsubscribe: (() => void) | undefined;
	const attachmentIndicatorController = createAttachmentIndicatorController();

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

	pi.registerShortcut("f12", {
		description: "Internal smart paste dispatch",
		handler: handleSmartPaste,
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.hasUI) {
			smartPasteTerminalInputUnsubscribe?.();
			smartPasteTerminalInputUnsubscribe = ctx.ui.onTerminalInput(handleSmartPasteTerminalInput);
			setWeztermUserVar("PI_SMART_PASTE", "1");
			attachmentIndicatorController.attach(ctx as AttachmentIndicatorCtx);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) {
			smartPasteTerminalInputUnsubscribe?.();
			smartPasteTerminalInputUnsubscribe = undefined;
			setWeztermUserVar("PI_SMART_PASTE", "0");
			attachmentIndicatorController.clear(ctx as AttachmentIndicatorCtx);
		}
	});

	pi.registerMessageRenderer<ReferencedImagePreviewDetails>(
		REFERENCED_IMAGES_MESSAGE_TYPE,
		(message, _options, theme) => {
			const details = message.details;
			if (!details || !Array.isArray(details.images) || details.images.length === 0) {
				return undefined;
			}
			return createReferencedImagesComponent(details, theme);
		},
	);

	if (wrapExistingToolsEnabled()) {
		pi.on("tool_call", (event) => {
			if (event.toolName !== "bash") {
				return;
			}

			const input = event.input as { command?: unknown };
			if (typeof input.command !== "string" || !input.command.includes("__PI_IMAGE__")) {
				return;
			}
			if (input.command.includes(PI_BASH_IMAGE_MARKER_PREFIX)) {
				return;
			}

			input.command = `${BASH_IMAGE_PREAMBLE}\n${input.command}`;
		});

		pi.on("tool_result", async (event, ctx) => {
			if (event.toolName === "read") {
				const params = event.input as Partial<ReadParams>;
				if (typeof params.path !== "string") {
					return undefined;
				}

				const absolutePath = resolveUserPath(ctx.cwd, params.path);
				const image = isImageFile(absolutePath);
				const video = isVideoFile(absolutePath);
				const pdf = isPdfFile(absolutePath);
				if (!image && !video && !pdf) {
					return undefined;
				}

				if (needsVisionProxy(ctx.model?.input) && explicitMediaAnalysisPaths.has(absolutePath)) {
					const backend = await getMultiModalBackend();
					const result = await analyzeMediaToolResult(absolutePath, {
						image,
						video,
						pdf,
						backend,
						session: await getAnalysisSessionOptions(ctx),
					});
					return { content: result.content, details: result.details };
				}

				const result = await localRead.execute("multi-modal-read", params as ReadParams, undefined, undefined);
				return { content: result.content, details: result.details };
			}

			if (event.toolName !== "bash") {
				return undefined;
			}

			const processed = await processBashResult(
				{ content: event.content as ToolContentBlock[], details: event.details },
				{ localRead, ctx },
			);
			if (!processed.foundMarkers) {
				return undefined;
			}
			return { content: processed.content, details: processed.details };
		});
	} else {
		pi.registerTool({
			...localBash,
			description: `${localBash.description} ${BASH_IMAGE_GUIDELINE}`,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const fastResult = await tryFastBash(ctx.cwd, params.command, signal);
				if (fastResult) {
					return fastResult;
				}

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
	}

	let explicitMediaPathsForContext: string[] = [];
	let explicitMediaAnalysisForContext: string | undefined;

	pi.on("turn_end", () => {
		explicitMediaAnalysisPaths = new Set<string>();
		explicitMediaPathsForContext = [];
		explicitMediaAnalysisForContext = undefined;
	});

	pi.on("input", async (event, ctx) => {
		const explicitMediaPaths = findExplicitMediaPaths(event.text);
		explicitMediaPathsForContext = explicitMediaPaths;
		explicitMediaAnalysisForContext = undefined;
		explicitMediaAnalysisPaths = new Set(explicitMediaPaths.map((path) => resolveUserPath(ctx.cwd, path)));
		if (ctx.hasUI) {
			attachmentIndicatorController.reset(ctx as AttachmentIndicatorCtx);
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

	pi.on("context", async (event, ctx) => {
		const messages = structuredClone(event.messages).filter(
			(message) => message.role !== "custom" || message.customType !== REFERENCED_IMAGES_MESSAGE_TYPE,
		);
		let changed = messages.length !== event.messages.length;
		const supportsImages = supportsNativeImageInput(ctx.model?.input);
		const mediaPathsToAnalyze = supportsImages
			? explicitMediaPathsForContext.filter((path) => {
					const absolutePath = resolveUserPath(ctx.cwd, path);
					return isVideoFile(absolutePath) || isPdfFile(absolutePath);
				})
			: explicitMediaPathsForContext;

		if (mediaPathsToAnalyze.length > 0) {
			if (!explicitMediaAnalysisForContext) {
				if (ctx.hasUI) {
					ctx.ui.notify(`Analyzing ${mediaPathsToAnalyze.length} explicit @media reference(s)...`, "info");
				}
				const backend = await getMultiModalBackend();
				explicitMediaAnalysisForContext = await analyzeExplicitMediaReferences(mediaPathsToAnalyze, {
					cwd: ctx.cwd,
					backend,
					session: await getAnalysisSessionOptions(ctx),
				});
			}

			if (explicitMediaAnalysisForContext) {
				for (let index = messages.length - 1; index >= 0; index--) {
					const message = messages[index];
					if (message.role !== "user") {
						continue;
					}

					if (typeof message.content === "string") {
						message.content = `${message.content}\n\n${explicitMediaAnalysisForContext}`;
						changed = true;
						break;
					}

					const textBlock = message.content.find((block) => block.type === "text");
					if (textBlock) {
						textBlock.text = `${textBlock.text}\n\n${explicitMediaAnalysisForContext}`;
					} else {
						message.content = [{ type: "text", text: explicitMediaAnalysisForContext }, ...message.content];
					}
					changed = true;
					break;
				}
			}
		}

		if (!supportsImages) {
			return changed ? { messages } : undefined;
		}

		for (const message of messages) {
			if (message.role !== "user" || typeof message.content === "string") {
				continue;
			}

			const imageBlocks = message.content.filter((block) => block.type === "image");
			if (imageBlocks.length === 0) {
				continue;
			}

			const textBlocks = message.content.filter((block) => block.type === "text");
			const otherBlocks = message.content.filter((block) => block.type !== "image" && block.type !== "text");
			const reordered = [...imageBlocks, ...textBlocks, ...otherBlocks];
			if (JSON.stringify(reordered) !== JSON.stringify(message.content)) {
				message.content = reordered;
				changed = true;
			}
		}

		return changed ? { messages } : undefined;
	});

	// Override read to intercept image/video/PDF reads for non-vision models
	if (!wrapExistingToolsEnabled()) {
		pi.registerTool({
			...localRead,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const { path } = params;
				const absolutePath = resolveUserPath(ctx.cwd, path);
				const image = isImageFile(absolutePath);
				const video = isVideoFile(absolutePath);
				const pdf = isPdfFile(absolutePath);

				if (!image && !video && !pdf) {
					const fastResult = await tryFastTextRead(ctx.cwd, params, signal);
					if (fastResult) {
						return fastResult;
					}
					return localRead.execute(toolCallId, params, signal, onUpdate);
				}

				if (!needsVisionProxy(ctx.model?.input)) {
					return localRead.execute(toolCallId, params, signal, onUpdate);
				}

				if (!explicitMediaAnalysisPaths.has(absolutePath)) {
					return localRead.execute(toolCallId, params, signal, onUpdate);
				}

				const backend = await getMultiModalBackend();
				return analyzeMediaToolResult(absolutePath, {
					image,
					video,
					pdf,
					backend,
					session: await getAnalysisSessionOptions(ctx),
					signal,
					onUpdate,
				});
			},
		});
	}

	pi.registerCommand("multi-modal", {
		description: "Set the pi-multi-modal backend with /multi-modal <provider/model[:thinking]>",
		handler: async (args, ctx) => {
			const parsed = parseMultiModalBackend(args);
			if (!parsed) {
				ctx.ui.notify(
					`Usage: /multi-modal <provider/model[:thinking]> (default: ${formatMultiModalBackend(DEFAULT_MULTI_MODAL_BACKEND)})`,
					"error",
				);
				return;
			}

			const model = ctx.modelRegistry.find(parsed.provider, parsed.model);
			if (model && !supportsNativeImageInput(model.input)) {
				ctx.ui.notify(`Model does not support image input: ${formatMultiModalBackend(parsed)}`, "error");
				return;
			}

			await saveMultiModalBackend(parsed);
			ctx.ui.notify(`pi-multi-modal backend set to ${formatMultiModalBackend(parsed)}`, "info");
		},
	});

	// Command for manual image analysis
	pi.registerCommand("analyze-image", {
		description: "Analyze an image file using the configured pi-multi-modal backend",
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

			const backend = await getMultiModalBackend();
			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, `Analyzing ${imagePath}...`);
				loader.onAbort = () => done(null);

				void getAnalysisSessionOptions(ctx)
					.then((session) => analyzeImage({ absolutePath, backend, session, signal: loader.signal }))
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
		description: "Analyze a video file using the configured pi-multi-modal backend",
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

			const backend = await getMultiModalBackend();
			const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(tui, theme, `Analyzing ${videoPath}...`);
				loader.onAbort = () => done(null);

				void getAnalysisSessionOptions(ctx)
					.then((session) => analyzeVideo({ absolutePath, backend, session, signal: loader.signal }))
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
