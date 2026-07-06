import type { UpdateStatus } from "../components/ui/status";

export function getResultColor(result: string) {
	switch (result) {
		case "succeeded":
			return "bg-success/10 text-success border-success/30";
		case "failed":
			return "bg-danger/10 text-danger/80 border-danger/30";
		case "in-progress":
			return "bg-status-active/10 text-status-active border-status-active/30";
		case "cancelled":
			return "bg-slate-brand text-cloud border-cloud/30";
		default:
			return "bg-slate-brand text-cloud border-cloud/30";
	}
}

export function formatRelativeTime(timestamp: number) {
	if (!timestamp) return "-";
	const now = Math.floor(Date.now() / 1000);
	const diff = now - timestamp;
	if (diff < 60) return "just now";
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
	if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
	if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
	return new Date(timestamp * 1000).toLocaleDateString();
}

export function toUpdateStatus(result: string): UpdateStatus {
	switch (result) {
		case "succeeded":
			return "succeeded";
		case "failed":
			return "failed";
		case "cancelled":
			return "cancelled";
		case "in-progress":
			return "updating";
		default:
			return "queued";
	}
}

export function toIsoOrNull(timestamp?: number | null): string | null {
	if (!timestamp) return null;
	return new Date(timestamp * 1000).toISOString();
}

export function toChangeSummary(resourceChanges: Record<string, number>) {
	return {
		creates: resourceChanges.create ?? 0,
		updates: resourceChanges.update ?? 0,
		deletes: resourceChanges.delete ?? 0,
	};
}

/** Truncate a string in the middle for display. */
export function truncateMiddle(str: string, maxLen: number) {
	if (str.length <= maxLen) return str;
	const half = Math.floor((maxLen - 3) / 2);
	return `${str.slice(0, half)}…${str.slice(-half)}`;
}

/** Shorten a resource type for display (e.g., "aws:s3/bucket:Bucket" → "s3/bucket:Bucket"). */
export function shortType(type: string) {
	const colonIdx = type.indexOf(":");
	if (colonIdx === -1) return type;
	return type.slice(colonIdx + 1);
}
