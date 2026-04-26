import { useMemo } from "react";

interface EscRevisionDiffProps {
	leftYaml: string;
	rightYaml: string;
	leftLabel: string;
	rightLabel: string;
	onClose: () => void;
}

interface DiffLine {
	type: "equal" | "added" | "removed";
	text: string;
	lineNum: number;
}

function computeDiff(left: string, right: string): DiffLine[] {
	const leftLines = left.split("\n");
	const rightLines = right.split("\n");
	const result: DiffLine[] = [];
	const maxLen = Math.max(leftLines.length, rightLines.length);
	let lineNum = 1;

	// Simple line-by-line comparison — sufficient for YAML diffs
	let li = 0;
	let ri = 0;
	while (li < leftLines.length || ri < rightLines.length) {
		if (li < leftLines.length && ri < rightLines.length) {
			if (leftLines[li] === rightLines[ri]) {
				result.push({ type: "equal", text: rightLines[ri], lineNum: lineNum++ });
				li++;
				ri++;
			} else {
				// Look ahead for a match within a small window
				const window = Math.min(5, maxLen);
				let foundRight = -1;
				let foundLeft = -1;
				for (let w = 1; w <= window; w++) {
					if (ri + w < rightLines.length && leftLines[li] === rightLines[ri + w]) {
						foundRight = ri + w;
						break;
					}
					if (li + w < leftLines.length && leftLines[li + w] === rightLines[ri]) {
						foundLeft = li + w;
						break;
					}
				}
				if (foundRight >= 0) {
					// Lines were added in right
					for (let j = ri; j < foundRight; j++) {
						result.push({ type: "added", text: rightLines[j], lineNum: lineNum++ });
					}
					ri = foundRight;
				} else if (foundLeft >= 0) {
					// Lines were removed from left
					for (let j = li; j < foundLeft; j++) {
						result.push({ type: "removed", text: leftLines[j], lineNum: lineNum++ });
					}
					li = foundLeft;
				} else {
					result.push({ type: "removed", text: leftLines[li], lineNum: lineNum++ });
					result.push({ type: "added", text: rightLines[ri], lineNum: lineNum++ });
					li++;
					ri++;
				}
			}
		} else if (li < leftLines.length) {
			result.push({ type: "removed", text: leftLines[li], lineNum: lineNum++ });
			li++;
		} else {
			result.push({ type: "added", text: rightLines[ri], lineNum: lineNum++ });
			ri++;
		}
	}
	return result;
}

const LINE_STYLES: Record<DiffLine["type"], string> = {
	equal: "text-cloud",
	added: "bg-emerald-950/40 text-emerald-300",
	removed: "bg-red-950/40 text-red-300",
};

const PREFIX: Record<DiffLine["type"], string> = {
	equal: " ",
	added: "+",
	removed: "-",
};

export function EscRevisionDiff({
	leftYaml,
	rightYaml,
	leftLabel,
	rightLabel,
	onClose,
}: EscRevisionDiffProps) {
	const diff = useMemo(() => computeDiff(leftYaml, rightYaml), [leftYaml, rightYaml]);

	const stats = useMemo(() => {
		let added = 0;
		let removed = 0;
		for (const line of diff) {
			if (line.type === "added") added++;
			if (line.type === "removed") removed++;
		}
		return { added, removed };
	}, [diff]);

	const noDiff = stats.added === 0 && stats.removed === 0;

	return (
		<div className="border border-slate-brand rounded-xl overflow-hidden">
			<div className="flex items-center justify-between bg-slate-brand/60 px-4 py-2.5 border-b border-slate-brand">
				<div className="flex items-center gap-3 text-xs">
					<span className="text-cloud">{leftLabel}</span>
					<span className="text-cloud/40">→</span>
					<span className="text-mist">{rightLabel}</span>
					{!noDiff && (
						<span className="text-cloud/60 ml-2">
							<span className="text-emerald-400">+{stats.added}</span>
							{" / "}
							<span className="text-red-400">-{stats.removed}</span>
						</span>
					)}
				</div>
				<div className="flex items-center gap-2">
					<button
						type="button"
						onClick={onClose}
						className="text-xs text-cloud hover:text-mist transition-colors px-2 py-1"
					>
						✕ Close
					</button>
				</div>
			</div>

			{noDiff ? (
				<div className="px-4 py-6 text-center text-sm text-cloud/60">
					No differences between these revisions.
				</div>
			) : (
				<div className="overflow-auto max-h-[500px] bg-zinc-900 font-mono text-xs leading-5">
					{diff.map((line) => (
						<div
							key={`${line.lineNum}-${line.type}`}
							className={`flex ${LINE_STYLES[line.type]} border-b border-zinc-800/30`}
						>
							<span className="w-8 shrink-0 text-right pr-2 text-cloud/30 select-none border-r border-zinc-700/40">
								{line.lineNum}
							</span>
							<span className="w-5 shrink-0 text-center select-none opacity-60">
								{PREFIX[line.type]}
							</span>
							<span className="flex-1 px-2 whitespace-pre">{line.text}</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
