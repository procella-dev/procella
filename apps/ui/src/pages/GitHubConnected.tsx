// Landing route for the Descope outbound callback.
//
// Descope finishes the GitHub OAuth exchange server-side and returns the
// browser here with the signed connect transaction Procella minted before the
// flow started. The page carries no authority: it hands that reference back to
// the server, which verifies it against the HttpOnly browser nonce and the
// caller's tenant and user before issuing the installation URL. A forwarded
// callback link therefore cannot continue in anyone else's browser.

import { useEffect, useRef, useState } from "react";
import { FullPageSpinner } from "../components/FullPageSpinner";
import { trpc } from "../trpc";

export function GitHubConnected() {
	const createUrlMutation = trpc.github.createInstallationUrl.useMutation();
	const started = useRef(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (started.current) return;
		started.current = true;

		const state = new URLSearchParams(window.location.search).get("state");
		if (!state) {
			window.location.replace("/settings?github=error&reason=invalid_state#github");
			return;
		}

		createUrlMutation
			.mutateAsync({ state })
			.then(({ url }) => {
				window.location.assign(url);
			})
			.catch((mutationError: unknown) => {
				setError(
					mutationError instanceof Error
						? mutationError.message
						: "Unable to continue GitHub installation",
				);
			});
	}, [createUrlMutation]);

	if (error) {
		return (
			<div className="max-w-xl mx-auto mt-16 space-y-4">
				<div className="bg-danger/10 border border-danger/30 text-danger/80 p-4 rounded-xl text-sm">
					{error}
				</div>
				<a href="/settings#github" className="btn-primary inline-block">
					Back to GitHub settings
				</a>
			</div>
		);
	}

	return <FullPageSpinner />;
}
