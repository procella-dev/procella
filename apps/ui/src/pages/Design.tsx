import type { ReactNode } from "react";
import { Row, Stack } from "../components/ui/layout";
import { StatusBadge, StatusDot, type UpdateStatus } from "../components/ui/status";

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<Stack space="4">
			<h2
				style={{
					fontSize: "0.75rem",
					fontFamily: "var(--font-mono)",
					color: "var(--color-cloud)",
					textTransform: "uppercase",
					letterSpacing: "0.08em",
					margin: 0,
				}}
			>
				{title}
			</h2>
			{children}
		</Stack>
	);
}

function ComponentCard({ name, children }: { name: string; children: ReactNode }) {
	return (
		<Stack
			space="3"
			style={{
				background: "var(--color-surface-secondary)",
				borderRadius: 8,
				padding: "1rem",
				border: "1px solid rgba(255,255,255,0.06)",
			}}
		>
			<span
				style={{ fontSize: "0.75rem", color: "var(--color-cloud)", fontFamily: "var(--font-mono)" }}
			>
				{name}
			</span>
			{children}
		</Stack>
	);
}

const statuses: UpdateStatus[] = [
	"succeeded",
	"failed",
	"updating",
	"running",
	"cancelled",
	"queued",
	"not-started",
];

export function Design() {
	return (
		<Stack space="10" style={{ padding: "2rem", maxWidth: 880, margin: "0 auto" }}>
			<Stack space="2">
				<h1 style={{ fontSize: "1.5rem", fontWeight: 600, color: "var(--color-mist)", margin: 0 }}>
					Design System
				</h1>
				<p style={{ color: "var(--color-cloud)", margin: 0, fontSize: "0.875rem" }}>
					Component library for Procella
				</p>
			</Stack>

			<Section title="Status Indicators">
				<ComponentCard name="StatusDot — all states">
					<Row space="4" align="center" style={{ flexWrap: "wrap" }}>
						{statuses.map((status) => (
							<Stack key={status} space="2" align="center">
								<StatusDot status={status} />
								<span style={{ fontSize: "0.6875rem", color: "var(--color-cloud)" }}>{status}</span>
							</Stack>
						))}
					</Row>
				</ComponentCard>

				<ComponentCard name="StatusBadge — all states">
					<Stack space="2">
						{statuses.map((status) => (
							<StatusBadge key={status} status={status} />
						))}
					</Stack>
				</ComponentCard>
			</Section>

			<Section title="Layout Primitives">
				<ComponentCard name="Stack — vertical flex with gap">
					<Stack
						space="2"
						style={{ background: "rgba(255,255,255,0.04)", padding: "0.5rem", borderRadius: 4 }}
					>
						<div
							style={{
								background: "var(--color-lightning)",
								height: 24,
								borderRadius: 3,
								opacity: 0.3,
							}}
						/>
						<div
							style={{
								background: "var(--color-lightning)",
								height: 24,
								borderRadius: 3,
								opacity: 0.3,
							}}
						/>
						<div
							style={{
								background: "var(--color-lightning)",
								height: 24,
								borderRadius: 3,
								opacity: 0.3,
							}}
						/>
					</Stack>
				</ComponentCard>

				<ComponentCard name="Row — horizontal flex with gap">
					<Row
						space="2"
						style={{ background: "rgba(255,255,255,0.04)", padding: "0.5rem", borderRadius: 4 }}
					>
						<div
							style={{
								background: "var(--color-lightning)",
								height: 24,
								width: 60,
								borderRadius: 3,
								opacity: 0.3,
								flexShrink: 0,
							}}
						/>
						<div
							style={{
								background: "var(--color-lightning)",
								height: 24,
								width: 100,
								borderRadius: 3,
								opacity: 0.3,
								flexShrink: 0,
							}}
						/>
						<div
							style={{
								background: "var(--color-lightning)",
								height: 24,
								flexGrow: 1,
								borderRadius: 3,
								opacity: 0.3,
							}}
						/>
					</Row>
				</ComponentCard>
			</Section>

			<Section title="Color Tokens">
				<ComponentCard name="Status colors">
					<Row space="3" align="center">
						{[
							{ name: "status-success", value: "var(--color-status-success)" },
							{ name: "status-error", value: "var(--color-status-error)" },
							{ name: "status-active", value: "var(--color-status-active)" },
							{ name: "status-idle", value: "var(--color-status-idle)" },
						].map(({ name, value }) => (
							<Stack key={name} space="1" align="center">
								<div style={{ width: 32, height: 32, borderRadius: 6, background: value }} />
								<span
									style={{
										fontSize: "0.625rem",
										color: "var(--color-cloud)",
										fontFamily: "var(--font-mono)",
									}}
								>
									{name}
								</span>
							</Stack>
						))}
					</Row>
				</ComponentCard>

				<ComponentCard name="Brand palette">
					<Row space="3" align="center" style={{ flexWrap: "wrap" }}>
						{[
							{ name: "deep-sky", value: "var(--color-deep-sky)" },
							{ name: "lightning", value: "var(--color-lightning)" },
							{ name: "flash", value: "var(--color-flash)" },
							{ name: "slate-brand", value: "var(--color-slate-brand)" },
							{ name: "cloud", value: "var(--color-cloud)" },
							{ name: "mist", value: "var(--color-mist)" },
						].map(({ name, value }) => (
							<Stack key={name} space="1" align="center">
								<div
									style={{
										width: 32,
										height: 32,
										borderRadius: 6,
										background: value,
										border: "1px solid rgba(255,255,255,0.1)",
									}}
								/>
								<span
									style={{
										fontSize: "0.625rem",
										color: "var(--color-cloud)",
										fontFamily: "var(--font-mono)",
									}}
								>
									{name}
								</span>
							</Stack>
						))}
					</Row>
				</ComponentCard>
			</Section>

			<Section title="Typography">
				<ComponentCard name="Font scale">
					<Stack space="2">
						<span
							style={{
								fontFamily: "var(--font-mono)",
								fontSize: "var(--text-mono-lg)",
								color: "var(--color-mist)",
							}}
						>
							mono-lg — Resource names, stack titles
						</span>
						<span
							style={{
								fontFamily: "var(--font-mono)",
								fontSize: "var(--text-mono-base)",
								color: "var(--color-mist)",
							}}
						>
							mono-base — Command types, URNs
						</span>
						<span
							style={{
								fontFamily: "var(--font-mono)",
								fontSize: "var(--text-mono-sm)",
								color: "var(--color-mist)",
							}}
						>
							mono-sm — Event log entries
						</span>
						<span
							style={{
								fontFamily: "var(--font-mono)",
								fontSize: "var(--text-mono-xs)",
								color: "var(--color-cloud)",
							}}
						>
							mono-xs — Labels, timestamps
						</span>
					</Stack>
				</ComponentCard>
			</Section>
		</Stack>
	);
}
