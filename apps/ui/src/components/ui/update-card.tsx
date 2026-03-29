import { Link } from "react-router";
import { Row, Stack } from "./layout";
import { StatusDot, type UpdateStatus } from "./status";

interface UpdateCardProps {
	updateId: string;
	href: string;
	kind: string;
	status: UpdateStatus;
	resourceChanges?: { creates: number; updates: number; deletes: number };
	startedAt?: string | null;
	completedAt?: string | null;
	isFirst?: boolean;
	isLast?: boolean;
}

function formatRelativeTime(iso: string): string {
	const diff = Date.now() - new Date(iso).getTime();
	const minutes = Math.floor(diff / 60000);
	const hours = Math.floor(diff / 3600000);
	const days = Math.floor(diff / 86400000);
	if (days > 0) return `${String(days)}d ago`;
	if (hours > 0) return `${String(hours)}h ago`;
	if (minutes > 0) return `${String(minutes)}m ago`;
	return "just now";
}

function formatDuration(startedAt: string, completedAt: string): string {
	const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
	const s = Math.floor(ms / 1000);
	const m = Math.floor(s / 60);
	if (m > 0) return `${String(m)}m ${String(s % 60)}s`;
	return `${String(s)}s`;
}

const KIND_LABELS: Record<string, string> = {
	update: "pulumi up",
	preview: "pulumi preview",
	destroy: "pulumi destroy",
	refresh: "pulumi refresh",
	import: "pulumi import",
};

export function UpdateCard({
	updateId,
	href,
	kind,
	status,
	resourceChanges,
	startedAt,
	completedAt,
	isFirst,
	isLast,
}: UpdateCardProps) {
	return (
		<div
			style={{
				position: "relative",
				borderRadius: isFirst ? "8px 8px 0 0" : isLast ? "0 0 8px 8px" : 0,
				borderBottom: isLast ? undefined : "1px solid rgba(255,255,255,0.06)",
				backgroundColor: "var(--color-surface-secondary)",
			}}
		>
			<Link
				to={href}
				style={{
					position: "absolute",
					inset: 0,
					zIndex: 0,
					borderRadius: "inherit",
				}}
				aria-label={`Open update ${updateId}`}
			/>
			<Row
				space="3"
				align="center"
				style={{
					padding: "0.875rem 1rem",
					position: "relative",
					zIndex: 1,
					pointerEvents: "none",
				}}
			>
				<StatusDot status={status} size={10} />
				<Stack space="0.5" style={{ flex: 1, minWidth: 0 }}>
					<span
						style={{
							fontFamily: "var(--font-mono)",
							fontSize: "var(--text-mono-sm)",
							color: "var(--color-mist)",
							fontWeight: 500,
						}}
					>
						{KIND_LABELS[kind] ?? kind}
					</span>
					{resourceChanges && (
						<span style={{ fontSize: "0.75rem", color: "var(--color-cloud)" }}>
							{resourceChanges.creates > 0 && `+${String(resourceChanges.creates)} `}
							{resourceChanges.updates > 0 && `~${String(resourceChanges.updates)} `}
							{resourceChanges.deletes > 0 && `-${String(resourceChanges.deletes)}`}
							{resourceChanges.creates === 0 &&
								resourceChanges.updates === 0 &&
								resourceChanges.deletes === 0 &&
								"no changes"}
						</span>
					)}
				</Stack>
				<Stack space="0.5" align="end">
					{startedAt && (
						<span
							style={{
								fontSize: "0.75rem",
								color: "var(--color-cloud)",
								fontFamily: "var(--font-mono)",
							}}
						>
							{formatRelativeTime(startedAt)}
						</span>
					)}
					{startedAt && completedAt && (
						<span
							style={{
								fontSize: "0.6875rem",
								color: "var(--color-status-idle)",
								fontFamily: "var(--font-mono)",
							}}
						>
							{formatDuration(startedAt, completedAt)}
						</span>
					)}
				</Stack>
			</Row>
		</div>
	);
}
