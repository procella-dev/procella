/**
 * Full-screen loading spinner used as a fallback during auth checks and lazy loading.
 */
export function FullPageSpinner() {
	return (
		<div className="min-h-screen bg-zinc-950 flex items-center justify-center">
			<div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-blue-500" />
		</div>
	);
}
