import { Link } from "react-router";
import { trpc } from "../trpc";

export function StackList() {
	const {
		data: stacks,
		isLoading: loading,
		error: queryError,
	} = trpc.stacks.list.useQuery(undefined, { refetchInterval: 5000 });
	const error = queryError?.message ?? null;

	if (loading) {
		return (
			<div className="space-y-4">
				<h1 className="text-2xl font-bold text-zinc-100">Stacks</h1>
				<div className="animate-pulse space-y-4">
					{[1, 2, 3].map((i) => (
						<div key={i} className="h-16 bg-zinc-800 rounded-lg border border-zinc-700" />
					))}
				</div>
			</div>
		);
	}

	if (error) {
		return (
			<div className="space-y-4">
				<h1 className="text-2xl font-bold text-zinc-100">Stacks</h1>
				<div className="bg-red-900/20 border border-red-900/50 text-red-400 p-4 rounded-lg">
					{error}
				</div>
			</div>
		);
	}

	const items = stacks ?? [];

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<h1 className="text-2xl font-bold text-zinc-100">Stacks</h1>
			</div>

			{items.length === 0 ? (
				<div className="bg-zinc-800/50 border border-zinc-700/50 rounded-lg p-12 text-center">
					<h3 className="text-lg font-medium text-zinc-300 mb-2">No stacks found</h3>
					<p className="text-zinc-500">
						Use <code className="bg-zinc-900 px-1.5 py-0.5 rounded text-sm">pulumi stack init</code>{" "}
						to create one.
					</p>
				</div>
			) : (
				<div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
					<table className="min-w-full divide-y divide-zinc-800">
						<thead className="bg-zinc-950">
							<tr>
								<th
									scope="col"
									className="px-6 py-3 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider"
								>
									Stack
								</th>
								<th
									scope="col"
									className="px-6 py-3 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider"
								>
									Version
								</th>
								<th
									scope="col"
									className="px-6 py-3 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider"
								>
									Status
								</th>
								<th
									scope="col"
									className="px-6 py-3 text-left text-xs font-medium text-zinc-400 uppercase tracking-wider"
								>
									Tags
								</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-zinc-800 bg-zinc-900">
							{items.map((stack) => (
								<tr
									key={`${stack.orgName}/${stack.projectName}/${stack.stackName}`}
									className="hover:bg-zinc-800/50 transition-colors"
								>
									<td className="px-6 py-4 whitespace-nowrap">
										<Link
											to={`/stacks/${stack.orgName}/${stack.projectName}/${stack.stackName}`}
											className="text-blue-400 hover:text-blue-300 font-medium"
										>
											{stack.orgName}/{stack.projectName}/{stack.stackName}
										</Link>
									</td>
									<td className="px-6 py-4 whitespace-nowrap text-sm text-zinc-300">
										v{stack.version}
									</td>
									<td className="px-6 py-4 whitespace-nowrap">
										{stack.activeUpdate ? (
											<span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-900/30 text-yellow-400 border border-yellow-900/50">
												{stack.currentOperation || "In Progress"}
											</span>
										) : (
											<span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-zinc-800 text-zinc-400 border border-zinc-700">
												Idle
											</span>
										)}
									</td>
									<td className="px-6 py-4 whitespace-nowrap text-sm text-zinc-500">
										<div className="flex gap-2">
											{Object.entries(stack.tags)
												.slice(0, 2)
												.map(([k, v]) => (
													<span
														key={k}
														className="px-2 py-0.5 bg-zinc-800 rounded text-xs border border-zinc-700"
													>
														{k}: {v}
													</span>
												))}
											{Object.keys(stack.tags).length > 2 && (
												<span className="px-2 py-0.5 bg-zinc-800 rounded text-xs border border-zinc-700">
													+{Object.keys(stack.tags).length - 2} more
												</span>
											)}
										</div>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}
