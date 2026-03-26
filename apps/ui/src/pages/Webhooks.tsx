import { useCallback, useEffect, useState } from "react";

import { trpc } from "../trpc";

const WEBHOOK_EVENTS = [
	"stack.created",
	"stack.deleted",
	"stack.updated",
	"update.started",
	"update.succeeded",
	"update.failed",
	"update.cancelled",
] as const;

export function Webhooks() {
	const [selectedWebhookId, setSelectedWebhookId] = useState<string | null>(null);
	const [showCreateModal, setShowCreateModal] = useState(false);

	const {
		data: webhooks,
		isLoading,
		error: queryError,
		refetch: refetchList,
	} = trpc.webhooks.list.useQuery(undefined, { refetchInterval: 10000 });
	const error = queryError?.message ?? null;

	if (isLoading) {
		return (
			<div className="space-y-6">
				<div className="flex items-center justify-between">
					<h1 className="text-xl font-semibold text-zinc-100">Webhooks</h1>
				</div>
				<div className="animate-pulse space-y-3">
					{[1, 2, 3].map((i) => (
						<div key={i} className="h-[72px] bg-zinc-900 rounded-xl border border-zinc-800" />
					))}
				</div>
			</div>
		);
	}

	if (error) {
		return (
			<div className="space-y-6">
				<h1 className="text-xl font-semibold text-zinc-100">Webhooks</h1>
				<div className="bg-red-950/30 border border-red-900/40 text-red-400 p-4 rounded-xl text-sm">
					{error}
				</div>
			</div>
		);
	}

	if (selectedWebhookId) {
		return (
			<WebhookDetail
				webhookId={selectedWebhookId}
				onBack={() => setSelectedWebhookId(null)}
				onDeleted={() => {
					setSelectedWebhookId(null);
					refetchList();
				}}
			/>
		);
	}

	const items = webhooks ?? [];

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<h1 className="text-xl font-semibold text-zinc-100">Webhooks</h1>
				<button
					type="button"
					onClick={() => setShowCreateModal(true)}
					className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
				>
					Create Webhook
				</button>
			</div>

			{items.length === 0 ? (
				<WebhookEmptyState onCreate={() => setShowCreateModal(true)} />
			) : (
				<WebhookTable items={items} onSelect={(id) => setSelectedWebhookId(id)} />
			)}

			{showCreateModal && (
				<WebhookModal
					webhookId={null}
					onClose={() => {
						setShowCreateModal(false);
					}}
					onSaved={() => {
						setShowCreateModal(false);
						refetchList();
					}}
				/>
			)}
		</div>
	);
}

function WebhookEmptyState({ onCreate }: { onCreate: () => void }) {
	return (
		<div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-12 text-center">
			<svg
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				className="w-10 h-10 text-zinc-600 mx-auto mb-3"
				aria-hidden="true"
			>
				<path
					strokeLinecap="round"
					strokeLinejoin="round"
					d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0"
				/>
			</svg>
			<p className="text-zinc-400 text-sm font-medium mb-1">No webhooks configured</p>
			<p className="text-zinc-500 text-xs mb-4">
				Create a webhook to receive notifications about stack and update events.
			</p>
			<button
				type="button"
				onClick={onCreate}
				className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
			>
				Create Webhook
			</button>
		</div>
	);
}

interface WebhookListItem {
	id: string;
	name: string;
	url: string;
	events: string[];
	active: boolean;
	createdAt: Date;
}

