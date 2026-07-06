import { Link } from "react-router";
import { Row, Stack } from "./layout";
import { StatusDot, type UpdateStatus } from "./status";

interface StackCardProps {
	orgName: string;
	projectName: string;
	stackName: string;
	href: string;
	lastUpdateStatus?: UpdateStatus;
	lastUpdatedAt?: string | null;
	resourceCount?: number;
	version?: number;
	description?: string;
	operation?: string;
	isFirst?: boolean;
	isLast?: boolean;
	onHover?: () => void;
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

export function StackCard({
	orgName,
	projectName,
	stackName,
	href,
	lastUpdateStatus,
	lastUpdatedAt,
	resourceCount,
	version,
	description,
	operation,
	isFirst,
	isLast,
	onHover,
}: StackCardProps) {
	return (
		<div
			className={`relative bg-surface-secondary transition-colors duration-150${isFirst ? " rounded-t-lg" : ""}${isLast ? " rounded-b-lg" : ""}`}
			style={!isLast ? { borderBottom: "1px solid rgba(255,255,255,0.06)" } : undefined}
		>
			<Link
				to={href}
				onMouseEnter={onHover}
				className="absolute inset-0 z-0 rounded-[inherit]"
				aria-label={`Open stack ${orgName}/${projectName}/${stackName}`}
			/>
			<Row space="3" align="center" className="p-4 relative z-[1] pointer-events-none">
				<Stack space="0.5" className="flex-1 min-w-0">
					<span className="font-mono text-mono-base text-mist font-medium overflow-hidden text-ellipsis whitespace-nowrap">
						{projectName}/{stackName}
					</span>
					<span className="text-xs text-cloud">
						{orgName}
						{resourceCount !== undefined && ` · ${String(resourceCount)} resources`}
					</span>
					{description && (
						<span className="text-xs text-[var(--color-cloud)]/70 truncate">{description}</span>
					)}
				</Stack>
				<Row space="2" align="center">
					{lastUpdateStatus && <StatusDot status={lastUpdateStatus} size={8} />}
					{lastUpdateStatus === "updating" && operation && (
						<span className="text-xs text-cloud">{operation}</span>
					)}
					{version !== undefined && version > 0 && (
						<span className="font-mono text-xs text-cloud">v{version}</span>
					)}
					{lastUpdatedAt && (
						<span className="text-xs text-cloud font-mono">
							{formatRelativeTime(lastUpdatedAt)}
						</span>
					)}
				</Row>
			</Row>
		</div>
	);
}
