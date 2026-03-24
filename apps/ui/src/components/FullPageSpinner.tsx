/**
 * Full-screen loading spinner used as a fallback during auth checks and lazy loading.
 */
export function FullPageSpinner() {
	return (
		<div className="min-h-screen bg-deep-sky flex items-center justify-center">
			<div className="h-8 w-8 animate-spin rounded-full border-2 border-cloud/30 border-t-lightning" />
		</div>
	);
}
