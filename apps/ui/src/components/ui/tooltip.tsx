import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

interface TooltipProps {
	content: ReactNode;
	children: ReactNode;
	side?: "top" | "right" | "bottom" | "left";
	delayDuration?: number;
}

export function Tooltip({ content, children, side = "top", delayDuration = 300 }: TooltipProps) {
	return (
		<TooltipPrimitive.Provider delayDuration={delayDuration}>
			<TooltipPrimitive.Root>
				<TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
				<TooltipPrimitive.Portal>
					<TooltipPrimitive.Content
						side={side}
						sideOffset={4}
						style={{
							backgroundColor: "var(--color-surface-secondary)",
							color: "var(--color-mist)",
							fontSize: "0.75rem",
							fontFamily: "var(--font-sans)",
							padding: "0.25rem 0.5rem",
							borderRadius: 4,
							border: "1px solid rgba(255,255,255,0.08)",
							boxShadow: "var(--shadow-drop-short)",
							zIndex: 100,
						}}
					>
						{content}
						<TooltipPrimitive.Arrow style={{ fill: "var(--color-surface-secondary)" }} />
					</TooltipPrimitive.Content>
				</TooltipPrimitive.Portal>
			</TooltipPrimitive.Root>
		</TooltipPrimitive.Provider>
	);
}
