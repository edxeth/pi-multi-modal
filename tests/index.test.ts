import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

	it("uses --fork when a source session file exists", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-multi-modal-test-"));
		try {
			const sessionFile = join(dir, "source.jsonl");
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
			});
			expect(fork.mode).toBe("fork");
			expect(fork.args[0]).toBe("--fork");
			expect(fork.args[1]).toBe(sessionFile);
			expect(fork.args[2]).toBe("--session-dir");
			expect(fork.args[3]).toBeTypeOf("string");
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

	it("uses --no-session for isolated mode regardless of session file", async () => {
		const result = await createAnalysisSessionArgsForTest({
			mode: "isolated",
			sourceSessionFile: "/tmp/nonexistent.jsonl",
		});
		expect(result.mode).toBe("isolated");
		expect(result.args).toEqual(["--no-session"]);
		await result.cleanup();
	});
});
