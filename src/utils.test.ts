import { describe, expect, it } from "vitest";
import {
	DEFAULT_ANALYSIS_SESSION_MODE,
	DEFAULT_MULTI_MODAL_BACKEND,
	extractErrorFromPiOutput,
	extractTextFromPiOutput,
	findExplicitImagePaths,
	findExplicitMediaPaths,
	findImageReferences,
	findInlineImagePaths,
	formatMultiModalBackend,
	isImageFile,
	isVideoFile,
	needsVisionProxy,
	parseBashImageOutput,
	parseMultiModalBackend,
	readAnalysisSessionModeSetting,
	readMultiModalBackendSetting,
	resolveShowImagesSetting,
	SUPPORTED_IMAGE_EXTENSIONS,
	SUPPORTED_VIDEO_EXTENSIONS,
	supportsNativeImageInput,
} from "./utils.js";

describe("multi-modal backend helpers", () => {
	it("parses provider, model, and optional thinking level", () => {
		expect(parseMultiModalBackend("google/gemini-3-flash-preview:high")).toEqual({
			provider: "google",
			model: "gemini-3-flash-preview",
			thinkingLevel: "high",
		});
		expect(parseMultiModalBackend("openrouter/openai/gpt-5.1-codex")).toEqual({
			provider: "openrouter",
			model: "openai/gpt-5.1-codex",
		});
	});

	it("only treats the trailing colon segment as thinking when it is a valid level", () => {
		expect(parseMultiModalBackend("amazon-bedrock/us.anthropic.claude-sonnet-4-20250514-v1:0")).toEqual({
			provider: "amazon-bedrock",
			model: "us.anthropic.claude-sonnet-4-20250514-v1:0",
		});
	});

	it("formats a backend reference for display", () => {
		expect(formatMultiModalBackend({ provider: "google", model: "gemini-3-flash-preview" })).toBe(
			"google/gemini-3-flash-preview",
		);
		expect(
			formatMultiModalBackend({ provider: "google", model: "gemini-3-flash-preview", thinkingLevel: "high" }),
		).toBe("google/gemini-3-flash-preview:high");
	});

	it("reads backend settings and falls back to defaults", () => {
		expect(readMultiModalBackendSetting(undefined)).toEqual(DEFAULT_MULTI_MODAL_BACKEND);
		expect(
			readMultiModalBackendSetting({
				multiModal: { provider: "google", model: "gemini-3-flash-preview", thinkingLevel: "high" },
			}),
		).toEqual({ provider: "google", model: "gemini-3-flash-preview", thinkingLevel: "high" });
	});

	it("reads analysis session mode settings and falls back to isolated", () => {
		expect(readAnalysisSessionModeSetting(undefined)).toBe(DEFAULT_ANALYSIS_SESSION_MODE);
		expect(readAnalysisSessionModeSetting({ multiModal: { analysisSession: "fork" } })).toBe("fork");
		expect(readAnalysisSessionModeSetting({ multiModal: { analysisSession: "temporary" } })).toBe("isolated");
	});
});

describe("isImageFile", () => {
	it("returns true for supported image extensions", () => {
		const testCases = ["photo.jpg", "photo.jpeg", "screenshot.png", "animation.gif", "modern.webp"];
		for (const path of testCases) {
			expect(isImageFile(path), `Expected ${path} to be recognized as image`).toBe(true);
		}
	});

	it("returns true for uppercase extensions", () => {
		expect(isImageFile("photo.JPG")).toBe(true);
		expect(isImageFile("photo.PNG")).toBe(true);
		expect(isImageFile("photo.JPEG")).toBe(true);
	});

	it("returns true for mixed case extensions", () => {
		expect(isImageFile("photo.JpG")).toBe(true);
		expect(isImageFile("photo.Png")).toBe(true);
	});

	it("returns false for non-image extensions", () => {
		const testCases = ["document.pdf", "script.ts", "data.json", "readme.md", "video.mp4", "audio.mp3"];
		for (const path of testCases) {
			expect(isImageFile(path), `Expected ${path} to NOT be recognized as image`).toBe(false);
		}
	});

	it("returns false for files without extension", () => {
		expect(isImageFile("Makefile")).toBe(false);
		expect(isImageFile("README")).toBe(false);
	});

	it("handles paths with directories", () => {
		expect(isImageFile("/home/user/photos/image.png")).toBe(true);
		expect(isImageFile("./relative/path/to/file.jpg")).toBe(true);
		expect(isImageFile("../parent/dir/doc.pdf")).toBe(false);
	});

	it("handles paths with dots in directory names", () => {
		expect(isImageFile("/path/to/.hidden/image.png")).toBe(true);
		expect(isImageFile("/path/to/v1.2.3/screenshot.jpg")).toBe(true);
	});

	it("handles empty string", () => {
		expect(isImageFile("")).toBe(false);
	});

	it("covers all documented supported extensions", () => {
		const expected = ["jpg", "jpeg", "png", "gif", "webp"];
		expect(SUPPORTED_IMAGE_EXTENSIONS).toEqual(expected);
	});
});

