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
	isFirst,
	isLast,
	onHover,
}: StackCardProps) {
	return (
		<div
			style={{
				position: "relative",
				borderRadius: isFirst ? "8px 8px 0 0" : isLast ? "0 0 8px 8px" : 0,
				borderBottom: isLast ? undefined : "1px solid rgba(255,255,255,0.06)",
				backgroundColor: "var(--color-surface-secondary)",
				transition: "background-color 0.15s ease",
			}}
		>
			<Link
				to={href}
				onMouseEnter={onHover}
				style={{
					position: "absolute",
					inset: 0,
					zIndex: 0,
					borderRadius: "inherit",
				}}
				aria-label={`Open stack ${orgName}/${projectName}/${stackName}`}
			/>
			<Row
				space="3"
				align="center"
				style={{
					padding: "1rem",
					position: "relative",
					zIndex: 1,
					pointerEvents: "none",
				}}
			>
				<Stack space="0.5" style={{ flex: 1, minWidth: 0 }}>
					<span
						style={{
							fontFamily: "var(--font-mono)",
							fontSize: "var(--text-mono-base)",
							color: "var(--color-mist)",
							fontWeight: 500,
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap",
						}}
					>
						{projectName}/{stackName}
					</span>
					<span style={{ fontSize: "0.75rem", color: "var(--color-cloud)" }}>
						{orgName}
						{resourceCount !== undefined && ` · ${String(resourceCount)} resources`}
					</span>
				</Stack>
				<Row space="2" align="center">
					{lastUpdateStatus && <StatusDot status={lastUpdateStatus} size={8} />}
					{lastUpdatedAt && (
						<span
							style={{
								fontSize: "0.75rem",
								color: "var(--color-cloud)",
								fontFamily: "var(--font-mono)",
							}}
						>
							{formatRelativeTime(lastUpdatedAt)}
						</span>
					)}
				</Row>
			</Row>
		</div>
	);
}
