import { Client } from "pg";
import { eventBus } from "./event-bus.js";

const CHANNEL = "update_events";
const RECONNECT_DELAY_MS = 3_000;

function isNeonUrl(url: string): boolean {
	try {
		return new URL(url.replace(/^postgres(ql)?:\/\//, "http://")).hostname.endsWith(".neon.tech");
	} catch {
		return false;
	}
}

export class PgListener {
	private client: Client | null = null;
	private stopped = false;
	private readonly url: string;

	constructor(url: string) {
		this.url = url;
	}

	async start(): Promise<void> {
		if (isNeonUrl(this.url)) {
			return;
		}
		await this.connect();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		await this.client?.end().catch(() => {});
		this.client = null;
	}

	private async connect(): Promise<void> {
		if (this.stopped) return;
		const client = new Client({ connectionString: this.url });
		this.client = client;

		client.on("notification", (msg) => {
			const updateId = msg.payload;
			if (updateId) eventBus.publish(updateId, []);
		});

		client.on("error", () => {
			if (!this.stopped) void this.reconnect();
		});

		client.on("end", () => {
			if (!this.stopped) void this.reconnect();
		});

		try {
			await client.connect();
			await client.query(`LISTEN ${CHANNEL}`);
		} catch {
			if (!this.stopped) void this.reconnect();
		}
	}

	private async reconnect(): Promise<void> {
		this.client = null;
		await new Promise<void>((r) => setTimeout(r, RECONNECT_DELAY_MS));
		if (!this.stopped) await this.connect();
	}
}
