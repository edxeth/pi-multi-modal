import {
	type Component,
	getCapabilities,
	getImageDimensions,
	calculateImageRows,
	getCellDimensions,
	encodeKitty,
} from "@mariozechner/pi-tui";

export interface GalleryTheme {
	accent: (s: string) => string;
	muted: (s: string) => string;
	dim: (s: string) => string;
	bold: (s: string) => string;
}

export interface GalleryImage {
	data: string;
	mimeType: string;
	label: string;
}

const THUMB_MAX_WIDTH = 25;
const GAP = 2;

let nextImageId = 1;
function allocateImageId(): number {
	const id = nextImageId;
	nextImageId = (nextImageId % 0xffffff) + 1;
	return id;
}

const ROW_COL_DIACRITICS = [
	0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f,
	0x0346, 0x034a, 0x034b, 0x034c, 0x0350, 0x0351, 0x0352, 0x0353,
	0x0357, 0x035b, 0x0363, 0x0364, 0x0365, 0x0366, 0x0367, 0x0368,
	0x0369, 0x036a, 0x036b, 0x036c, 0x036d, 0x036e, 0x036f, 0x0483,
	0x0484, 0x0485, 0x0486, 0x0592, 0x0593, 0x0594, 0x0595, 0x0597,
	0x0598, 0x0599, 0x059c, 0x059d, 0x059e, 0x059f, 0x05a0, 0x05a1,
	0x05a8, 0x05a9, 0x05ab, 0x05ac, 0x05af, 0x05c4, 0x0610, 0x0611,
	0x0612, 0x0613, 0x0614, 0x0615, 0x0616, 0x0617, 0x0618, 0x0619,
	0x061a, 0x064b, 0x064c, 0x064d, 0x064e, 0x064f, 0x0650, 0x0651,
	0x0652, 0x0653, 0x0654, 0x0655, 0x0656, 0x0657, 0x0658, 0x0659,
	0x065a, 0x065b, 0x065c, 0x065d, 0x065e, 0x065f, 0x0670, 0x06d6,
	0x06d7, 0x06d8, 0x06d9, 0x06da, 0x06db, 0x06dc, 0x06df, 0x06e0,
	0x06e1, 0x06e2, 0x06e3, 0x06e4, 0x06e7, 0x06e8, 0x06ea, 0x06eb,
	0x06ec, 0x06ed,
];
const PLACEHOLDER_CHAR = String.fromCodePoint(0x10eeee);

function diacriticFor(n: number): string {
	if (n < ROW_COL_DIACRITICS.length) {
		return String.fromCodePoint(ROW_COL_DIACRITICS[n]);
	}
	return String.fromCodePoint(ROW_COL_DIACRITICS[0]);
}

function isInTmux(): boolean {
	return Boolean(process.env.TMUX);
}

function wrapForTmux(sequence: string): string {
	if (!isInTmux()) return sequence;
	return sequence.replace(
		/\x1b_G([^\x1b]*)\x1b\\/g,
		(_match, content) => `\x1bPtmux;\x1b\x1b_G${content}\x1b\x1b\\\x1b\\`,
	);
}

function transmitImageWithPlaceholder(base64Data: string, imageId: number, columns: number, rows: number): void {
	const CHUNK_SIZE = 4096;

	if (base64Data.length <= CHUNK_SIZE) {
		const seq = `\x1b_Ga=T,U=1,f=100,i=${imageId},c=${columns},r=${rows},q=2;${base64Data}\x1b\\`;
		process.stdout.write(wrapForTmux(seq));
		return;
	}

	let offset = 0;
	let isFirst = true;
	while (offset < base64Data.length) {
		const chunk = base64Data.slice(offset, offset + CHUNK_SIZE);
		const isLast = offset + CHUNK_SIZE >= base64Data.length;
		let seq: string;

		if (isFirst) {
			seq = `\x1b_Ga=T,U=1,f=100,i=${imageId},c=${columns},r=${rows},q=2,m=1;${chunk}\x1b\\`;
			isFirst = false;
		} else if (isLast) {
			seq = `\x1b_Gm=0;${chunk}\x1b\\`;
		} else {
			seq = `\x1b_Gm=1;${chunk}\x1b\\`;
		}

		process.stdout.write(wrapForTmux(seq));
		offset += CHUNK_SIZE;
	}
}

function deleteImage(imageId: number): void {
	const seq = `\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`;
	process.stdout.write(wrapForTmux(seq));
}

function isKittyTerminal(): boolean {
	const termProgram = process.env.TERM_PROGRAM?.toLowerCase() ?? "";
	return Boolean(process.env.KITTY_WINDOW_ID) || termProgram === "kitty";
}

