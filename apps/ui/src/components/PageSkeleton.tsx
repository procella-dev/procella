/**
 * Generic content-area skeleton shown during lazy-loaded route transitions
 * inside the authenticated Layout. Mirrors the existing animate-pulse +
 * slate-brand card pattern used by StackList / Settings / Webhooks loading
 * states so the transition feels seamless when the real page mounts.
 */
export function PageSkeleton() {
	return (
		<div className="space-y-6" aria-busy="true" aria-live="polite">
			<div className="animate-pulse space-y-3">
				<div className="h-7 w-48 bg-slate-brand rounded-md" />
				<div className="h-4 w-72 bg-slate-brand/60 rounded-md" />
			</div>
			<div className="animate-pulse space-y-3">
				{[1, 2, 3, 4].map((i) => (
					<div key={i} className="h-[72px] bg-slate-brand rounded-xl border border-slate-brand" />
				))}
			</div>
		</div>
	);
}
