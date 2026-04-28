#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const DEFAULT_BACKENDS = "nahcrof/kimi-k2.5-lightning,nahcrof/kimi-k2.6-precision";
const DEFAULT_MAIN_MODEL = "nahcrof/glm-5.1-precision";
const DEFAULT_IMAGE = join(repoRoot, "test-fixtures", "ui-screenshot.png");

const IMAGE_ANALYSIS_PROMPT = `You are analyzing an image. Follow these steps:

## Step 1: Classify

First, identify what type of image this is and state your classification:

**Category**: [one of: ui-screenshot, code-screenshot, error-screenshot, diagram, chart, general]

Then provide concise analysis grounded in the image.`;

function parseModelRef(ref) {
	const slashIndex = ref.indexOf("/");
	if (slashIndex <= 0 || slashIndex >= ref.length - 1) {
		throw new Error(`Invalid model ref ${JSON.stringify(ref)}; expected provider/model[:thinking]`);
	}
	const provider = ref.slice(0, slashIndex);
	let model = ref.slice(slashIndex + 1);
	let thinking;
	const colonIndex = model.lastIndexOf(":");
	if (colonIndex > 0) {
		const suffix = model.slice(colonIndex + 1);
		if (["off", "minimal", "low", "medium", "high", "xhigh"].includes(suffix)) {
			thinking = suffix;
			model = model.slice(0, colonIndex);
		}
	}
	return { provider, model, thinking, ref };
}

function piCommand() {
	return process.env.PI_MULTI_MODAL_BENCH_PI ?? "pi";
}

function runPi(args, options = {}) {
	const started = Date.now();
	return new Promise((resolvePromise, reject) => {
		const child = spawn(piCommand(), args, {
			cwd: options.cwd ?? repoRoot,
			env: options.env ?? process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			const elapsedMs = Date.now() - started;
			if (code !== 0) {
				const error = new Error(`pi exited ${code}: ${stderr}`);
				error.stdout = stdout;
				error.stderr = stderr;
				error.elapsedMs = elapsedMs;
				reject(error);
				return;
			}
			resolvePromise({ stdout, stderr, elapsedMs });
		});
	});
}

function extractAssistantText(output) {
	const trimmed = output.trim();
	const tryJson = (text) => {
		try {
			return JSON.parse(text);
		} catch {
			return null;
		}
	};
	const extractFromContent = (content) =>
		Array.isArray(content)
			? content
					.filter((block) => block?.type === "text")
					.map((block) => block.text ?? "")
					.join("\n")
			: "";
	const extract = (json) => {
		if (!json || typeof json !== "object") return "";
		if (Array.isArray(json.messages)) {
			const assistant = [...json.messages].reverse().find((msg) => msg?.role === "assistant");
			return extractFromContent(assistant?.content);
		}
		if (json.type === "agent_end") return extract({ messages: json.messages });
		if (json.message?.role === "assistant") return extractFromContent(json.message.content);
		return "";
	};
	const whole = extract(tryJson(trimmed));
	if (whole) return whole;
	for (const line of trimmed.split("\n").reverse()) {
		const text = extract(tryJson(line));
		if (text) return text;
	}
	return trimmed;
}

