/**
 * Sixel encoder for terminal image rendering.
 *
 * Sixel is a terminal graphics protocol that tmux 3.4+ stores natively in its
 * grid — images survive pane redraws (unlike Kitty DCS passthrough). WezTerm,
 * Kitty, foot, and many other modern terminals support sixel.
 *
 * This module converts raw RGBA pixel data into sixel escape sequences using
 * uniform color quantization (216 web-safe colors, L=6 per channel).
 */

/**
 * Encode raw RGBA pixel data as a sixel escape sequence.
 *
 * @param pixels - RGBA pixel data (Uint8Array, 4 bytes per pixel)
 * @param width - Image width in pixels
 * @param height - Image height in pixels
 * @returns Sixel escape sequence string (DCS q ... ST)
 */
export function encodePixelsAsSixel(pixels: Uint8Array, width: number, height: number): string {
	const LEVELS = 6; // 6 levels per channel → 216 colors (web-safe palette)

	// Quantize a channel value (0-255) to a level (0-5)
	const quantize = (v: number) => Math.min(LEVELS - 1, Math.floor((v / 255) * LEVELS));

	// Map a quantized (r,g,b) triplet to a palette index (0-215)
	const colorIndex = (r: number, g: number, b: number) => r * LEVELS * LEVELS + g * LEVELS + b;

	// Build the quantized pixel grid: palette index per pixel
	const grid = new Uint8Array(width * height);
	const usedColors = new Set<number>();

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4;
			const a = pixels[i + 3];
			if (a < 128) {
				// Transparent → use color 0 (which we'll skip in rendering)
				grid[y * width + x] = 255; // sentinel for transparent
				continue;
			}
			const qr = quantize(pixels[i]);
			const qg = quantize(pixels[i + 1]);
			const qb = quantize(pixels[i + 2]);
			const ci = colorIndex(qr, qg, qb);
			grid[y * width + x] = ci;
			usedColors.add(ci);
		}
	}

	// Start sixel: DCS q "1;1;{width};{height}
	let out = `\x1bPq"1;1;${width};${height}`;

	// Define palette: only colors actually used
	for (const ci of usedColors) {
		const b = ci % LEVELS;
		const g = Math.floor(ci / LEVELS) % LEVELS;
		const r = Math.floor(ci / (LEVELS * LEVELS));
		const rPct = Math.round((r / (LEVELS - 1)) * 100);
		const gPct = Math.round((g / (LEVELS - 1)) * 100);
		const bPct = Math.round((b / (LEVELS - 1)) * 100);
		out += `#${ci};2;${rPct};${gPct};${bPct}`;
	}

	// Encode sixel rows (each row is 6 pixels tall)
	const sixelRows = Math.ceil(height / 6);

	for (let sr = 0; sr < sixelRows; sr++) {
		const startY = sr * 6;
		const endY = Math.min(startY + 6, height);
		const rowHeight = endY - startY;

		// Collect which colors appear in this sixel row
		const rowColors = new Set<number>();
		for (let y = startY; y < endY; y++) {
			for (let x = 0; x < width; x++) {
				const ci = grid[y * width + x];
				if (ci !== 255) rowColors.add(ci);
			}
		}

		let isFirstColor = true;
		for (const ci of rowColors) {
			if (!isFirstColor) {
				out += "$"; // carriage return (back to start of this sixel row)
			}
			isFirstColor = false;

			out += `#${ci}`;

			// Build the sixel characters for this color in this row
			// Use RLE (repeat-length encoding) for consecutive identical characters
			let prevChar = "";
			let runLength = 0;

			for (let x = 0; x < width; x++) {
				// Compute the 6-bit mask for this column
				let mask = 0;
				for (let bit = 0; bit < rowHeight; bit++) {
					const y = startY + bit;
					if (grid[y * width + x] === ci) {
						mask |= 1 << bit;
					}
				}
				const sixelChar = String.fromCharCode(63 + mask);

				if (sixelChar === prevChar) {
					runLength++;
				} else {
					if (runLength > 0) {
						out += runLength > 3 ? `!${runLength}${prevChar}` : prevChar.repeat(runLength);
					}
					prevChar = sixelChar;
					runLength = 1;
				}
			}
			// Flush last run
			if (runLength > 0) {
				out += runLength > 3 ? `!${runLength}${prevChar}` : prevChar.repeat(runLength);
			}
		}

		if (sr < sixelRows - 1) {
			out += "-"; // next sixel row
		}
	}

	out += "\x1b\\"; // ST (String Terminator)
	return out;
}

/**
 * Decode a base64-encoded image (PNG/JPEG/WebP/GIF) to raw RGBA pixels
 * using photon-node (WASM).
 *
 * Returns null if photon-node is unavailable or the image can't be decoded.
 */
export async function decodeImageToPixels(
	base64Data: string,
	_mimeType: string,
): Promise<{ pixels: Uint8Array; width: number; height: number } | null> {
	try {
		const photon = await import("@silvia-odwyer/photon-node/photon_rs.js");
		const bytes = Buffer.from(base64Data, "base64");
		const image = (photon as any).PhotonImage.new_from_byteslice(bytes);
		try {
			const width: number = image.get_width();
			const height: number = image.get_height();
			const pixels: Uint8Array = image.get_raw_pixels();
			return { pixels, width, height };
		} finally {
			image.free();
		}
	} catch {
		return null;
	}
}

/**
 * Scale pixel data to fit within maxWidth × maxHeight using nearest-neighbor.
 */
export function scalePixels(
	pixels: Uint8Array,
	srcWidth: number,
	srcHeight: number,
	maxWidth: number,
	maxHeight: number,
): { pixels: Uint8Array; width: number; height: number } {
	const scaleX = maxWidth / srcWidth;
	const scaleY = maxHeight / srcHeight;
	const scale = Math.min(scaleX, scaleY, 1); // don't upscale

	const dstWidth = Math.max(1, Math.round(srcWidth * scale));
	const dstHeight = Math.max(1, Math.round(srcHeight * scale));

	if (dstWidth === srcWidth && dstHeight === srcHeight) {
		return { pixels, width: srcWidth, height: srcHeight };
	}

	const dst = new Uint8Array(dstWidth * dstHeight * 4);

	for (let y = 0; y < dstHeight; y++) {
		const srcY = Math.min(Math.floor(y / scale), srcHeight - 1);
		for (let x = 0; x < dstWidth; x++) {
			const srcX = Math.min(Math.floor(x / scale), srcWidth - 1);
			const si = (srcY * srcWidth + srcX) * 4;
			const di = (y * dstWidth + x) * 4;
			dst[di] = pixels[si];
			dst[di + 1] = pixels[si + 1];
			dst[di + 2] = pixels[si + 2];
			dst[di + 3] = pixels[si + 3];
		}
	}

	return { pixels: dst, width: dstWidth, height: dstHeight };
}
