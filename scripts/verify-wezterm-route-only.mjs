import { readFileSync } from "node:fs";

const configPath = process.env.WEZTERM_CONFIG_PATH ?? "/mnt/c/Users/mysol/.wezterm.lua";
const source = readFileSync(configPath, "utf8");

const requiredSnippets = [
	'window:perform_action(act.SendKey { key = "F12" }, pane)',
	'window:perform_action(act.SendKey { key = "F11" }, pane)',
	"elseif pane_is_shell_prompt(pane) then",
	"paste_shell_smart(window, pane)",
];

const forbiddenSnippets = [
	"run_windows_powershell",
	"run_wsl_shell",
	"clipboard_has_image_fast",
	"save_clipboard_image_to_wsl",
	"paste_pi_smart",
];

const missing = requiredSnippets.filter((snippet) => !source.includes(snippet));
const forbidden = forbiddenSnippets.filter((snippet) => source.includes(snippet));

if (missing.length > 0 || forbidden.length > 0) {
	if (missing.length > 0) {
		console.error(`Missing route-only snippets in ${configPath}:`);
		for (const snippet of missing) console.error(`- ${snippet}`);
	}
	if (forbidden.length > 0) {
		console.error(`Forbidden clipboard-owner snippets still present in ${configPath}:`);
		for (const snippet of forbidden) console.error(`- ${snippet}`);
	}
	process.exit(1);
}

console.log(`Route-only WezTerm smart-paste config verified: ${configPath}`);
