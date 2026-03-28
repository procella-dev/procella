import { randomUUID } from "node:crypto";
import type { Database } from "@procella/db";
import { streamTickets } from "@procella/db";
import { eventBus, type UpdatesService } from "@procella/updates";
import { eq, lt, sql } from "drizzle-orm";
import type { Context } from "hono";
import type { Env } from "../types.js";
import { param } from "./params.js";

const TICKET_TTL_MS = 60_000;

async function mintTicket(db: Database, updateId: string): Promise<string> {
	const id = randomUUID();
	const expiresAt = new Date(Date.now() + TICKET_TTL_MS);
	await db.insert(streamTickets).values({ id, updateId, expiresAt });
	await db.delete(streamTickets).where(lt(streamTickets.expiresAt, sql`now()`));
	return id;
}

async function redeemTicket(db: Database, ticket: string): Promise<string | null> {
	const rows = await db
		.delete(streamTickets)
		.where(eq(streamTickets.id, ticket))
		.returning({ updateId: streamTickets.updateId, expiresAt: streamTickets.expiresAt });
	const row = rows[0];
	if (!row) return null;
	if (row.expiresAt < new Date()) return null;
	return row.updateId;
}

export function sseHandlers(_updates: UpdatesService, db: Database) {
	return {
		mintStreamTicket: async (c: Context<Env>) => {
			const updateId = param(c, "updateId");
			const ticket = await mintTicket(db, updateId);
			return c.json({ ticket });
		},

		streamEvents: async (c: Context<Env>) => {
			const ticket = c.req.query("ticket");
			if (!ticket) {
				return c.json({ code: 401, message: "Missing stream ticket" }, 401);
			}

			const updateId = await redeemTicket(db, ticket);
			if (!updateId) {
				return c.json({ code: 401, message: "Invalid or expired stream ticket" }, 401);
			}

			const stream = new ReadableStream({
				start(controller) {
					const encoder = new TextEncoder();

					const send = (data: string) => {
						try {
							controller.enqueue(encoder.encode(`data: ${data}\n\n`));
						} catch {}
					};

					const heartbeat = setInterval(() => {
						try {
							controller.enqueue(encoder.encode(": heartbeat\n\n"));
						} catch {
							clearInterval(heartbeat);
						}
					}, 15_000);

					const unsubscribe = eventBus.subscribe(updateId, (events) => {
						send(JSON.stringify(events));
					});

					c.req.raw.signal.addEventListener("abort", () => {
						clearInterval(heartbeat);
						unsubscribe();
						try {
							controller.close();
						} catch {}
					});
				},
			});

			return new Response(stream, {
				headers: {
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
					"Content-Type": "text/event-stream",
					"X-Accel-Buffering": "no",
				},
			});
		},
	};
}
