export type UpdateStatus =
	| "succeeded"
	| "failed"
	| "updating"
	| "cancelled"
	| "queued"
	| "not-started"
	| "running";

const STATUS_COLORS: Record<UpdateStatus, string> = {
	succeeded: "var(--color-status-success)",
	failed: "var(--color-status-error)",
	updating: "var(--color-status-active)",
	running: "var(--color-status-active)",
	cancelled: "var(--color-status-idle)",
	queued: "transparent",
	"not-started": "transparent",
};

const STATUS_LABELS: Record<UpdateStatus, string> = {
	succeeded: "Succeeded",
	failed: "Failed",
	updating: "Deploying",
	running: "Deploying",
	cancelled: "Cancelled",
	queued: "Queued",
	"not-started": "Not Started",
};

interface StatusDotProps {
	status: UpdateStatus;
	size?: number;
}

export function StatusDot({ status, size = 10 }: StatusDotProps) {
	const color = STATUS_COLORS[status];
	const isActive = status === "updating" || status === "running";
	const isOutline = status === "queued" || status === "not-started";

	return (
		<span
			data-status={status}
			style={{
				display: "inline-block",
				width: size,
				height: size,
				borderRadius: "50%",
				backgroundColor: isOutline ? "transparent" : color,
				border: isOutline ? `2px solid var(--color-status-idle)` : "none",
				flexShrink: 0,
				animation: isActive ? "status-pulse 1.7s ease-in-out infinite" : undefined,
			}}
		/>
	);
}

interface StatusBadgeProps {
	status: UpdateStatus;
	label?: string;
}

export function StatusBadge({ status, label }: StatusBadgeProps) {
	const displayLabel = label ?? STATUS_LABELS[status];
	const isActive = status === "updating" || status === "running";

	return (
		<span
			style={{
				display: "inline-flex",
				alignItems: "center",
				gap: "0.375rem",
				fontSize: "0.8125rem",
				color: isActive ? "var(--color-status-active)" : "var(--color-mist)",
			}}
		>
			<StatusDot status={status} />
			{displayLabel}
		</span>
	);
}
