type EventHandler = (events: unknown[]) => void;

export class EventBus {
	private channels = new Map<string, Set<EventHandler>>();

	subscribe(updateId: string, handler: EventHandler): () => void {
		if (!this.channels.has(updateId)) {
			this.channels.set(updateId, new Set());
		}
		this.channels.get(updateId)?.add(handler);

		return () => {
			this.channels.get(updateId)?.delete(handler);
			if (this.channels.get(updateId)?.size === 0) {
				this.channels.delete(updateId);
			}
		};
	}

	publish(updateId: string, events: unknown[]): void {
		const handlers = this.channels.get(updateId);
		if (!handlers) {
			return;
		}

		for (const handler of handlers) {
			try {
				handler(events);
			} catch {}
		}
	}

	clear(updateId: string): void {
		this.channels.delete(updateId);
	}
}

export const eventBus = new EventBus();
