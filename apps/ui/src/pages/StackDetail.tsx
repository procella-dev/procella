import { Link, useParams } from "react-router";
import { trpc } from "../trpc";

export function StackDetail() {
	const { org, project, stack } = useParams<{ org: string; project: string; stack: string }>();
	const {
		data: updates,
		isLoading: loading,
		error: queryError,
	} = trpc.updates.list.useQuery(
		{ org: org ?? "", project: project ?? "", stack: stack ?? "" },
		{ enabled: Boolean(org && project && stack) },
	);
	const error = queryError?.message ?? null;

	const getResultColor = (result: string) => {
		switch (result) {
			case "succeeded":
				return "bg-green-900/30 text-green-400 border-green-900/50";
			case "failed":
				return "bg-red-900/30 text-red-400 border-red-900/50";
			case "in-progress":
				return "bg-yellow-900/30 text-yellow-400 border-yellow-900/50";
			default:
				return "bg-zinc-800 text-zinc-400 border-zinc-700";
		}
	};

	const getKindColor = (kind: string) => {
		switch (kind) {
			case "update":
				return "bg-blue-900/30 text-blue-400 border-blue-900/50";
			case "preview":
				return "bg-purple-900/30 text-purple-400 border-purple-900/50";
			case "destroy":
				return "bg-red-900/30 text-red-400 border-red-900/50";
			case "refresh":
				return "bg-teal-900/30 text-teal-400 border-teal-900/50";
			default:
				return "bg-zinc-800 text-zinc-400 border-zinc-700";
		}
	};

	const formatDuration = (start: number, end: number) => {
		if (!start || !end) return "-";
		const seconds = end - start;
		if (seconds < 60) return `${String(seconds)}s`;
		const mins = Math.floor(seconds / 60);
		const secs = seconds % 60;
		return `${String(mins)}m ${String(secs)}s`;
	};

	const formatDate = (timestamp: number) => {
		if (!timestamp) return "-";
		return new Date(timestamp * 1000).toLocaleString();
	};

	if (loading) {
		return (
			<div className="space-y-6">
				<div className="flex items-center gap-4">
					<Link to="/" className="text-zinc-400 hover:text-zinc-200">
						&larr; Back
					</Link>
					<h1 className="text-2xl font-bold text-zinc-100">Loading...</h1>
				</div>
				<div className="animate-pulse space-y-4">
					{[1, 2, 3].map((i) => (
						<div key={i} className="h-24 bg-zinc-800 rounded-lg border border-zinc-700" />
					))}
				</div>
			</div>
		);
	}

	if (error) {
		return (
			<div className="space-y-6">
				<div className="flex items-center gap-4">
					<Link to="/" className="text-zinc-400 hover:text-zinc-200">
						&larr; Back
					</Link>
					<h1 className="text-2xl font-bold text-zinc-100">
						{org}/{project}/{stack}
					</h1>
				</div>
				<div className="bg-red-900/20 border border-red-900/50 text-red-400 p-4 rounded-lg">
					{error}
				</div>
			</div>
		);
	}

	const items = updates ?? [];

	return (
		<div className="space-y-6">
			<div className="flex items-center gap-4">
				<Link to="/" className="text-zinc-400 hover:text-zinc-200 transition-colors">
					&larr; Back
				</Link>
				<h1 className="text-2xl font-bold text-zinc-100">
					<span className="text-zinc-500 font-normal">
						{org} / {project} /{" "}
					</span>
					{stack}
				</h1>
			</div>

			{items.length === 0 ? (
				<div className="bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-12 text-center">
					<h3 className="text-lg font-medium text-zinc-300 mb-2">No updates found</h3>
					<p className="text-zinc-500">
						Run <code className="bg-zinc-900 px-1.5 py-0.5 rounded text-sm">pulumi up</code> to
						create an update.
					</p>
				</div>
			) : (
				<div className="space-y-4">
					{items.map((update) => (
						<Link
							key={update.updateID}
							to={`/stacks/${org}/${project}/${stack}/updates/${update.updateID}`}
							className="block bg-zinc-900 border border-zinc-800 rounded-lg p-5 hover:border-zinc-600 transition-colors"
						>
							<div className="flex items-start justify-between mb-3">
								<div className="flex items-center gap-3">
									<span
										className={`px-2.5 py-0.5 rounded-full text-xs font-medium border ${getKindColor(update.kind)}`}
									>
										{update.kind}
									</span>
									<span
										className={`px-2.5 py-0.5 rounded-full text-xs font-medium border ${getResultColor(update.result)}`}
									>
										{update.result}
									</span>
									<span className="text-sm text-zinc-400">v{update.version}</span>
								</div>
								<div className="text-sm text-zinc-500 text-right">
									<div>{formatDate(update.startTime)}</div>
									<div>{formatDuration(update.startTime, update.endTime)}</div>
								</div>
							</div>

							<div className="text-zinc-300 text-sm mb-3">
								{update.message || "No message provided"}
							</div>

							{update.resourceChanges && Object.keys(update.resourceChanges).length > 0 && (
								<div className="flex gap-3 text-xs">
									{Object.entries(update.resourceChanges).map(([op, count]) => (
										<span key={op} className="text-zinc-400">
											<span className="font-medium text-zinc-300">{count}</span> {op}
										</span>
									))}
								</div>
							)}
						</Link>
					))}
				</div>
			)}
		</div>
	);
}
