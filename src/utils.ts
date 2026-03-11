/**
 * Utility functions for GLM Image Summary Extension
 * Extracted for testability
 */

// Configuration
export const VISION_PROVIDER = "zai-legacy";
export const VISION_MODEL = "glm-4.6v";
export const SUPPORTED_IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp"];
export const SUPPORTED_VIDEO_EXTENSIONS = ["mp4", "mkv", "mov"];
export const SUPPORTED_PDF_EXTENSIONS = ["pdf"];

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

/**
 * Check if a model needs vision proxy based on capability.
 * Models with input=["text"] (no "image") need proxy for media reads.
 */
export function needsVisionProxy(inputTypes: ("text" | "image")[] | undefined): boolean {
	return inputTypes !== undefined && !inputTypes.includes("image");
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
