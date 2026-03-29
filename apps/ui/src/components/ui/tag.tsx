import type { ReactNode } from "react";

type TagLevel = "info" | "success" | "warning" | "danger" | "default";
type TagVariant = "solid" | "outline";

interface TagProps {
	level?: TagLevel;
	variant?: TagVariant;
	children: ReactNode;
}

const LEVEL_COLORS: Record<TagLevel, { bg: string; text: string; border: string }> = {
	info: {
		bg: "rgba(59, 130, 246, 0.15)",
		text: "var(--color-status-success)",
		border: "rgba(59, 130, 246, 0.3)",
	},
	success: {
		bg: "rgba(16, 185, 129, 0.15)",
		text: "var(--color-success)",
		border: "rgba(16, 185, 129, 0.3)",
	},
	warning: {
		bg: "rgba(245, 158, 11, 0.15)",
		text: "var(--color-status-active)",
		border: "rgba(245, 158, 11, 0.3)",
	},
	danger: {
		bg: "rgba(239, 68, 68, 0.15)",
		text: "var(--color-status-error)",
		border: "rgba(239, 68, 68, 0.3)",
	},
	default: {
		bg: "rgba(255,255,255,0.06)",
		text: "var(--color-cloud)",
		border: "rgba(255,255,255,0.1)",
	},
};

export function Tag({ level = "default", variant = "solid", children }: TagProps) {
	const colors = LEVEL_COLORS[level];

	return (
		<span
			style={{
				display: "inline-flex",
				alignItems: "center",
				gap: "0.25rem",
				padding: "0.125rem 0.5rem",
				borderRadius: 4,
				fontSize: "0.75rem",
				fontWeight: 500,
				fontFamily: "var(--font-sans)",
				backgroundColor: variant === "solid" ? colors.bg : "transparent",
				color: colors.text,
				border: `1px solid ${colors.border}`,
			}}
		>
			{children}
		</span>
	);
}