function awarenessInstruction(mode) {
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

function buildArgsForModel(modelRef) {
	const model = parseModelRef(modelRef);
	return [
		"--provider",
		model.provider,
		"--model",
		model.model,
		...(model.thinking ? ["--thinking", model.thinking] : []),
	];
}

async function seedConversation({ sessionFile, env, mainModel, tag }) {
	const seedPrompt = [
		"Benchmark setup only.",
		`The conversation-only media-analysis tag for the next visual task is ${tag}.`,
		"If a later media analyzer can see this conversation, it should be able to report that exact tag when explicitly asked.",
		"Reply with ACK and do not analyze any media yet.",
	].join(" ");
	await runPi(
		[
			"--session",
			sessionFile,
			"-e",
			repoRoot,
			...buildArgsForModel(mainModel),
			"--print",
			"--mode",
			"json",
			"--no-skills",
			"--no-context-files",
			"-p",
			seedPrompt,
		],
		{ env },
	);
}

async function runOne({ backend, mode, repeat, imagePath, mainModel }) {
	const tempRoot = await mkdtemp(join(tmpdir(), "pi-mm-awareness-bench-"));
	const sessionDir = join(tempRoot, "sessions");
	const sessionFile = join(sessionDir, "parent.jsonl");
	await mkdir(sessionDir, { recursive: true });

	const env = { ...process.env };
	delete env.PI_PACKAGE_DIR;

	const tag = `TAG-${Date.now().toString(36)}-${repeat}-${Math.random().toString(36).slice(2, 7)}`;
	await seedConversation({ sessionFile, env, mainModel, tag });

	const forkSessionDir = join(tempRoot, "forked-analysis");
	await mkdir(forkSessionDir, { recursive: true });
	const sessionArgs = mode === "fork" ? ["--fork", sessionFile, "--session-dir", forkSessionDir] : ["--no-session"];
	const prompt = [
		awarenessInstruction(mode),
		"",
		IMAGE_ANALYSIS_PROMPT,
		"",
		"Benchmark validation: after the normal image category, report exactly one line `CONTEXT_TAG: <tag-or-none>`.",
		`Only report ${tag} if it is available from conversation context. Otherwise report CONTEXT_TAG: none.`,
	].join("\n");

	const result = await runPi(
		[
			`@${imagePath}`,
			...sessionArgs,
			...buildArgsForModel(backend),
			"--print",
			"--mode",
			"json",
			"--no-skills",
			"--no-context-files",
			"--no-extensions",
			"-p",
			prompt,
		],
		{ env },
	);

	const text = extractAssistantText(result.stdout);
	const tagSeen = text.includes(tag);
	const contextLine = text.split(/\r?\n/).find((line) => /CONTEXT_TAG:/i.test(line)) ?? "";
	const pass = mode === "fork" ? tagSeen : !tagSeen;
	const record = {
		backend,
		mode,
		repeat,
		pass,
		tagSeen,
		contextLine,
		elapsedMs: result.elapsedMs,
		tempRoot,
		preview: text.slice(0, 700),
	};

	if (process.env.PI_MULTI_MODAL_BENCH_KEEP !== "1") {
		await rm(tempRoot, { recursive: true, force: true });
		delete record.tempRoot;
	}
	return record;
}

async function main() {
	const imagePath = resolve(process.env.PI_MULTI_MODAL_BENCH_IMAGE ?? DEFAULT_IMAGE);
	if (!existsSync(imagePath)) throw new Error(`Benchmark image not found: ${imagePath}`);
	const backends = (process.env.PI_MULTI_MODAL_BENCH_MODELS ?? DEFAULT_BACKENDS)
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	const modes = (process.env.PI_MULTI_MODAL_BENCH_MODES ?? "isolated,fork")
		.split(",")
		.map((value) => value.trim())
		.filter((value) => value === "isolated" || value === "fork");
	const repeats = Number.parseInt(process.env.PI_MULTI_MODAL_BENCH_REPEATS ?? "1", 10);
	const mainModel = process.env.PI_MULTI_MODAL_BENCH_MAIN_MODEL ?? DEFAULT_MAIN_MODEL;

	const results = [];
	for (const backend of backends) {
		for (const mode of modes) {
			for (let repeat = 1; repeat <= repeats; repeat += 1) {
				process.stderr.write(`benchmark backend=${backend} mode=${mode} repeat=${repeat}\n`);
				results.push(await runOne({ backend, mode, repeat, imagePath, mainModel }));
			}
		}
	}

	const passed = results.filter((result) => result.pass).length;
	console.log(
		JSON.stringify(
			{
				imagePath,
				mainModel,
				passed,
				total: results.length,
				results,
			},
			null,
			2,
		),
	);

	if (passed !== results.length) process.exitCode = 1;
}

main().catch((error) => {
	console.error(error?.stack ?? String(error));
	process.exitCode = 1;
});
