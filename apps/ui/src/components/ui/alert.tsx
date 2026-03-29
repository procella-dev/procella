import type { ReactNode } from "react";

type AlertLevel = "info" | "danger";

interface AlertProps {
	level: AlertLevel;
	children: ReactNode;
}

export function Alert({ level, children }: AlertProps) {
	const isInfo = level === "info";

	return (
		<div
			role="alert"
			style={{
				display: "flex",
				gap: "0.75rem",
				padding: "0.75rem 1rem",
				borderRadius: 8,
				backgroundColor: isInfo ? "rgba(59, 130, 246, 0.1)" : "rgba(239, 68, 68, 0.1)",
				border: `1px solid ${isInfo ? "rgba(59, 130, 246, 0.25)" : "rgba(239, 68, 68, 0.25)"}`,
				color: isInfo ? "var(--color-status-success)" : "var(--color-status-error)",
				fontSize: "0.875rem",
			}}
		>
			<span style={{ flexShrink: 0, marginTop: 1 }}>{isInfo ? "ℹ" : "✕"}</span>
			<span style={{ color: "var(--color-mist)" }}>{children}</span>
		</div>
	);
}
