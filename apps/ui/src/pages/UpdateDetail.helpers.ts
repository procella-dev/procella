import type { UpdateStatus } from "../components/ui/status";

export interface EngineEvent {
	sequence: number;
	timestamp: number;
	summaryEvent?: { resourceChanges: Record<string, number> };
	diagnosticEvent?: { severity: string; message: string; urn?: string };
	resourcePreEvent?: { metadata: { type: string; urn: string; op: string } };
	resOutputsEvent?: { metadata: { type: string; urn: string; op: string } };
	cancelEvent?: Record<string, unknown>;
}

export function eventTimestampMs(event: EngineEvent): number {
	return event.timestamp > 1_000_000_000_000 ? event.timestamp : event.timestamp * 1000;
}

export function formatDuration(ms?: number): string {
	if (ms == null || Number.isNaN(ms)) return "";
	if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
	const totalMins = Math.floor(seconds / 60);
	const totalHours = Math.floor(totalMins / 60);
	const totalDays = Math.floor(totalHours / 24);
	if (totalDays >= 1) {
		return `${totalDays}d ${totalHours % 24}h`;
	}
	if (totalHours >= 1) {
		return `${totalHours}h ${totalMins % 60}m`;
	}
	const rem = Math.floor(seconds % 60);
	return `${totalMins}m ${rem}s`;
}

export function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const totalMins = Math.floor(totalSeconds / 60);
	const totalHours = Math.floor(totalMins / 60);
	const totalDays = Math.floor(totalHours / 24);
	if (totalDays >= 1) {
		return `${totalDays}d ${totalHours % 24}h elapsed`;
	}
	if (totalHours >= 1) {
		return `${totalHours}h ${totalMins % 60}m elapsed`;
	}
	const secs = totalSeconds % 60;
	return `${totalMins}m ${secs.toString().padStart(2, "0")}s elapsed`;
}

export function formatRelative(ms: number, startMs: number): string {
	const diff = Math.max(0, Math.floor((ms - startMs) / 1000));
	const mins = Math.floor(diff / 60);
	const secs = diff % 60;
	return `+${mins}:${secs.toString().padStart(2, "0")}`;
}

export function mapUpdateStatus(result?: string, hasEvents?: boolean): UpdateStatus {
	if (result === "succeeded") return "succeeded";
	if (result === "failed") return "failed";
	if (result === "cancelled") return "cancelled";
	if (result === "queued") return "queued";
	if (result === "not-started") return "not-started";
	if (result === "running") return "running";
	if (result === "updating" || result === "in-progress") return "updating";
	return hasEvents ? "updating" : "not-started";
}
