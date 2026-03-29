import type { ReactNode } from "react";
import { Stack } from "./layout";

interface EmptyStateProps {
	icon?: ReactNode;
	title: string;
	description?: string;
	action?: ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
	return (
		<Stack
			space="4"
			align="center"
			style={{
				padding: "4rem 2rem",
				textAlign: "center",
			}}
		>
			{icon && (
				<span
					style={{
						fontSize: "2rem",
						opacity: 0.4,
						display: "block",
					}}
				>
					{icon}
				</span>
			)}
			<Stack space="1" align="center">
				<p
					style={{
						margin: 0,
						fontSize: "0.9375rem",
						fontWeight: 500,
						color: "var(--color-mist)",
					}}
				>
					{title}
				</p>
				{description && (
					<p
						style={{
							margin: 0,
							fontSize: "0.875rem",
							color: "var(--color-cloud)",
						}}
					>
						{description}
					</p>
				)}
			</Stack>
			{action}
		</Stack>
	);
}