describe("isVideoFile", () => {
	it("returns true for supported video extensions", () => {
		const testCases = ["clip.mp4", "movie.mkv", "recording.mov"];
		for (const path of testCases) {
			expect(isVideoFile(path), `Expected ${path} to be recognized as video`).toBe(true);
		}
	});

	it("returns true for uppercase extensions", () => {
		expect(isVideoFile("clip.MP4")).toBe(true);
		expect(isVideoFile("movie.MKV")).toBe(true);
		expect(isVideoFile("recording.MOV")).toBe(true);
	});

	it("returns false for non-video extensions", () => {
		const testCases = ["image.png", "doc.pdf", "sound.mp3", "archive.zip"];
		for (const path of testCases) {
			expect(isVideoFile(path), `Expected ${path} to NOT be recognized as video`).toBe(false);
		}
	});

	it("covers all documented supported video extensions", () => {
		const expected = ["mp4", "mkv", "mov"];
		expect(SUPPORTED_VIDEO_EXTENSIONS).toEqual(expected);
	});
});

describe("needsVisionProxy", () => {
	it("returns true for text-only models", () => {
		expect(needsVisionProxy(["text"])).toBe(true);
	});

	it("returns false for image-capable models", () => {
		expect(needsVisionProxy(["text", "image"])).toBe(false);
		expect(needsVisionProxy(["image", "text"])).toBe(false);
	});

	it("returns false for undefined model input", () => {
		expect(needsVisionProxy(undefined)).toBe(false);
	});
});

describe("supportsNativeImageInput", () => {
	it("returns true for image-capable models", () => {
		expect(supportsNativeImageInput(["text", "image"])).toBe(true);
		expect(supportsNativeImageInput(["image", "text"])).toBe(true);
	});

	it("returns false for text-only or undefined models", () => {
		expect(supportsNativeImageInput(["text"])).toBe(false);
		expect(supportsNativeImageInput(undefined)).toBe(false);
	});
});

describe("bash image marker parsing", () => {
	it("splits text and inline image markers in order", () => {
		expect(parseBashImageOutput("Saved\n__PI_IMAGE_MARKER__:/tmp/a.png\nDone")).toEqual({
			foundMarkers: true,
			parts: [
				{ type: "text", text: "Saved" },
				{ type: "image-marker", path: "/tmp/a.png" },
				{ type: "text", text: "Done" },
			],
		});
	});

	it("preserves plain text when no markers exist", () => {
		expect(parseBashImageOutput("No image here")).toEqual({
			foundMarkers: false,
			parts: [{ type: "text", text: "No image here" }],
		});
	});

	it("ignores empty marker payloads", () => {
		expect(parseBashImageOutput("Start\n__PI_IMAGE_MARKER__:   \nEnd")).toEqual({
			foundMarkers: true,
			parts: [
				{ type: "text", text: "Start" },
				{ type: "text", text: "End" },
			],
		});
	});
});

describe("inline image path helpers", () => {
	it("finds inline image paths in order", () => {
		const text = "Read /tmp/a.png and then ./b.webp please.";
		expect(findInlineImagePaths(text)).toEqual(["/tmp/a.png", "./b.webp"]);
	});

	it("finds @-prefixed inline image paths without the @", () => {
		const text = "Compare @/tmp/a.png with @./b.webp";
		expect(findInlineImagePaths(text)).toEqual(["/tmp/a.png", "./b.webp"]);
	});

	it("finds explicit @-prefixed media paths for vision opt-in", () => {
		const text = "Analyze @/tmp/a.png, @./demo.mp4, and @../doc.pdf but ignore ./plain.png";
		expect(findExplicitMediaPaths(text)).toEqual(["/tmp/a.png", "./demo.mp4", "../doc.pdf"]);
	});

	it("finds explicit @-prefixed image paths only", () => {
		const text = "Compare @/tmp/a.png, @./b.webp, @./demo.mp4, and ./plain.png";
		expect(findExplicitImagePaths(text)).toEqual(["/tmp/a.png", "./b.webp"]);
	});

	it("ignores non-media @ paths when collecting explicit media refs", () => {
		const text = "Use @./notes.md and @./photo.png";
		expect(findExplicitMediaPaths(text)).toEqual(["./photo.png"]);
	});

	it("finds image paths in source order", () => {
		const text = "See @/tmp/a.png plus ./b.webp";
		expect(findImageReferences(text)).toEqual([
			{ kind: "path", fullMatch: " @/tmp/a.png", index: 3, prefix: " ", path: "/tmp/a.png" },
			{ kind: "path", fullMatch: " ./b.webp", index: 20, prefix: " ", path: "./b.webp" },
		]);
	});
});