function WebhookTable({
	items,
	onSelect,
}: {
	items: WebhookListItem[];
	onSelect: (id: string) => void;
}) {
	return (
		<div className="bg-zinc-900/50 border border-zinc-800 rounded-xl overflow-hidden">
			<table className="min-w-full divide-y divide-zinc-800">
				<thead>
					<tr className="bg-zinc-900">
						<th
							scope="col"
							className="px-5 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wider"
						>
							Name
						</th>
						<th
							scope="col"
							className="px-5 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wider"
						>
							URL
						</th>
						<th
							scope="col"
							className="px-5 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wider"
						>
							Events
						</th>
						<th
							scope="col"
							className="px-5 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wider"
						>
							Status
						</th>
						<th
							scope="col"
							className="px-5 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wider"
						>
							Created
						</th>
					</tr>
				</thead>
				<tbody className="divide-y divide-zinc-800/60">
					{items.map((webhook) => (
						<tr
							key={webhook.id}
							onClick={() => onSelect(webhook.id)}
							className="hover:bg-zinc-800/30 transition-colors cursor-pointer"
						>
							<td className="px-5 py-4 whitespace-nowrap">
								<span className="text-blue-400 font-medium text-sm">{webhook.name}</span>
							</td>
							<td className="px-5 py-4 whitespace-nowrap text-sm text-zinc-400 max-w-[200px] truncate">
								{webhook.url}
							</td>
							<td className="px-5 py-4 whitespace-nowrap">
								<div className="flex gap-1 flex-wrap">
									{webhook.events.slice(0, 2).map((event) => (
										<span
											key={event}
											className="px-2 py-0.5 bg-zinc-800/60 rounded text-xs border border-zinc-700/50 text-zinc-400"
										>
											{event}
										</span>
									))}
									{webhook.events.length > 2 && (
										<span className="px-2 py-0.5 bg-zinc-800/60 rounded text-xs border border-zinc-700/50 text-zinc-400">
											+{webhook.events.length - 2}
										</span>
									)}
								</div>
							</td>
							<td className="px-5 py-4 whitespace-nowrap">
								{webhook.active ? (
									<span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-950/40 text-emerald-400 border border-emerald-900/40">
										<span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
										Active
									</span>
								) : (
									<span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-zinc-800/60 text-zinc-500 border border-zinc-700/50">
										<span className="w-1.5 h-1.5 rounded-full bg-zinc-500" />
										Inactive
									</span>
								)}
							</td>
							<td className="px-5 py-4 whitespace-nowrap text-sm text-zinc-500">
								{new Date(webhook.createdAt).toLocaleDateString()}
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function WebhookModal({
	webhookId,
	onClose,
	onSaved,
}: {
	webhookId: string | null;
	onClose: () => void;
	onSaved: () => void;
}) {
	const [name, setName] = useState("");
	const [url, setUrl] = useState("");
	const [selectedEvents, setSelectedEvents] = useState<string[]>([]);
	const [saving, setSaving] = useState(false);
	const [createdSecret, setCreatedSecret] = useState<string | null>(null);
	const [formError, setFormError] = useState<string | null>(null);

	const isEditing = !!webhookId;

	const { data: existingWebhook } = trpc.webhooks.get.useQuery(
		{ webhookId: webhookId ?? "" },
		{ enabled: isEditing },
	);

	useEffect(() => {
		if (existingWebhook) {
			setName(existingWebhook.name);
			setUrl(existingWebhook.url);
			setSelectedEvents(existingWebhook.events);
		}
	}, [existingWebhook]);

	const createMutation = trpc.webhooks.create.useMutation();
	const updateMutation = trpc.webhooks.update.useMutation();

	const toggleEvent = (event: string) => {
		setSelectedEvents((prev) =>
			prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event],
		);
	};

	const handleSubmit = async () => {
		setFormError(null);

		if (!name.trim()) {
			setFormError("Name is required");
			return;
		}
		if (!url.trim()) {
			setFormError("URL is required");
			return;
		}
		try {
			new URL(url);
		} catch {
			setFormError("Invalid URL format");
			return;
		}
		if (selectedEvents.length === 0) {
			setFormError("Select at least one event");
			return;
		}

		setSaving(true);
		try {
			if (isEditing && webhookId) {
				await updateMutation.mutateAsync({
					webhookId,
					name,
					url,
					events: selectedEvents,
				});
				onSaved();
			} else {
				const result = await createMutation.mutateAsync({
					name,
					url,
					events: selectedEvents,
				});
				setCreatedSecret(result.secret);
			}
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : "Failed to save webhook";
			setFormError(message);
		} finally {
			setSaving(false);
		}
	};

	if (createdSecret) {
		return (
			<div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
				<div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 w-full max-w-lg mx-4">
					<h2 className="text-lg font-semibold text-zinc-100 mb-4">Webhook Created</h2>
					<div className="bg-amber-950/30 border border-amber-900/40 text-amber-400 p-3 rounded-lg text-sm mb-4">
						<p className="font-medium mb-1">Save this secret — it won't be shown again</p>
						<p className="text-xs text-amber-500">
							Use this secret to verify webhook payloads from Procella.
						</p>
					</div>
					<div className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 font-mono text-sm text-zinc-300 break-all select-all mb-4">
						{createdSecret}
					</div>
					<div className="flex justify-end">
						<button
							type="button"
							onClick={onSaved}
							className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
						>
							Done
						</button>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
			<div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 w-full max-w-lg mx-4">
				<h2 className="text-lg font-semibold text-zinc-100 mb-4">
					{isEditing ? "Edit Webhook" : "Create Webhook"}
				</h2>

				{formError && (
					<div className="bg-red-950/30 border border-red-900/40 text-red-400 p-3 rounded-lg text-sm mb-4">
						{formError}
					</div>
				)}

				<div className="space-y-4">
					<div>
						<label htmlFor="webhook-name" className="block text-sm font-medium text-zinc-300 mb-1">
							Name
						</label>
						<input
							id="webhook-name"
							type="text"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="My webhook"
							className="w-full bg-zinc-900 border border-zinc-700 text-zinc-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder:text-zinc-500"
						/>
					</div>

					<div>
						<label htmlFor="webhook-url" className="block text-sm font-medium text-zinc-300 mb-1">
							URL
						</label>
						<input
							id="webhook-url"
							type="url"
							value={url}
							onChange={(e) => setUrl(e.target.value)}
							placeholder="https://example.com/webhook"
							className="w-full bg-zinc-900 border border-zinc-700 text-zinc-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder:text-zinc-500"
						/>
					</div>

					<div>
						<p className="text-sm font-medium text-zinc-300 mb-2">Events</p>
						<div className="space-y-2">
							{WEBHOOK_EVENTS.map((event) => (
								<label key={event} className="flex items-center gap-2 cursor-pointer">
									<input
										type="checkbox"
										checked={selectedEvents.includes(event)}
										onChange={() => toggleEvent(event)}
										className="rounded border-zinc-600 bg-zinc-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-0"
									/>
									<span className="text-sm text-zinc-300">{event}</span>
								</label>
							))}
						</div>
					</div>
				</div>

				<div className="flex justify-end gap-3 mt-6">
					<button
						type="button"
						onClick={onClose}
						className="px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={handleSubmit}
						disabled={saving}
						className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
					>
						{saving ? "Saving..." : isEditing ? "Save Changes" : "Create"}
					</button>
				</div>
			</div>
		</div>
	);
}

function WebhookDetail({
	webhookId,
	onBack,
	onDeleted,
}: {
	webhookId: string;
	onBack: () => void;
	onDeleted: () => void;
}) {
	const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
	const [showEditModal, setShowEditModal] = useState(false);

	const {
		data: webhook,
		isLoading,
		error: queryError,
		refetch: refetchWebhook,
	} = trpc.webhooks.get.useQuery({ webhookId });
	const error = queryError?.message ?? null;

	const { data: deliveries, refetch: refetchDeliveries } = trpc.webhooks.deliveries.useQuery(
		{ webhookId },
		{ refetchInterval: 10000 },
	);

	const deleteMutation = trpc.webhooks.delete.useMutation();
	const pingMutation = trpc.webhooks.ping.useMutation();

	const handleDelete = async () => {
		try {
			await deleteMutation.mutateAsync({ webhookId });
			onDeleted();
		} catch {
			// Error handled by tRPC
		}
	};

	const handlePing = async () => {
		try {
			await pingMutation.mutateAsync({ webhookId });
			refetchDeliveries();
		} catch {
			// Error handled by tRPC
		}
	};

	const handleEditSaved = useCallback(() => {
		setShowEditModal(false);
		refetchWebhook();
	}, [refetchWebhook]);

	if (isLoading) {
		return (
			<div className="space-y-6">
				<button
					type="button"
					onClick={onBack}
					className="text-sm text-zinc-400 hover:text-zinc-100 transition-colors"
				>
					← Back to webhooks
				</button>
				<div className="animate-pulse space-y-3">
					<div className="h-32 bg-zinc-900 rounded-xl border border-zinc-800" />
				</div>
			</div>
		);
	}

	if (error || !webhook) {
		return (
			<div className="space-y-6">
				<button
					type="button"
					onClick={onBack}
					className="text-sm text-zinc-400 hover:text-zinc-100 transition-colors"
				>
					← Back to webhooks
				</button>
				<div className="bg-red-950/30 border border-red-900/40 text-red-400 p-4 rounded-xl text-sm">
					{error ?? "Webhook not found"}
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<button
				type="button"
				onClick={onBack}
				className="text-sm text-zinc-400 hover:text-zinc-100 transition-colors"
			>
				← Back to webhooks
			</button>

			{/* Webhook info card */}
			<div className="bg-zinc-900 rounded-xl border border-zinc-800 p-6">
				<div className="flex items-start justify-between">
					<div>
						<h2 className="text-lg font-semibold text-zinc-100 mb-1">{webhook.name}</h2>
						<p className="text-sm text-zinc-400 font-mono break-all">{webhook.url}</p>
					</div>
					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={handlePing}
							disabled={pingMutation.isPending}
							className="bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
						>
							{pingMutation.isPending ? "Pinging..." : "Test"}
						</button>
						<button
							type="button"
							onClick={() => setShowEditModal(true)}
							className="bg-zinc-800 hover:bg-zinc-700 text-zinc-300 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
						>
							Edit
						</button>
						<button
							type="button"
							onClick={() => setShowDeleteConfirm(true)}
							className="bg-red-950/40 hover:bg-red-950/60 text-red-400 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors border border-red-900/40"
						>
							Delete
						</button>
					</div>
				</div>

				<div className="mt-4 flex flex-wrap gap-4">
					<div>
						<p className="text-xs text-zinc-500 mb-1">Status</p>
						{webhook.active ? (
							<span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-950/40 text-emerald-400 border border-emerald-900/40">
								<span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
								Active
							</span>
						) : (
							<span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-zinc-800/60 text-zinc-500 border border-zinc-700/50">
								<span className="w-1.5 h-1.5 rounded-full bg-zinc-500" />
								Inactive
							</span>
						)}
					</div>
					<div>
						<p className="text-xs text-zinc-500 mb-1">Events</p>
						<div className="flex gap-1 flex-wrap">
							{webhook.events.map((event) => (
								<span
									key={event}
									className="px-2 py-0.5 bg-zinc-800/60 rounded text-xs border border-zinc-700/50 text-zinc-400"
								>
									{event}
								</span>
							))}
						</div>
					</div>
					<div>
						<p className="text-xs text-zinc-500 mb-1">Created</p>
						<p className="text-sm text-zinc-300">{new Date(webhook.createdAt).toLocaleString()}</p>
					</div>
				</div>
			</div>

			{/* Delivery History */}
			<div>
				<h3 className="text-sm font-semibold text-zinc-100 mb-3">Delivery History</h3>
				{!deliveries || deliveries.length === 0 ? (
					<div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-8 text-center">
						<p className="text-zinc-500 text-sm">No deliveries yet. Click "Test" to send a ping.</p>
					</div>
				) : (
					<div className="bg-zinc-900/50 border border-zinc-800 rounded-xl overflow-hidden">
						<table className="min-w-full divide-y divide-zinc-800">
							<thead>
								<tr className="bg-zinc-900">
									<th
										scope="col"
										className="px-5 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wider"
									>
										Timestamp
									</th>
									<th
										scope="col"
										className="px-5 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wider"
									>
										Event
									</th>
									<th
										scope="col"
										className="px-5 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wider"
									>
										Status
									</th>
									<th
										scope="col"
										className="px-5 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wider"
									>
										Result
									</th>
									<th
										scope="col"
										className="px-5 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wider"
									>
										Duration
									</th>
									<th
										scope="col"
										className="px-5 py-3 text-left text-xs font-medium text-zinc-500 uppercase tracking-wider"
									>
										Attempt
									</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-zinc-800/60">
								{deliveries.map((delivery) => (
									<tr key={delivery.id} className="hover:bg-zinc-800/30 transition-colors">
										<td className="px-5 py-3 whitespace-nowrap text-sm text-zinc-400">
											{new Date(delivery.createdAt).toLocaleString()}
										</td>
										<td className="px-5 py-3 whitespace-nowrap">
											<span className="px-2 py-0.5 bg-zinc-800/60 rounded text-xs border border-zinc-700/50 text-zinc-400">
												{delivery.event}
											</span>
										</td>
										<td className="px-5 py-3 whitespace-nowrap text-sm text-zinc-400 tabular-nums">
											{delivery.responseStatus ?? "—"}
										</td>
										<td className="px-5 py-3 whitespace-nowrap">
											{delivery.success ? (
												<span className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
													<span className="w-2 h-2 rounded-full bg-emerald-400" />
													Success
												</span>
											) : (
												<span className="inline-flex items-center gap-1.5 text-xs text-red-400">
													<span className="w-2 h-2 rounded-full bg-red-400" />
													Failed
												</span>
											)}
										</td>
										<td className="px-5 py-3 whitespace-nowrap text-sm text-zinc-400 tabular-nums">
											{delivery.duration != null ? `${delivery.duration}ms` : "—"}
										</td>
										<td className="px-5 py-3 whitespace-nowrap text-sm text-zinc-400 tabular-nums">
											{delivery.attempt}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</div>

			{/* Delete confirmation dialog */}
			{showDeleteConfirm && (
				<div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
					<div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 w-full max-w-sm mx-4">
						<h3 className="text-lg font-semibold text-zinc-100 mb-2">Delete Webhook</h3>
						<p className="text-sm text-zinc-400 mb-4">
							Are you sure you want to delete "{webhook.name}"? This action cannot be undone.
						</p>
						<div className="flex justify-end gap-3">
							<button
								type="button"
								onClick={() => setShowDeleteConfirm(false)}
								className="px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-100 transition-colors"
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={handleDelete}
								disabled={deleteMutation.isPending}
								className="bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
							>
								{deleteMutation.isPending ? "Deleting..." : "Delete"}
							</button>
						</div>
					</div>
				</div>
			)}

			{/* Edit modal */}
			{showEditModal && (
				<WebhookModal
					webhookId={webhookId}
					onClose={() => setShowEditModal(false)}
					onSaved={handleEditSaved}
				/>
			)}
		</div>
	);
}
