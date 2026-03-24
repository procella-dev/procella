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
			<div className="space-y-6">
				<div className="flex items-center justify-between">
					<h1 className="text-xl font-semibold text-mist">Stacks</h1>
				</div>
				<div className="animate-pulse space-y-3">
					{[1, 2, 3].map((i) => (
						<div key={i} className="h-[72px] bg-slate-brand rounded-xl border border-slate-brand" />
					))}
				</div>
			</div>
		);
	}

	if (error) {
		return (
			<div className="space-y-6">
				<h1 className="text-xl font-semibold text-mist">Stacks</h1>
				<div className="bg-red-950/30 border border-red-900/40 text-red-400 p-4 rounded-xl text-sm">
					{error}
				</div>
			</div>
		);
	}

	const items = stacks ?? [];

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<h1 className="text-xl font-semibold text-mist">Stacks</h1>
				{items.length > 0 && (
					<span className="text-xs text-cloud tabular-nums">
						{items.length} stack{items.length !== 1 ? "s" : ""}
					</span>
				)}
			</div>

			{items.length === 0 ? <EmptyState /> : <StackTable items={items} />}
		</div>
	);
}

function EmptyState() {
	return (
		<div className="space-y-6">
			{/* Getting started card */}
			<div className="bg-slate-brand/50 border border-slate-brand rounded-xl p-8">
				<div className="flex items-start gap-4">
					<div className="w-10 h-10 rounded-lg bg-lightning/10 border border-lightning/20 flex items-center justify-center shrink-0">
						<svg
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.5"
							className="w-5 h-5 text-lightning"
							aria-hidden="true"
						>
							<path
								strokeLinecap="round"
								strokeLinejoin="round"
								d="M15.59 14.37a6 6 0 01-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 006.16-12.12A14.98 14.98 0 009.631 8.41m5.96 5.96a14.926 14.926 0 01-5.841 2.58m-.119-8.54a6 6 0 00-7.381 5.84h4.8m2.581-5.84a14.927 14.927 0 00-2.58 5.84m2.699 2.7c-.103.021-.207.041-.311.06a15.09 15.09 0 01-2.448-2.448 14.9 14.9 0 01.06-.312m-2.24 2.39a4.493 4.493 0 00-1.757 4.306 4.493 4.493 0 004.306-1.758M16.5 9a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z"
							/>
						</svg>
					</div>
					<div>
						<h3 className="text-sm font-semibold text-mist mb-1.5">Get started with Procella</h3>
						<p className="text-sm text-cloud leading-relaxed mb-5">
							Connect the Pulumi CLI to this backend and create your first stack.
						</p>

						<div className="space-y-3">
							<CommandStep
								step="1"
								label="Login to this backend"
								command={`pulumi login ${window.location.origin}`}
							/>
							<CommandStep
								step="2"
								label="Create a stack"
								command="pulumi stack init myorg/myproject/dev"
							/>
							<CommandStep step="3" label="Deploy your infrastructure" command="pulumi up" />
						</div>
					</div>
				</div>
			</div>

			{/* Quick reference cards */}
			<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
				<QuickRefCard
					title="API Token Authentication"
					description="Use your API token to authenticate the CLI."
					code={`export PULUMI_ACCESS_TOKEN=<your-token>\npulumi login ${window.location.origin}`}
				/>
				<QuickRefCard
					title="Manage Stacks"
					description="Common stack operations after logging in."
					code="pulumi stack ls          # List all stacks\npulumi stack select dev  # Switch stack\npulumi stack rm dev      # Delete a stack"
				/>
			</div>
		</div>
	);
}

