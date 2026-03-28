import { EventEmitter, on } from "node:events";

export class EventBus extends EventEmitter {
	publish(updateId: string, events: unknown[]): void {
		this.emit(updateId, events);
	}

	clear(updateId: string): void {
		this.removeAllListeners(updateId);
	}

	subscribe(updateId: string, handler: (events: unknown[]) => void): () => void {
		this.on(updateId, handler);
		return () => this.off(updateId, handler);
	}
}

export { on };
export const eventBus = new EventBus();
