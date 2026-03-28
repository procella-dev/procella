import type { ConnectionStatus } from "../../hooks/useEventSource";

const STATUS_COLORS: Record<ConnectionStatus, string> = {
	connected: "var(--color-status-success)",
	reconnecting: "var(--color-status-active)",
	disconnected: "var(--color-status-error)",
};

const STATUS_LABELS: Record<ConnectionStatus, string> = {
	connected: "Live",
	reconnecting: "Reconnecting…",
	disconnected: "Offline",
};

interface Props {
	status: ConnectionStatus;
}

export function ConnectionIndicator({ status }: Props) {
	return (
		<span
			title={STATUS_LABELS[status]}
			style={{
				display: "inline-flex",
				alignItems: "center",
				gap: "0.25rem",
				fontSize: "0.75rem",
				color: STATUS_COLORS[status],
			}}
		>
			<span
				style={{
					width: 6,
					height: 6,
					borderRadius: "50%",
					backgroundColor: STATUS_COLORS[status],
					animation:
						status === "reconnecting" ? "status-pulse 1.7s ease-in-out infinite" : undefined,
				}}
			/>
			{STATUS_LABELS[status]}
		</span>
	);
}
