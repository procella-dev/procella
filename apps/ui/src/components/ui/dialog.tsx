import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { ReactNode } from "react";

interface DialogProps {
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	trigger?: ReactNode;
	title: string;
	children: ReactNode;
}

export function Dialog({ open, onOpenChange, trigger, title, children }: DialogProps) {
	return (
		<DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
			{trigger && <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>}
			<DialogPrimitive.Portal>
				<DialogPrimitive.Overlay
					style={{
						position: "fixed",
						inset: 0,
						backgroundColor: "rgba(0, 0, 0, 0.6)",
						zIndex: 50,
					}}
				/>
				<DialogPrimitive.Content
					style={{
						position: "fixed",
						top: "50%",
						left: "50%",
						transform: "translate(-50%, -50%)",
						width: "90vw",
						maxWidth: 480,
						backgroundColor: "var(--color-surface-secondary)",
						border: "1px solid rgba(255,255,255,0.08)",
						borderRadius: 12,
						padding: "1.5rem",
						boxShadow: "var(--shadow-drop-medium)",
						zIndex: 51,
					}}
				>
					<DialogPrimitive.Title
						style={{
							fontSize: "1rem",
							fontWeight: 600,
							color: "var(--color-mist)",
							marginBottom: "1rem",
						}}
					>
						{title}
					</DialogPrimitive.Title>
					{children}
				</DialogPrimitive.Content>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	);
}

export const DialogClose = DialogPrimitive.Close;
