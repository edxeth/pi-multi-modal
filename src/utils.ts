/**
 * Utility functions for GLM Image Summary Extension
 * Extracted for testability
 */

import { spawn } from "node:child_process";

// Configuration
export const VISION_PROVIDER = "zai";
export const VISION_PROVIDER_FALLBACK = "zai-legacy";
export const VISION_PROVIDER_CANDIDATES = [VISION_PROVIDER, VISION_PROVIDER_FALLBACK] as const;
export const VISION_MODEL = "glm-4.6v";
export const SUPPORTED_IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp"];
export const SUPPORTED_VIDEO_EXTENSIONS = ["mp4", "mkv", "mov"];
export const SUPPORTED_PDF_EXTENSIONS = ["pdf"];
const INLINE_IMAGE_PATH_REGEX = /(^|\s|\(|:|\[)(@?((?:~|\/|\.\.?\/)[^\s)\]}"']+\.(?:jpg|jpeg|png|gif|webp)))/gim;
const INLINE_EXPLICIT_MEDIA_PATH_REGEX = /(^|\s|\(|:|\[)(@((?:~|\/|\.\.?\/)[^\s)\]}"']+\.[a-z0-9]+))/gim;
const VISION_PROVIDER_RETRYABLE_ERROR_REGEX =
	/no api key found|unknown provider|no models matching|no models available|unknown model/i;
let resolvedVisionProviderPromise: Promise<string> | undefined;

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

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractAvailableVisionProviders(output: string, model = VISION_MODEL): string[] {
	const matches = output.matchAll(new RegExp(`^(\\S+)\\s+${escapeRegExp(model)}(?=\\s|$)`, "gm"));
	const providers = [...matches]
		.map((match) => match[1])
		.filter((provider): provider is string => provider !== undefined);
	return [...new Set(providers.filter((provider) => VISION_PROVIDER_CANDIDATES.includes(provider as never)))];
}

export function getAvailableVisionProviders(
	models: ReadonlyArray<{ provider: string; id: string }>,
	model = VISION_MODEL,
): string[] {
	const providers = models
		.filter((entry) => entry.id === model)
		.map((entry) => entry.provider)
		.filter((provider) => VISION_PROVIDER_CANDIDATES.includes(provider as never));
	return [...new Set(providers)];
}

export function pickPreferredVisionProvider(providers: readonly string[]): string {
	for (const provider of VISION_PROVIDER_CANDIDATES) {
		if (providers.includes(provider)) {
			return provider;
		}
	}
	return VISION_PROVIDER;
}

export function shouldRetryWithFallbackVisionProvider(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return VISION_PROVIDER_RETRYABLE_ERROR_REGEX.test(message);
}

async function listAvailableVisionProviders(): Promise<string[]> {
	return new Promise((resolvePromise) => {
		const child = spawn("pi", ["--no-extensions", "--list-models", VISION_MODEL], {
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

		child.on("error", () => {
			resolvePromise([]);
		});

		child.on("close", () => {
			resolvePromise(extractAvailableVisionProviders(`${stdout}\n${stderr}`));
		});
	});
}

export async function resolveVisionProvider(): Promise<string> {
	resolvedVisionProviderPromise ??= listAvailableVisionProviders().then((providers) =>
		pickPreferredVisionProvider(providers),
	);
	return resolvedVisionProviderPromise;
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
export function extractTextFromPiOutput(output: string): string {
	try {
		const json: PiJsonOutput = JSON.parse(output);
		if (json.messages && Array.isArray(json.messages)) {
			const assistantMsg = json.messages.findLast((m: PiMessage) => m.role === "assistant");
			if (assistantMsg?.content) {
				return assistantMsg.content
					.filter((c: PiContentBlock) => c.type === "text")
					.map((c: PiContentBlock) => c.text ?? "")
					.join("\n");
			}
		}
	} catch {
		// Not JSON, return as-is
	}
	return output;
}
