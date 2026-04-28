import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";

type ClipboardImage = {
	bytes: Uint8Array;
	mimeType: string;
};

const require = createRequire(import.meta.url);
const SUPPORTED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const DEFAULT_LIST_TIMEOUT_MS = 1000;
const DEFAULT_READ_TIMEOUT_MS = 3000;
const DEFAULT_MAX_BUFFER_BYTES = 50 * 1024 * 1024;
const DEBUG_LOG_PATH = "/tmp/pi-multimodal-debug.log";
const WINDOWS_POWERSHELL_CANDIDATES = [
	"/mnt/c/Program Files/PowerShell/7/pwsh.exe",
	"/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
];

function debugLog(message: string): void {
	try {
		appendFileSync(DEBUG_LOG_PATH, `${new Date().toISOString()} ${message}\n`);
	} catch {}
}

function getClipboardModule(): { hasImage(): boolean; getImageBinary(): Promise<Uint8Array | number[] | null> } | null {
	const hasDisplay = process.platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
	if (process.env.TERMUX_VERSION || !hasDisplay) {
		return null;
	}

	try {
		return require("@mariozechner/clipboard");
	} catch {
		return null;
	}
}

function isWaylandSession(env = process.env): boolean {
	return Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland";
}

function baseMimeType(mimeType: string): string {
	return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}

export function extensionForImageMimeType(mimeType: string): string | null {
	switch (baseMimeType(mimeType)) {
		case "image/png":
			return "png";
		case "image/jpeg":
			return "jpg";
		case "image/webp":
			return "webp";
		case "image/gif":
			return "gif";
		default:
			return null;
	}
}

function selectPreferredImageMimeType(mimeTypes: string[]): string | null {
	const normalized = mimeTypes
		.map((type) => type.trim())
		.filter(Boolean)
		.map((type) => ({ raw: type, base: baseMimeType(type) }));

	for (const preferred of SUPPORTED_IMAGE_MIME_TYPES) {
		const match = normalized.find((type) => type.base === preferred);
		if (match) {
			return match.raw;
		}
	}

	const anyImage = normalized.find((type) => type.base.startsWith("image/"));
	return anyImage?.raw ?? null;
}

function isSupportedImageMimeType(mimeType: string): boolean {
	const base = baseMimeType(mimeType);
	return SUPPORTED_IMAGE_MIME_TYPES.includes(base);
}

async function convertToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
	try {
		const photon = await import("@silvia-odwyer/photon-node/photon_rs.js");
		const image = photon.PhotonImage.new_from_byteslice(bytes);
		try {
			return image.get_bytes();
		} finally {
			image.free();
		}
	} catch {
		return null;
	}
}

function runCommand(command: string, args: string[], options?: { timeoutMs?: number; maxBufferBytes?: number }) {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
	const maxBufferBytes = options?.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
	const result = spawnSync(command, args, {
		timeout: timeoutMs,
		maxBuffer: maxBufferBytes,
	});

	if (result.error || result.status !== 0) {
		return { ok: false as const, stdout: Buffer.alloc(0) };
	}

	const stdout = Buffer.isBuffer(result.stdout)
		? result.stdout
		: Buffer.from(result.stdout ?? "", typeof result.stdout === "string" ? "utf-8" : undefined);
	return { ok: true as const, stdout };
}

function readClipboardImageViaWlPaste(): ClipboardImage | null {
	const list = runCommand("wl-paste", ["--list-types"], { timeoutMs: DEFAULT_LIST_TIMEOUT_MS });
	if (!list.ok) {
		debugLog("wl-paste list-types failed");
		return null;
	}

	const types = list.stdout
		.toString("utf-8")
		.split(/\r?\n/)
		.map((type) => type.trim())
		.filter(Boolean);
	const selectedType = selectPreferredImageMimeType(types);
	debugLog(`wl-paste types=${JSON.stringify(types)} selected=${selectedType ?? "none"}`);
	if (!selectedType) {
		return null;
	}

	const data = runCommand("wl-paste", ["--type", selectedType, "--no-newline"]);
	if (!data.ok || data.stdout.length === 0) {
		debugLog(`wl-paste read failed type=${selectedType}`);
		return null;
	}

	return { bytes: data.stdout, mimeType: baseMimeType(selectedType) };
}

