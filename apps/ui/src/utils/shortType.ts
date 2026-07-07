/** Shorten a resource type for display (e.g., "aws:s3/bucket:Bucket" → "s3/bucket:Bucket"). */
export function shortType(type: string) {
	const colonIdx = type.indexOf(":");
	if (colonIdx === -1) return type;
	return type.slice(colonIdx + 1);
}
