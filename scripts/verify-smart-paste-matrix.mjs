import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const reportPath = process.env.SMART_PASTE_REPORT_PATH ?? "/tmp/ralph-smart-paste-matrix-report.json";

const steps = [
	{ id: "router", command: ["npm", ["run", "--silent", "verify:smart-paste:router"]] },
	{ id: "direct-shell", command: ["npm", ["run", "--silent", "verify:smart-paste:direct-shell"]] },
	{ id: "direct-nvim", command: ["npm", ["run", "--silent", "verify:smart-paste:direct-nvim"]] },
	{ id: "direct-pi", command: ["npm", ["run", "--silent", "verify:smart-paste:direct-pi"]] },
	{ id: "tmux-shell", command: ["npm", ["run", "--silent", "verify:smart-paste:tmux-shell"]] },
	{ id: "tmux-nvim", command: ["npm", ["run", "--silent", "verify:smart-paste:tmux-nvim"]] },
	{ id: "tmux-pi", command: ["npm", ["run", "--silent", "verify:smart-paste:tmux-pi"]] },
];

function proofLines(output) {
	return output
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.filter(
			(line) =>
				line.includes("proof:") ||
				line.includes("env:") ||
				line.includes("blocker:") ||
				line.includes("verified") ||
				line.includes("Route-only"),
		);
}

const results = [];

for (const step of steps) {
	const startedAt = new Date().toISOString();
	const start = Date.now();
	const [command, args] = step.command;
	const run = spawnSync(command, args, {
		cwd: process.cwd(),
		encoding: "utf8",
		env: process.env,
	});
	const durationMs = Date.now() - start;
	const stdout = run.stdout ?? "";
	const stderr = run.stderr ?? "";
	const combined = [stdout, stderr].filter(Boolean).join("\n");
	const result = {
		id: step.id,
		startedAt,
		durationMs,
		exitCode: run.status ?? 1,
		command: [command, ...args].join(" "),
		proof: proofLines(combined),
		stdout,
		stderr,
	};
	results.push(result);

	if (run.status !== 0) {
		const report = {
			generatedAt: new Date().toISOString(),
			reportPath,
			status: "failed",
			results,
		};
		mkdirSync(dirname(reportPath), { recursive: true });
		writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
		console.error(`Smart-paste matrix failed at ${step.id}. Report: ${reportPath}`);
		for (const line of result.proof) console.error(line);
		if (!result.proof.length && combined.trim()) console.error(combined.trim());
		process.exit(run.status ?? 1);
	}
}

const report = {
	generatedAt: new Date().toISOString(),
	reportPath,
	status: "passed",
	results,
};

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(`Smart-paste matrix verified. Report: ${resolve(reportPath)}`);
for (const result of results) {
	for (const line of result.proof) console.log(line);
}