function readClipboardImageViaXclip(): ClipboardImage | null {
	const targets = runCommand("xclip", ["-selection", "clipboard", "-t", "TARGETS", "-o"], {
		timeoutMs: DEFAULT_LIST_TIMEOUT_MS,
	});

	let candidateTypes: string[] = [];
	if (targets.ok) {
		candidateTypes = targets.stdout
			.toString("utf-8")
			.split(/\r?\n/)
			.map((type) => type.trim())
			.filter(Boolean);
	}

	const preferred = candidateTypes.length > 0 ? selectPreferredImageMimeType(candidateTypes) : null;
	const tryTypes = preferred ? [preferred, ...SUPPORTED_IMAGE_MIME_TYPES] : [...SUPPORTED_IMAGE_MIME_TYPES];
	for (const mimeType of tryTypes) {
		const data = runCommand("xclip", ["-selection", "clipboard", "-t", mimeType, "-o"]);
		if (data.ok && data.stdout.length > 0) {
			return { bytes: data.stdout, mimeType: baseMimeType(mimeType) };
		}
	}

	return null;
}

function readClipboardImageViaWindowsPowerShell(env = process.env): ClipboardImage | null {
	if (!env.WSL_INTEROP) {
		debugLog("windows fallback skipped: no WSL_INTEROP");
		return null;
	}

	const powershell = WINDOWS_POWERSHELL_CANDIDATES.find((candidate) => runCommand("test", ["-x", candidate]).ok);
	if (!powershell) {
		debugLog("windows fallback skipped: no powershell candidate");
		return null;
	}
	debugLog(`windows fallback using=${powershell}`);

	const script = [
		"$ErrorActionPreference = 'Stop'",
		"Add-Type -AssemblyName System.Windows.Forms",
		"Add-Type -AssemblyName System.Drawing",
		"if (-not [Windows.Forms.Clipboard]::ContainsImage()) { exit 3 }",
		"$img = [Windows.Forms.Clipboard]::GetImage()",
		"if ($null -eq $img) { exit 4 }",
		"$ms = New-Object System.IO.MemoryStream",
		"try {",
		"  $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)",
		"  [Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()))",
		"} finally {",
		"  $ms.Dispose()",
		"  $img.Dispose()",
		"}",
	].join("; ");

	const result = runCommand(powershell, ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], {
		timeoutMs: DEFAULT_READ_TIMEOUT_MS,
		maxBufferBytes: DEFAULT_MAX_BUFFER_BYTES,
	});
	if (!result.ok || result.stdout.length === 0) {
		debugLog("windows fallback read failed or empty");
		return null;
	}
	debugLog(`windows fallback base64_len=${result.stdout.length}`);

	try {
		const bytes = Buffer.from(result.stdout.toString("utf-8").trim(), "base64");
		if (bytes.length === 0) {
			debugLog("windows fallback decoded empty bytes");
			return null;
		}
		debugLog(`windows fallback decoded_bytes=${bytes.length}`);
		return { bytes, mimeType: "image/png" };
	} catch (error) {
		debugLog(`windows fallback decode error=${String(error)}`);
		return null;
	}
}

export async function readClipboardImage(options?: {
	env?: NodeJS.ProcessEnv;
	platform?: NodeJS.Platform;
}): Promise<ClipboardImage | null> {
	const env = options?.env ?? process.env;
	const platform = options?.platform ?? process.platform;
	if (env.TERMUX_VERSION) {
		return null;
	}

	let image: ClipboardImage | null = null;
	debugLog(
		`readClipboardImage start platform=${platform} wayland=${String(isWaylandSession(env))} display=${env.DISPLAY ?? ""} wayland_display=${env.WAYLAND_DISPLAY ?? ""} wsl_interop=${env.WSL_INTEROP ? "yes" : "no"}`,
	);
	if (platform === "linux") {
		image = isWaylandSession(env)
			? (readClipboardImageViaWlPaste() ?? readClipboardImageViaXclip())
			: readClipboardImageViaXclip();
		image ??= readClipboardImageViaWindowsPowerShell(env);
	} else {
		const clipboard = getClipboardModule();
		if (!clipboard?.hasImage()) {
			return null;
		}
		const imageData = await clipboard.getImageBinary();
		if (!imageData || imageData.length === 0) {
			return null;
		}
		const bytes = imageData instanceof Uint8Array ? imageData : Uint8Array.from(imageData);
		image = { bytes, mimeType: "image/png" };
	}

	if (!image) {
		debugLog("readClipboardImage result=null");
		return null;
	}
	debugLog(`readClipboardImage mime=${image.mimeType} bytes=${image.bytes.length}`);

	if (!isSupportedImageMimeType(image.mimeType)) {
		const pngBytes = await convertToPng(image.bytes);
		if (!pngBytes) {
			return null;
		}
		return { bytes: pngBytes, mimeType: "image/png" };
	}

	return image;
}
