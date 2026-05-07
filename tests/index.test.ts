import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAnalysisSessionArgsForTest, getAnalysisSessionAwarenessInstruction } from "../src/index.js";

describe("analysis session awareness", () => {
	it("keeps isolated analysis prompt free of prior-context assumptions", () => {
		const instruction = getAnalysisSessionAwarenessInstruction("isolated");

		expect(instruction).toContain("attached media");
		expect(instruction).toContain("Do not assume earlier chat context");
	});

	it("keeps forked analysis prompt short and history-aware without Pi internals", () => {
		const instruction = getAnalysisSessionAwarenessInstruction("fork");

		expect(instruction).toContain("previous conversation");
		expect(instruction).toContain("attached media");
		expect(instruction).not.toContain("fork");
		expect(instruction).not.toContain("Pi");
	});

	it("uses fork args only when a source session file exists", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-multi-modal-test-"));
		try {
			const sessionFile = join(dir, "source.jsonl");
			// Valid session with header and one message
			await writeFile(
				sessionFile,
				JSON.stringify({ type: "session", version: 3, id: "test", timestamp: new Date().toISOString(), cwd: dir }) +
					"\n" +
					JSON.stringify({
						type: "message",
						id: "msg-1",
						parentId: "test",
						timestamp: new Date().toISOString(),
						message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() },
					}) +
					"\n",
			);

			const fork = await createAnalysisSessionArgsForTest({
				mode: "fork",
				sourceSessionFile: sessionFile,
				analysisModelContextWindow: 262_144,
			});
			expect(fork.mode).toBe("fork");
			expect(fork.args[0]).toBe("--session");
			await fork.cleanup();

			const fallback = await createAnalysisSessionArgsForTest({
				mode: "fork",
				sourceSessionFile: join(dir, "missing.jsonl"),
			});
			expect(fallback.mode).toBe("isolated");
			expect(fallback.args).toEqual(["--no-session"]);
			await fallback.cleanup();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("drops the current user media turn and stale usage from forked analysis sessions", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-multi-modal-test-"));
		try {
			const sessionFile = join(dir, "source.jsonl");
			await writeFile(
				sessionFile,
				`${[
					JSON.stringify({
						type: "session",
						version: 3,
						id: "session-1",
						timestamp: new Date().toISOString(),
						cwd: dir,
					}),
					JSON.stringify({ type: "model_change", id: "model-1", parentId: "session-1" }),
					JSON.stringify({
						type: "message",
						id: "user-1",
						parentId: "model-1",
						message: { role: "user", content: [{ type: "text", text: "prior question" }] },
					}),
					JSON.stringify({
						type: "message",
						id: "assistant-1",
						parentId: "user-1",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "prior answer" }],
							usage: { input: 100, cacheRead: 200, totalTokens: 350 },
						},
					}),
					JSON.stringify({
						type: "message",
						id: "current-user-image",
						parentId: "assistant-1",
						message: {
							role: "user",
							content: [
								{ type: "text", text: '<file name="/tmp/current.png"></file> describe this' },
								{ type: "image", mimeType: "image/png", data: "base64-image-data" },
							],
						},
					}),
				].join("\n")}\n`,
			);

			const fork = await createAnalysisSessionArgsForTest({
				mode: "fork",
				sourceSessionFile: sessionFile,
				analysisModelContextWindow: 262_144,
			});

			const trimmed = await readFile(fork.args[1], "utf-8");
			expect(trimmed).toContain("prior question");
			expect(trimmed).toContain("prior answer");
			expect(trimmed).not.toContain("current-user-image");
			expect(trimmed).not.toContain("base64-image-data");
			expect(trimmed).not.toContain('"totalTokens":350');
			expect(trimmed).not.toContain('"cacheRead":200');
			expect(trimmed).toContain('"totalTokens":0');
			expect(trimmed).toContain('"cacheRead":0');
			await fork.cleanup();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("strips historical embedded image data from forked analysis sessions", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-multi-modal-test-"));
		try {
			const sessionFile = join(dir, "source.jsonl");
			await writeFile(
				sessionFile,
				`${[
					JSON.stringify({
						type: "session",
						version: 3,
						id: "session-1",
						timestamp: new Date().toISOString(),
						cwd: dir,
					}),
					JSON.stringify({
						type: "message",
						id: "historical-user-image",
						parentId: "session-1",
						message: {
							role: "user",
							content: [
								{ type: "text", text: '<file name="/tmp/old.png"></file> old image question' },
								{ type: "image", mimeType: "image/png", data: "old-base64-image-data" },
							],
						},
					}),
					JSON.stringify({
						type: "message",
						id: "assistant-1",
						parentId: "historical-user-image",
						message: {
							role: "assistant",
							content: [
								{ type: "text", text: "old image answer" },
								{ type: "toolCall", name: "bash", input: { command: "large command" } },
							],
							usage: { input: 100, cacheRead: 200, totalTokens: 350 },
						},
					}),
					JSON.stringify({
						type: "message",
						id: "tool-result-1",
						parentId: "assistant-1",
						message: { role: "toolResult", content: "huge historical tool output" },
					}),
				].join("\n")}\n`,
			);

			const fork = await createAnalysisSessionArgsForTest({
				mode: "fork",
				sourceSessionFile: sessionFile,
				analysisModelContextWindow: 262_144,
			});

			const trimmed = await readFile(fork.args[1], "utf-8");
			expect(trimmed).toContain("old image question");
			expect(trimmed).toContain("old image answer");
			expect(trimmed).not.toContain("old-base64-image-data");
			expect(trimmed).not.toContain("huge historical tool output");
			expect(trimmed).not.toContain('"type":"image"');
			expect(trimmed).not.toContain('"type":"toolCall"');
			await fork.cleanup();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("drops an oversized single-turn history that exceeds the child budget", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-multi-modal-test-"));
		try {
			const sessionFile = join(dir, "source.jsonl");
			await writeFile(
				sessionFile,
				`${[
					JSON.stringify({
						type: "session",
						version: 3,
						id: "session-1",
						timestamp: new Date().toISOString(),
						cwd: dir,
					}),
					JSON.stringify({ type: "model_change", id: "model-1", parentId: "session-1" }),
					JSON.stringify({
						type: "message",
						id: "oversized-user",
						parentId: "model-1",
						message: { role: "user", content: [{ type: "text", text: "oversized prior question" }] },
					}),
					JSON.stringify({
						type: "message",
						id: "oversized-assistant",
						parentId: "oversized-user",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "oversized prior answer" }],
							usage: { input: 290_000, cacheRead: 0, output: 100, totalTokens: 290_100 },
						},
					}),
				].join("\n")}\n`,
			);

			const fork = await createAnalysisSessionArgsForTest({
				mode: "fork",
				sourceSessionFile: sessionFile,
				analysisModelContextWindow: 262_144,
				reservedOutputTokens: 10_000,
			});

			const trimmed = await readFile(fork.args[1], "utf-8");
			expect(trimmed).not.toContain("oversized prior question");
			expect(trimmed).not.toContain("oversized prior answer");
			expect(trimmed).toContain('"type":"session"');
			await fork.cleanup();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("ignores trailing zero-usage assistant messages when trimming oversized history", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-multi-modal-test-"));
		try {
			const sessionFile = join(dir, "source.jsonl");
			await writeFile(
				sessionFile,
				`${[
					JSON.stringify({
						type: "session",
						version: 3,
						id: "session-1",
						timestamp: new Date().toISOString(),
						cwd: dir,
					}),
					JSON.stringify({ type: "model_change", id: "model-1", parentId: "session-1" }),
					JSON.stringify({
						type: "message",
						id: "oversized-user",
						parentId: "model-1",
						message: { role: "user", content: [{ type: "text", text: "oversized prior question" }] },
					}),
					JSON.stringify({
						type: "message",
						id: "oversized-assistant",
						parentId: "oversized-user",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "oversized prior answer" }],
							usage: { input: 314_000, cacheRead: 0, output: 100, totalTokens: 314_100 },
						},
					}),
					JSON.stringify({
						type: "message",
						id: "zero-usage-assistant",
						parentId: "oversized-assistant",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "failed analysis fallback" }],
							usage: { input: 0, cacheRead: 0, output: 0, totalTokens: 0 },
						},
					}),
				].join("\n")}\n`,
			);

			const fork = await createAnalysisSessionArgsForTest({
				mode: "fork",
				sourceSessionFile: sessionFile,
				analysisModelContextWindow: 262_144,
				reservedOutputTokens: 10_000,
			});

			const trimmed = await readFile(fork.args[1], "utf-8");
			expect(trimmed).not.toContain("oversized prior question");
			expect(trimmed).not.toContain("oversized prior answer");
			expect(trimmed).toContain("failed analysis fallback");
			await fork.cleanup();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