function buildPlaceholderRow(imageId: number, row: number, columns: number): string {
	const r = (imageId >> 16) & 0xff;
	const g = (imageId >> 8) & 0xff;
	const b = imageId & 0xff;
	const fgStart = imageId < 256
		? `\x1b[38;5;${imageId}m`
		: `\x1b[38;2;${r};${g};${b}m`;
	const fgEnd = "\x1b[39m";

	let line = fgStart;
	line += PLACEHOLDER_CHAR + diacriticFor(row) + diacriticFor(0);
	for (let col = 1; col < columns; col++) {
		line += PLACEHOLDER_CHAR;
	}
	line += fgEnd;
	return line;
}

export class ImageGallery implements Component {
	private images: GalleryImage[] = [];
	private theme: GalleryTheme;
	private cachedLines?: string[];
	private cachedWidth?: number;
	private activeImageIds: number[] = [];

	constructor(theme: GalleryTheme) {
		this.theme = theme;
	}

	setImages(images: GalleryImage[]): void {
		this.images = images;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedWidth = undefined;
	}

	dispose(): void {
		for (const id of this.activeImageIds) {
			deleteImage(id);
		}
		this.activeImageIds = [];
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		for (const id of this.activeImageIds) {
			deleteImage(id);
		}
		this.activeImageIds = [];

		if (this.images.length === 0) {
			this.cachedLines = [];
			this.cachedWidth = width;
			return this.cachedLines;
		}

		const lines: string[] = [];
		const caps = getCapabilities();
		const count = this.images.length;
		lines.push(this.theme.accent(count === 1 ? " 📎 1 image attached" : ` 📎 ${count} images attached`));

		if (caps.images === "kitty") {
			if (isInTmux() && !isKittyTerminal()) {
				this.renderKittyPassthrough(lines, width);
			} else {
				this.renderKittyHorizontal(lines, width);
			}
		} else {
			this.renderTextFallback(lines);
		}

		this.cachedLines = lines;
		this.cachedWidth = width;
		return this.cachedLines;
	}

	private renderKittyHorizontal(lines: string[], width: number): void {
		const available = width - 2;
		const totalGaps = Math.max(0, this.images.length - 1) * GAP;
		const thumbWidth = Math.min(THUMB_MAX_WIDTH, Math.floor((available - totalGaps) / this.images.length));
		if (thumbWidth < 4) {
			this.renderTextFallback(lines);
			return;
		}

		const imageInfos: { imageId: number; rows: number; cols: number }[] = [];
		for (const img of this.images) {
			const dims = getImageDimensions(img.data, img.mimeType) || { widthPx: 800, heightPx: 600 };
			const rows = calculateImageRows(dims, thumbWidth, getCellDimensions());
			const imageId = allocateImageId();
			this.activeImageIds.push(imageId);
			transmitImageWithPlaceholder(img.data, imageId, thumbWidth, rows);
			imageInfos.push({ imageId, rows, cols: thumbWidth });
		}

		const maxRows = Math.max(...imageInfos.map((info) => info.rows));
		for (let row = 0; row < maxRows; row++) {
			let line = " ";
			for (let i = 0; i < this.images.length; i++) {
				const info = imageInfos[i];
				if (row < info.rows) {
					line += buildPlaceholderRow(info.imageId, row, info.cols);
				} else {
					line += " ".repeat(info.cols);
				}
				if (i < this.images.length - 1) {
					line += " ".repeat(GAP);
				}
			}
			lines.push(line);
		}

		let labelLine = " ";
		for (let i = 0; i < this.images.length; i++) {
			const cols = imageInfos[i].cols;
			let label = this.images[i].label;
			if (label.length > cols) {
				const keep = cols - 1;
				const head = Math.ceil(keep / 2);
				const tail = keep - head;
				label = label.slice(0, head) + "…" + label.slice(-tail);
			}

			const totalPad = Math.max(0, cols - label.length);
			const leftPad = Math.floor(totalPad / 2);
			const rightPad = totalPad - leftPad;
			labelLine += this.theme.dim(" ".repeat(leftPad) + label + " ".repeat(rightPad));
			if (i < this.images.length - 1) {
				labelLine += " ".repeat(GAP);
			}
		}
		lines.push(labelLine);
	}

	private renderKittyPassthrough(lines: string[], width: number): void {
		const maxWidth = Math.min(width - 2, THUMB_MAX_WIDTH);
		for (const img of this.images) {
			const dims = getImageDimensions(img.data, img.mimeType) || { widthPx: 800, heightPx: 600 };
			const rows = calculateImageRows(dims, maxWidth, getCellDimensions());
			const sequence = wrapForTmux(encodeKitty(img.data, { columns: maxWidth, rows }));
			for (let row = 0; row < rows - 1; row++) {
				lines.push("");
			}
			const moveUp = rows > 1 ? `\x1b[${rows - 1}A` : "";
			lines.push(` ${moveUp}${sequence}`);
			lines.push(this.theme.dim(`  ${img.label}`));
			lines.push("");
		}
		if (lines.at(-1) === "") {
			lines.pop();
		}
	}

	private renderTextFallback(lines: string[]): void {
		for (const img of this.images) {
			lines.push(this.theme.muted(`  ${img.label}`));
		}
	}
}
