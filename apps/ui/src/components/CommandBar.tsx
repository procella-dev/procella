import { Command } from "cmdk";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { trpc } from "../trpc";

const OPEN_COMMAND_BAR_EVENT = "open-command-bar";

interface StackItem {
	orgName: string;
	projectName: string;
	stackName: string;
}

export function CommandBar() {
	const [open, setOpen] = useState(false);
	const navigate = useNavigate();

	const { data: stacks } = trpc.stacks.list.useQuery(undefined, {
		enabled: open,
	});

	useEffect(() => {
		const handleOpen = () => setOpen(true);
		const handleKeyDown = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
				event.preventDefault();
				setOpen((previous) => !previous);
				return;
			}

			if (event.key === "Escape") {
				setOpen(false);
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		document.addEventListener(OPEN_COMMAND_BAR_EVENT, handleOpen);

		return () => {
			document.removeEventListener("keydown", handleKeyDown);
			document.removeEventListener(OPEN_COMMAND_BAR_EVENT, handleOpen);
		};
	}, []);

	if (!open) return null;

	const stackItems = (stacks ?? []) as StackItem[];

	return (
		<div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]">
			<button
				type="button"
				aria-label="Close command bar"
				className="absolute inset-0 bg-deep-sky/50"
				onClick={() => setOpen(false)}
			/>
			<div className="relative w-full max-w-lg overflow-hidden rounded-xl border border-slate-brand bg-surface-popup shadow-drop-medium backdrop-blur-sm">
				<Command shouldFilter={true}>
					<Command.Input
						autoFocus
						placeholder="Search or jump to..."
						className="w-full border-b border-slate-brand bg-transparent px-4 py-3 font-sans text-sm text-mist placeholder-cloud outline-none"
					/>
					<Command.List className="max-h-80 overflow-y-auto p-2">
						<Command.Empty className="py-6 text-center text-sm text-cloud">
							No results found.
						</Command.Empty>

						<Command.Group
							heading="Navigate"
							className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-cloud"
						>
							<CommandItem
								onSelect={() => {
									navigate("/");
									setOpen(false);
								}}
								label="All Stacks"
								shortcut="G S"
							/>
							<CommandItem
								onSelect={() => {
									navigate("/tokens");
									setOpen(false);
								}}
								label="API Tokens"
								shortcut="G T"
							/>
							<CommandItem
								onSelect={() => {
									navigate("/settings");
									setOpen(false);
								}}
								label="Settings"
								shortcut="G ,"
							/>
						</Command.Group>

						{stackItems.length > 0 && (
							<Command.Group
								heading="Stacks"
								className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-cloud"
							>
								{stackItems.map((stack) => (
									<CommandItem
										key={`${stack.orgName}/${stack.projectName}/${stack.stackName}`}
										onSelect={() => {
											navigate(`/stacks/${stack.orgName}/${stack.projectName}/${stack.stackName}`);
											setOpen(false);
										}}
										label={`${stack.projectName} / ${stack.stackName}`}
										sublabel={stack.orgName}
									/>
								))}
							</Command.Group>
						)}
					</Command.List>
				</Command>
			</div>
		</div>
	);
}

function CommandItem({
	onSelect,
	label,
	sublabel,
	shortcut,
}: {
	onSelect: () => void;
	label: string;
	sublabel?: string;
	shortcut?: string;
}) {
	return (
		<Command.Item
			onSelect={onSelect}
			className="flex cursor-pointer items-center justify-between rounded-lg px-3 py-2 text-sm text-mist data-[selected=true]:bg-slate-brand"
		>
			<span className="flex flex-col">
				<span>{label}</span>
				{sublabel && <span className="text-xs text-cloud">{sublabel}</span>}
			</span>
			{shortcut && (
				<span className="flex gap-1">
					{shortcut.split(" ").map((key) => (
						<kbd
							key={key}
							className="rounded border border-cloud/30 bg-slate-brand px-1.5 py-0.5 font-mono text-xs text-cloud"
						>
							{key}
						</kbd>
					))}
				</span>
			)}
		</Command.Item>
	);
}

export function openCommandBar() {
	document.dispatchEvent(new CustomEvent(OPEN_COMMAND_BAR_EVENT));
}
