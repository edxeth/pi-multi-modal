/**
 * Utility functions for pi-multi-modal.
 */

export const DEFAULT_MULTI_MODAL_PROVIDER = "zai";
export const DEFAULT_MULTI_MODAL_MODEL = "glm-4.6v";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export interface MultiModalBackendConfig {
	provider: string;
	model: string;
	thinkingLevel?: ThinkingLevel;
}
export const DEFAULT_MULTI_MODAL_BACKEND: MultiModalBackendConfig = {
	provider: DEFAULT_MULTI_MODAL_PROVIDER,
	model: DEFAULT_MULTI_MODAL_MODEL,
};
export const SUPPORTED_IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp"];
export const SUPPORTED_VIDEO_EXTENSIONS = ["mp4", "mkv", "mov"];
export const SUPPORTED_PDF_EXTENSIONS = ["pdf"];
const INLINE_IMAGE_PATH_REGEX = /(^|\s|\(|:|\[)(@?((?:~|\/|\.\.?\/)[^\s)\]}"']+\.(?:jpg|jpeg|png|gif|webp)))/gim;
const INLINE_EXPLICIT_MEDIA_PATH_REGEX = /(^|\s|\(|:|\[)(@((?:~|\/|\.\.?\/)[^\s)\]}"']+\.[a-z0-9]+))/gim;
export const PI_BASH_IMAGE_MARKER_PREFIX = "__PI_IMAGE_MARKER__:";

export type ImageReferenceMatch =
	| {
			kind: "placeholder";
			fullMatch: string;
			index: number;
			prefix: "";
			placeholderId: number;
	  }
	| {
			kind: "path";
			fullMatch: string;
			index: number;
			prefix: string;
			path: string;
	  };

// Types for pi JSON output
export interface PiMessage {
	role: string;
	content?: PiContentBlock[];
}

export interface PiContentBlock {
	type: string;
	text?: string;
}

export interface PiJsonOutput {
	messages?: PiMessage[];
}

export type BashImageOutputPart =
	| {
			type: "text";
			text: string;
	  }
	| {
			type: "image-marker";
			path: string;
	  };

export function isThinkingLevel(value: string | undefined): value is ThinkingLevel {
	return value !== undefined && THINKING_LEVELS.includes(value as ThinkingLevel);
}

export function parseMultiModalBackend(input: string): MultiModalBackendConfig | null {
	const trimmed = input.trim();
	const slashIndex = trimmed.indexOf("/");
	if (slashIndex <= 0 || slashIndex >= trimmed.length - 1) {
		return null;
	}

	const provider = trimmed.slice(0, slashIndex).trim();
	let model = trimmed.slice(slashIndex + 1).trim();
	if (!provider || !model) {
		return null;
	}

	let thinkingLevel: ThinkingLevel | undefined;
	const thinkingSeparatorIndex = model.lastIndexOf(":");
	if (thinkingSeparatorIndex > 0) {
		const maybeThinkingLevel = model.slice(thinkingSeparatorIndex + 1).trim();
		if (isThinkingLevel(maybeThinkingLevel)) {
			thinkingLevel = maybeThinkingLevel;
			model = model.slice(0, thinkingSeparatorIndex).trim();
		}
	}

	if (!model) {
		return null;
	}

	return thinkingLevel ? { provider, model, thinkingLevel } : { provider, model };
}

export function formatMultiModalBackend(config: MultiModalBackendConfig): string {
	return `${config.provider}/${config.model}${config.thinkingLevel ? `:${config.thinkingLevel}` : ""}`;
}

function readStringSetting(settings: unknown, path: readonly string[]): string | undefined {
	let current: unknown = settings;
	for (const key of path) {
		if (current === null || typeof current !== "object" || !(key in current)) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[key];
	}
	return typeof current === "string" ? current : undefined;
}

export function readMultiModalBackendSetting(settings: unknown): MultiModalBackendConfig {
	const provider = readStringSetting(settings, ["multiModal", "provider"]) ?? DEFAULT_MULTI_MODAL_BACKEND.provider;
	const model = readStringSetting(settings, ["multiModal", "model"]) ?? DEFAULT_MULTI_MODAL_BACKEND.model;
	const thinkingLevel = readStringSetting(settings, ["multiModal", "thinkingLevel"]);
	return isThinkingLevel(thinkingLevel) ? { provider, model, thinkingLevel } : { provider, model };
}

export function parseBashImageOutput(text: string): { parts: BashImageOutputPart[]; foundMarkers: boolean } {
	const lines = text.split("\n");
	const parts: BashImageOutputPart[] = [];
	const textLines: string[] = [];
	let foundMarkers = false;

	const flushText = () => {
		if (textLines.length === 0) {
			return;
		}
		parts.push({ type: "text", text: textLines.join("\n") });
		textLines.length = 0;
	};

	for (const line of lines) {
		if (!line.startsWith(PI_BASH_IMAGE_MARKER_PREFIX)) {
			textLines.push(line);
			continue;
		}

		foundMarkers = true;
		flushText();

		const path = line.slice(PI_BASH_IMAGE_MARKER_PREFIX.length).trim();
		if (!path) {
			continue;
		}
		parts.push({ type: "image-marker", path });
	}

	flushText();
	return { parts, foundMarkers };
}

/**
 * Check if a file path points to a supported image file
 */
export function isImageFile(path: string): boolean {
	const ext = path.split(".").pop()?.toLowerCase();
	return ext !== undefined && SUPPORTED_IMAGE_EXTENSIONS.includes(ext);
}

/**
 * Check if a file path points to a supported video file
 */
export function isVideoFile(path: string): boolean {
	const ext = path.split(".").pop()?.toLowerCase();
	return ext !== undefined && SUPPORTED_VIDEO_EXTENSIONS.includes(ext);
}

/**
 * Check if a file path points to a supported PDF file
 */
export function isPdfFile(path: string): boolean {
	const ext = path.split(".").pop()?.toLowerCase();
	return ext !== undefined && SUPPORTED_PDF_EXTENSIONS.includes(ext);
}

export function isMediaFile(path: string): boolean {
	return isImageFile(path) || isVideoFile(path) || isPdfFile(path);
}

/**
 * Check if a model needs vision proxy based on capability.
 * Models with input=["text"] (no "image") need proxy for media reads.
 */
export function needsVisionProxy(inputTypes: ("text" | "image")[] | undefined): boolean {
	return inputTypes !== undefined && !inputTypes.includes("image");
}

/**
 * Check if a model supports direct image attachments in the main conversation.
 */
export function supportsNativeImageInput(inputTypes: ("text" | "image")[] | undefined): boolean {
	return inputTypes?.includes("image") ?? false;
}

/**
 * Find inline local image paths in a user message.
 */
export function findInlineImagePaths(text: string): string[] {
	const matches: string[] = [];
	for (const match of text.matchAll(INLINE_IMAGE_PATH_REGEX)) {
		if (match[3]) matches.push(match[3]);
	}
	return matches;
}

/**
 * Find explicit @-prefixed media paths that should opt into vision analysis.
 */
export function findExplicitMediaPaths(text: string): string[] {
	const matches: string[] = [];
	for (const match of text.matchAll(INLINE_EXPLICIT_MEDIA_PATH_REGEX)) {
		const path = match[3];
		if (path && isMediaFile(path)) {
			matches.push(path);
		}
	}
	return matches;
}

export function findExplicitImagePaths(text: string): string[] {
	return findImageReferences(text)
		.filter((match): match is Extract<ImageReferenceMatch, { kind: "path" }> => match.kind === "path")
		.filter((match) => match.fullMatch.slice(match.prefix.length).startsWith("@"))
		.map((match) => match.path);
}

/**
 * Replace inline local image paths with stable placeholders like [Image #1].
 * Replacement happens in match order and preserves surrounding punctuation/spacing.
 */
export function replaceInlineImagePathsWithPlaceholders(text: string, allowedPaths?: string[]): string {
	let imageIndex = 0;
	const allowed = allowedPaths ? new Set(allowedPaths) : undefined;
	return text.replaceAll(INLINE_IMAGE_PATH_REGEX, (fullMatch, prefix, _reference, path) => {
		if (allowed && !allowed.has(path)) {
			return fullMatch;
		}
		imageIndex += 1;
		return `${prefix}[Image #${imageIndex}]`;
	});
}

export function replaceExplicitInlineImagePathsWithPlaceholders(text: string, allowedPaths?: string[]): string {
	let imageIndex = 0;
	const allowed = allowedPaths ? new Set(allowedPaths) : undefined;
	return text.replaceAll(INLINE_IMAGE_PATH_REGEX, (fullMatch, prefix, reference, path) => {
		if (!String(reference).startsWith("@")) {
			return fullMatch;
		}
		if (allowed && !allowed.has(path)) {
			return fullMatch;
		}
		imageIndex += 1;
		return `${prefix}[Image #${imageIndex}]`;
	});
}

export function findImageReferences(text: string): ImageReferenceMatch[] {
	const matches: ImageReferenceMatch[] = [];

	for (const match of text.matchAll(INLINE_IMAGE_PATH_REGEX)) {
		const fullMatch = match[0];
		const prefix = match[1];
		const path = match[3];
		const index = match.index;
		if (fullMatch !== undefined && prefix !== undefined && path !== undefined && index !== undefined) {
			matches.push({ kind: "path", fullMatch, index, prefix, path });
		}
	}

	for (const match of text.matchAll(IMAGE_PLACEHOLDER_REGEX)) {
		const fullMatch = match[0];
		const placeholderId = Number.parseInt(match[1] ?? "", 10);
		const index = match.index;
		if (fullMatch !== undefined && Number.isFinite(placeholderId) && index !== undefined) {
			matches.push({ kind: "placeholder", fullMatch, index, prefix: "", placeholderId });
		}
	}

	return matches.sort((a, b) => a.index - b.index);
}

/**
 * Build a stable appendix mapping placeholders back to absolute image paths.
 */
export function buildImageReferenceSuffix(absolutePaths: string[]): string {
	if (absolutePaths.length === 0) {
		return "";
	}

	const lines = absolutePaths.map((path, index) => `[Image #${index + 1}] ${path}`);
	return `\n\nImage references:\n${lines.join("\n")}`;
}

const IMAGE_PLACEHOLDER_REGEX = /\[Image #(\d+)\]/g;

export function findImagePlaceholderIds(text: string): number[] {
	const matches: number[] = [];
	for (const match of text.matchAll(IMAGE_PLACEHOLDER_REGEX)) {
		const id = Number.parseInt(match[1] ?? "", 10);
		if (Number.isFinite(id)) {
			matches.push(id);
		}
	}
	return matches;
}
const IMAGE_REFERENCE_SUFFIX_REGEX = /\n\nImage references:\n(?:\[Image #\d+\] .*\n?)*$/;
const YELLOW_START = "\x1b[33m";
const COLOR_RESET = "\x1b[39m";

/**
 * Colorize [Image #n] placeholders for terminal display.
 */
export function colorizeImagePlaceholders(text: string): string {
	return text.replaceAll(IMAGE_PLACEHOLDER_REGEX, (match) => `${YELLOW_START}${match}${COLOR_RESET}`);
}

/**
 * Remove display-only styling and image-reference appendix before sending text to the provider.
 */
export function sanitizeImagePromptForProvider(text: string): string {
	return text
		.replaceAll(YELLOW_START, "")
		.replaceAll(COLOR_RESET, "")
		.replace(IMAGE_REFERENCE_SUFFIX_REGEX, "")
		.trimEnd();
}

function readBooleanSetting(settings: unknown, path: readonly string[]): boolean | undefined {
	let current: unknown = settings;
	for (const key of path) {
		if (current === null || typeof current !== "object" || !(key in current)) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[key];
	}
	return typeof current === "boolean" ? current : undefined;
}

export function resolveShowImagesSetting(globalSettings: unknown, projectSettings: unknown): boolean {
	return (
		readBooleanSetting(projectSettings, ["terminal", "showImages"]) ??
		readBooleanSetting(globalSettings, ["terminal", "showImages"]) ??
		true
	);
}

/**
 * Extract text content from pi JSON output
 * Falls back to returning the raw output if not valid JSON
 */
function extractTextFromAssistantContent(content: unknown): string | null {
	if (!Array.isArray(content)) {
		return null;
	}

	const text = content
		.filter((block): block is PiContentBlock => Boolean(block) && typeof block === "object" && "type" in block)
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");

	return text || null;
}

function extractTextFromPiJson(json: unknown): string | null {
	if (!json || typeof json !== "object") {
		return null;
	}

	if ("messages" in json && Array.isArray((json as PiJsonOutput).messages)) {
		const assistantMsg = (json as PiJsonOutput).messages?.findLast((m: PiMessage) => m.role === "assistant");
		const text = extractTextFromAssistantContent(assistantMsg?.content);
		if (text) {
			return text;
		}
	}

	if ("type" in json && (json as { type?: unknown }).type === "agent_end") {
		const text = extractTextFromPiJson({ messages: (json as { messages?: unknown }).messages });
		if (text) {
			return text;
		}
	}

	if ("message" in json) {
		const message = (json as { message?: unknown }).message;
		if (message && typeof message === "object" && (message as { role?: unknown }).role === "assistant") {
			const text = extractTextFromAssistantContent((message as { content?: unknown }).content);
			if (text) {
				return text;
			}
		}
	}

	return null;
}

function extractErrorFromPiJson(json: unknown): string | null {
	if (!json || typeof json !== "object") {
		return null;
	}

	if ("finalError" in json && typeof (json as { finalError?: unknown }).finalError === "string") {
		const finalError = (json as { finalError: string }).finalError.trim();
		if (finalError) {
			return finalError;
		}
	}

	if ("errorMessage" in json && typeof (json as { errorMessage?: unknown }).errorMessage === "string") {
		const errorMessage = (json as { errorMessage: string }).errorMessage.trim();
		if (errorMessage) {
			return errorMessage;
		}
	}

	if ("messages" in json && Array.isArray((json as PiJsonOutput).messages)) {
		const assistantMsg = (json as PiJsonOutput).messages?.findLast((m: PiMessage) => m.role === "assistant") as
			| (PiMessage & { errorMessage?: unknown })
			| undefined;
		if (typeof assistantMsg?.errorMessage === "string" && assistantMsg.errorMessage.trim()) {
			return assistantMsg.errorMessage.trim();
		}
	}

	if ("message" in json) {
		const message = (json as { message?: unknown }).message as
			| ({ role?: unknown; errorMessage?: unknown } & Record<string, unknown>)
			| undefined;
		if (message?.role === "assistant" && typeof message.errorMessage === "string" && message.errorMessage.trim()) {
			return message.errorMessage.trim();
		}
	}

	return null;
}

export function extractErrorFromPiOutput(output: string): string | null {
	try {
		const error = extractErrorFromPiJson(JSON.parse(output));
		if (error) {
			return error;
		}
	} catch {
		// Not a single JSON object; try newline-delimited JSON below.
	}

	const lines = output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		try {
			const error = extractErrorFromPiJson(JSON.parse(lines[i]!));
			if (error) {
				return error;
			}
		} catch {
			// Ignore non-JSON lines.
		}
	}

	return null;
}

export function extractTextFromPiOutput(output: string): string {
	try {
		const text = extractTextFromPiJson(JSON.parse(output));
		if (text) {
			return text;
		}
	} catch {
		// Not a single JSON object; try newline-delimited JSON below.
	}

	const lines = output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		try {
			const text = extractTextFromPiJson(JSON.parse(lines[i]!));
			if (text) {
				return text;
			}
		} catch {
			// Ignore non-JSON lines.
		}
	}

	return output;
}
