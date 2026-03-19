import { describe, expect, it } from "vitest";
import {
	buildImageReferenceSuffix,
	colorizeImagePlaceholders,
	extractAvailableVisionProviders,
	extractTextFromPiOutput,
	findExplicitImagePaths,
	findExplicitMediaPaths,
	findImagePlaceholderIds,
	findImageReferences,
	findInlineImagePaths,
	isImageFile,
	isVideoFile,
	needsVisionProxy,
	parseBashImageOutput,
	pickPreferredVisionProvider,
	replaceExplicitInlineImagePathsWithPlaceholders,
	replaceInlineImagePathsWithPlaceholders,
	resolveShowImagesSetting,
	SUPPORTED_IMAGE_EXTENSIONS,
	SUPPORTED_VIDEO_EXTENSIONS,
	sanitizeImagePromptForProvider,
	shouldRetryWithFallbackVisionProvider,
	supportsNativeImageInput,
} from "./utils.js";

describe("vision provider helpers", () => {
	it("parses available glm-4.6v providers from pi output", () => {
		const output = `provider      model        context  max-out  thinking  images
zai-legacy    glm-4.6v     131.1K   32.8K    no        yes
zai           glm-4.6v     131.1K   32.8K    no        yes
zai-messages  glm-5-turbo  202.8K   128K     yes       no`;
		expect(extractAvailableVisionProviders(output)).toEqual(["zai-legacy", "zai"]);
	});

	it("prefers zai over zai-legacy when both are available", () => {
		expect(pickPreferredVisionProvider(["zai-legacy", "zai"])).toBe("zai");
		expect(pickPreferredVisionProvider(["zai-legacy"])).toBe("zai-legacy");
	});

	it("retries provider fallback for auth or provider resolution errors", () => {
		expect(shouldRetryWithFallbackVisionProvider(new Error("No API key found for zai."))).toBe(true);
		expect(shouldRetryWithFallbackVisionProvider(new Error('No models matching "glm-4.6v"'))).toBe(true);
		expect(shouldRetryWithFallbackVisionProvider(new Error("Connection reset by peer"))).toBe(false);
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

	it("replaces inline image paths with numbered placeholders", () => {
		const text = "What do you see? /tmp/a.png and ./b.webp";
		expect(replaceInlineImagePathsWithPlaceholders(text)).toBe("What do you see? [Image #1] and [Image #2]");
	});

	it("replaces @-prefixed image paths without leaving the @ behind", () => {
		const text = "Read @/tmp/a.png and @./b.webp";
		expect(replaceInlineImagePathsWithPlaceholders(text)).toBe("Read [Image #1] and [Image #2]");
	});

	it("replaces only explicit @-prefixed image paths when requested", () => {
		const text = "Read @/tmp/a.png and /tmp/b.webp";
		expect(replaceExplicitInlineImagePathsWithPlaceholders(text)).toBe("Read [Image #1] and /tmp/b.webp");
	});

	it("preserves user newlines while replacing image paths", () => {
		const text = "What do you see? /tmp/a.png\n\nAnswer in under 10 words\n\nBe concise";
		expect(replaceInlineImagePathsWithPlaceholders(text)).toBe(
			"What do you see? [Image #1]\n\nAnswer in under 10 words\n\nBe concise",
		);
	});

	it("replaces only allowed image paths when provided", () => {
		const text = "Read /tmp/a.png and /tmp/missing.png";
		expect(replaceInlineImagePathsWithPlaceholders(text, ["/tmp/a.png"])).toBe("Read [Image #1] and /tmp/missing.png");
	});

	it("builds an image reference appendix with absolute paths", () => {
		expect(buildImageReferenceSuffix(["/tmp/a.png", "/tmp/b.webp"])).toBe(
			"\n\nImage references:\n[Image #1] /tmp/a.png\n[Image #2] /tmp/b.webp",
		);
	});

	it("colorizes placeholders yellow for display", () => {
		expect(colorizeImagePlaceholders("See [Image #1] and [Image #2]")).toBe(
			"See \x1b[33m[Image #1]\x1b[39m and \x1b[33m[Image #2]\x1b[39m",
		);
	});

	it("sanitizes display-only prompt additions before provider send", () => {
		const text = "What do you see? \x1b[33m[Image #1]\x1b[39m\n\nImage references:\n[Image #1] /tmp/a.png";
		expect(sanitizeImagePromptForProvider(text)).toBe("What do you see? [Image #1]");
	});

	it("finds placeholders and image paths in source order", () => {
		const text = "See [Image #2] and @/tmp/a.png plus ./b.webp";
		expect(findImageReferences(text)).toEqual([
			{ kind: "placeholder", fullMatch: "[Image #2]", index: 4, prefix: "", placeholderId: 2 },
			{ kind: "path", fullMatch: " @/tmp/a.png", index: 18, prefix: " ", path: "/tmp/a.png" },
			{ kind: "path", fullMatch: " ./b.webp", index: 35, prefix: " ", path: "./b.webp" },
		]);
	});

	it("extracts placeholder ids in order", () => {
		expect(findImagePlaceholderIds("[Image #3] [Image #12]")).toEqual([3, 12]);
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

	it("handles empty string input", () => {
		expect(extractTextFromPiOutput("")).toBe("");
	});
});
