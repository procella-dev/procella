const isCI = !!process.env.CI;
const noColor = !!process.env.NO_COLOR || isCI;

const codes = {
	reset: noColor ? "" : "\x1b[0m",
	bold: noColor ? "" : "\x1b[1m",
	dim: noColor ? "" : "\x1b[2m",
	red: noColor ? "" : "\x1b[31m",
	green: noColor ? "" : "\x1b[32m",
	yellow: noColor ? "" : "\x1b[33m",
	blue: noColor ? "" : "\x1b[34m",
	cyan: noColor ? "" : "\x1b[36m",
} as const;

function write(stream: NodeJS.WriteStream, msg: string): void {
	stream.write(`${msg}\n`);
}

export function info(msg: string): void {
	write(process.stdout, msg);
}

export function success(msg: string): void {
	write(process.stdout, `${codes.green}✓${codes.reset} ${msg}`);
}

export function warn(msg: string): void {
	write(process.stderr, `${codes.yellow}⚠${codes.reset} ${msg}`);
}

export function error(msg: string): void {
	write(process.stderr, `${codes.red}✗${codes.reset} ${msg}`);
}

export function dim(msg: string): void {
	write(process.stdout, `${codes.dim}${msg}${codes.reset}`);
}

export function heading(msg: string): void {
	write(process.stdout, `\n${codes.bold}${msg}${codes.reset}`);
}

export function step(n: number, total: number, msg: string): void {
	write(process.stdout, `${codes.dim}[${n}/${total}]${codes.reset} ${msg}`);
}

export function table(headers: string[], rows: string[][]): void {
	const widths = headers.map((h, i) => {
		const colValues = rows.map((r) => (r[i] ?? "").length);
		return Math.max(h.length, ...colValues);
	});

	const header = headers.map((h, i) => h.padEnd(widths[i])).join("  ");
	const separator = widths.map((w) => "─".repeat(w)).join("──");

	write(process.stdout, `${codes.bold}${header}${codes.reset}`);
	write(process.stdout, `${codes.dim}${separator}${codes.reset}`);

	for (const row of rows) {
		const line = row.map((cell, i) => (cell ?? "").padEnd(widths[i])).join("  ");
		write(process.stdout, line);
	}
}
