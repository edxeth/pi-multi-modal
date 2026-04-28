import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAnalysisSessionArgsForTest, getAnalysisSessionAwarenessInstruction } from "./index.js";

describe("analysis session awareness", () => {
	it("describes isolated analysis as having no prior conversation", () => {
		const instruction = getAnalysisSessionAwarenessInstruction("isolated");

		expect(instruction).toContain("without access to the prior conversation");
		expect(instruction).toContain("Do not assume unstated context");
		expect(instruction).toContain("attached media");
	});

	it("describes forked analysis as having current conversation context", () => {
		const instruction = getAnalysisSessionAwarenessInstruction("fork");

		expect(instruction).toContain("temporary fork of the current Pi conversation");
		expect(instruction).toContain("prior conversation context");
		expect(instruction).toContain("ground every visual, video, or document claim");
	});

	it("uses fork args only when a source session file exists", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-multi-modal-test-"));
		try {
			const sessionFile = join(dir, "source.jsonl");
			await writeFile(sessionFile, "");

			const fork = await createAnalysisSessionArgsForTest({ mode: "fork", sourceSessionFile: sessionFile });
			expect(fork.mode).toBe("fork");
			expect(fork.args).toEqual(["--fork", sessionFile, "--session-dir", expect.any(String)]);
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
});