function CommandStep({ step, label, command }: { step: string; label: string; command: string }) {
	return (
		<div className="flex items-start gap-3">
			<span className="w-5 h-5 rounded-full bg-slate-brand border border-cloud/30 flex items-center justify-center text-[10px] font-semibold text-cloud shrink-0 mt-0.5">
				{step}
			</span>
			<div className="min-w-0 flex-1">
				<p className="text-xs text-cloud mb-1">{label}</p>
				<div className="bg-deep-sky border border-slate-brand rounded-lg px-3 py-2 font-mono text-xs text-mist/80 overflow-x-auto">
					<span className="text-emerald-400 mr-1.5 select-none">$</span>
					{command}
				</div>
			</div>
		</div>
	);
}

function QuickRefCard({
	title,
	description,
	code,
}: {
	title: string;
	description: string;
	code: string;
}) {
	return (
		<div className="bg-slate-brand/50 border border-slate-brand rounded-xl p-5">
			<h4 className="text-sm font-medium text-mist mb-1">{title}</h4>
			<p className="text-xs text-cloud mb-3">{description}</p>
			<pre className="bg-deep-sky border border-slate-brand rounded-lg px-3 py-2.5 font-mono text-xs text-cloud overflow-x-auto whitespace-pre leading-relaxed">
				{code}
			</pre>
		</div>
	);
}

interface StackItem {
	orgName: string;
	projectName: string;
	stackName: string;
	version: number;
	activeUpdate: string;
	currentOperation: string;
	tags: Record<string, string>;
}

function StackTable({ items }: { items: StackItem[] }) {
	return (
		<div className="bg-slate-brand/50 border border-slate-brand rounded-xl overflow-hidden">
			<table className="min-w-full divide-y divide-slate-brand">
				<thead>
					<tr className="bg-slate-brand">
						<th
							scope="col"
							className="px-5 py-3 text-left text-xs font-medium text-cloud uppercase tracking-wider"
						>
							Stack
						</th>
						<th
							scope="col"
							className="px-5 py-3 text-left text-xs font-medium text-cloud uppercase tracking-wider"
						>
							Version
						</th>
						<th
							scope="col"
							className="px-5 py-3 text-left text-xs font-medium text-cloud uppercase tracking-wider"
						>
							Status
						</th>
						<th
							scope="col"
							className="px-5 py-3 text-left text-xs font-medium text-cloud uppercase tracking-wider"
						>
							Tags
						</th>
					</tr>
				</thead>
				<tbody className="divide-y divide-slate-brand/60">
					{items.map((stack) => (
						<tr
							key={`${stack.orgName}/${stack.projectName}/${stack.stackName}`}
							className="hover:bg-slate-brand/30 transition-colors"
						>
							<td className="px-5 py-4 whitespace-nowrap">
								<Link
									to={`/stacks/${stack.orgName}/${stack.projectName}/${stack.stackName}`}
									className="text-lightning hover:text-lightning/80 font-medium text-sm transition-colors"
								>
									{stack.orgName}/{stack.projectName}/{stack.stackName}
								</Link>
							</td>
							<td className="px-5 py-4 whitespace-nowrap text-sm text-cloud tabular-nums">
								v{stack.version}
							</td>
							<td className="px-5 py-4 whitespace-nowrap">
								{stack.activeUpdate ? (
									<span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-950/40 text-amber-400 border border-amber-900/40">
										<span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
										{stack.currentOperation || "In Progress"}
									</span>
								) : (
									<span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-brand/60 text-cloud border border-cloud/20">
										Idle
									</span>
								)}
							</td>
							<td className="px-5 py-4 whitespace-nowrap text-sm text-cloud">
								<div className="flex gap-1.5">
									{Object.entries(stack.tags)
										.slice(0, 2)
										.map(([k, v]) => (
											<span
												key={k}
												className="px-2 py-0.5 bg-slate-brand/60 rounded text-xs border border-cloud/20 text-cloud"
											>
												{k}: {v}
											</span>
										))}
									{Object.keys(stack.tags).length > 2 && (
										<span className="px-2 py-0.5 bg-slate-brand/60 rounded text-xs border border-cloud/20 text-cloud">
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
	);
}
