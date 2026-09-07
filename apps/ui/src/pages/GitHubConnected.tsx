// Landing route for the Descope outbound callback.
//
// Descope finishes the GitHub OAuth exchange server-side and returns the
// browser here. The GitHub user token stays vaulted; this page only asks the
// server for the signed installation URL for the remembered account and hands
// the browser to GitHub.

import { useEffect, useRef, useState } from "react";
import { FullPageSpinner } from "../components/FullPageSpinner";
import { clearGitHubConnectAccount, readGitHubConnectAccount } from "../github-connect";
import { trpc } from "../trpc";

export function GitHubConnected() {
	const createUrlMutation = trpc.github.createInstallationUrl.useMutation();
	const started = useRef(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (started.current) return;
		started.current = true;

		const accountLogin = readGitHubConnectAccount();
		if (!accountLogin) {
			window.location.replace("/settings?github=error&reason=missing_account#github");
			return;
		}

		createUrlMutation
			.mutateAsync({ accountLogin })
			.then(({ url }) => {
				clearGitHubConnectAccount();
				window.location.assign(url);
			})
			.catch((mutationError: unknown) => {
				clearGitHubConnectAccount();
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