describe("resolveShowImagesSetting", () => {
	it("defaults to true when setting is absent", () => {
		expect(resolveShowImagesSetting(undefined, undefined)).toBe(true);
	});

	it("prefers project setting over global setting", () => {
		expect(resolveShowImagesSetting({ terminal: { showImages: true } }, { terminal: { showImages: false } })).toBe(
			false,
		);
	});

	it("falls back to global setting when project setting is absent", () => {
		expect(resolveShowImagesSetting({ terminal: { showImages: false } }, {})).toBe(false);
	});
});

describe("extractErrorFromPiOutput", () => {
	it("extracts an assistant errorMessage from JSON output", () => {
		const jsonOutput = JSON.stringify({
			messages: [{ role: "assistant", content: [], errorMessage: "429 insufficient balance" }],
		});
		expect(extractErrorFromPiOutput(jsonOutput)).toBe("429 insufficient balance");
	});

	it("extracts the finalError from ndjson output", () => {
		const output = [
			JSON.stringify({ type: "session" }),
			JSON.stringify({ type: "auto_retry_end", success: false, finalError: "backend failed" }),
		].join("\n");
		expect(extractErrorFromPiOutput(output)).toBe("backend failed");
	});

	it("returns null when there is no structured error", () => {
		expect(extractErrorFromPiOutput(JSON.stringify({ messages: [] }))).toBeNull();
		expect(extractErrorFromPiOutput("plain text")).toBeNull();
	});
});

describe("extractTextFromPiOutput", () => {
	it("extracts text from valid pi JSON output", () => {
		const jsonOutput = JSON.stringify({
			messages: [
				{ role: "user", content: [{ type: "text", text: "Analyze this image" }] },
				{ role: "assistant", content: [{ type: "text", text: "This is an analysis" }] },
			],
		});
		expect(extractTextFromPiOutput(jsonOutput)).toBe("This is an analysis");
	});

	it("joins multiple text blocks with newlines", () => {
		const jsonOutput = JSON.stringify({
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "text", text: "First paragraph" },
						{ type: "text", text: "Second paragraph" },
					],
				},
			],
		});
		expect(extractTextFromPiOutput(jsonOutput)).toBe("First paragraph\nSecond paragraph");
	});

	it("filters out non-text content blocks", () => {
		const jsonOutput = JSON.stringify({
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Text content" },
						{ type: "image", source: { type: "base64", data: "..." } },
						{ type: "text", text: "More text" },
					],
				},
			],
		});
		expect(extractTextFromPiOutput(jsonOutput)).toBe("Text content\nMore text");
	});

	it("returns last assistant message when multiple exist", () => {
		const jsonOutput = JSON.stringify({
			messages: [
				{ role: "assistant", content: [{ type: "text", text: "First response" }] },
				{ role: "user", content: [{ type: "text", text: "Follow up" }] },
				{ role: "assistant", content: [{ type: "text", text: "Final response" }] },
			],
		});
		expect(extractTextFromPiOutput(jsonOutput)).toBe("Final response");
	});

	it("returns raw output if not valid JSON", () => {
		const plainText = "This is plain text output";
		expect(extractTextFromPiOutput(plainText)).toBe(plainText);
	});

	it("returns raw output if JSON has no messages", () => {
		const jsonOutput = JSON.stringify({ someOtherField: "value" });
		expect(extractTextFromPiOutput(jsonOutput)).toBe(jsonOutput);
	});

	it("returns raw output if messages is empty", () => {
		const jsonOutput = JSON.stringify({ messages: [] });
		expect(extractTextFromPiOutput(jsonOutput)).toBe(jsonOutput);
	});

	it("returns raw output if no assistant message", () => {
		const jsonOutput = JSON.stringify({
			messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
		});
		expect(extractTextFromPiOutput(jsonOutput)).toBe(jsonOutput);
	});

	it("handles assistant message with no content", () => {
		const jsonOutput = JSON.stringify({
			messages: [{ role: "assistant" }],
		});
		expect(extractTextFromPiOutput(jsonOutput)).toBe(jsonOutput);
	});

	it("handles content blocks with missing text field", () => {
		const jsonOutput = JSON.stringify({
			messages: [
				{
					role: "assistant",
					content: [{ type: "text" }, { type: "text", text: "Valid text" }],
				},
			],
		});
		expect(extractTextFromPiOutput(jsonOutput)).toBe("\nValid text");
	});

	it("extracts text from ndjson agent_end output", () => {
		const output = [
			JSON.stringify({ type: "session" }),
			JSON.stringify({
				type: "agent_end",
				messages: [
					{ role: "user", content: [{ type: "text", text: "Analyze" }] },
					{ role: "assistant", content: [{ type: "text", text: "NDJSON analysis" }] },
				],
			}),
		].join("\n");

		expect(extractTextFromPiOutput(output)).toBe("NDJSON analysis");
	});

	it("extracts text from ndjson assistant message output", () => {
		const output = [
			JSON.stringify({ type: "session" }),
			JSON.stringify({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "Final streamed response" }] },
			}),
		].join("\n");

		expect(extractTextFromPiOutput(output)).toBe("Final streamed response");
	});

	it("handles empty string input", () => {
		expect(extractTextFromPiOutput("")).toBe("");
	});
});
