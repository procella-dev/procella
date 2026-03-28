import type { CSSProperties } from "react";

interface SkeletonProps {
	className?: string;
	style?: CSSProperties;
	width?: string | number;
	height?: string | number;
	borderRadius?: string | number;
}

export function Skeleton({ className, style, width, height, borderRadius = 4 }: SkeletonProps) {
	return (
		<div
			className={className}
			style={{
				width,
				height,
				borderRadius,
				backgroundColor: "rgba(255,255,255,0.06)",
				animation: "skeleton-shimmer 1.4s ease-in-out infinite",
				...style,
			}}
		/>
	);
}

export function UpdateCardSkeleton() {
	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				gap: "0.75rem",
				padding: "0.875rem 1rem",
				borderBottom: "1px solid rgba(255,255,255,0.06)",
			}}
		>
			<Skeleton width={10} height={10} borderRadius="50%" style={{ flexShrink: 0 }} />
			<div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "0.375rem" }}>
				<Skeleton width="40%" height={13} />
				<Skeleton width="25%" height={11} />
			</div>
			<Skeleton width={60} height={12} />
		</div>
	);
}

export function StackCardSkeleton() {
	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				gap: "0.75rem",
				padding: "1rem",
				borderBottom: "1px solid rgba(255,255,255,0.06)",
			}}
		>
			<div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "0.375rem" }}>
				<Skeleton width="35%" height={14} />
				<Skeleton width="20%" height={11} />
			</div>
			<div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
				<Skeleton width={10} height={10} borderRadius="50%" />
				<Skeleton width={50} height={11} />
			</div>
		</div>
	);
}
