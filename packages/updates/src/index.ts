// @procella/updates — Update lifecycle domain (updates, events, checkpoints, GC)

export { checkpointDedup } from "./checkpoint-dedup.js";
export { eventBus, on } from "./event-bus.js";
export { GCWorker } from "./gc-worker.js";
export * from "./helpers.js";
export { PgListener } from "./pg-listener.js";
export { detectEventKind, mapStatusToApiStatus, PostgresUpdatesService } from "./postgres.js";
export type { RepairMutation } from "./repair.js";
export { detectDanglingParents, detectOrphans, repairCheckpoint } from "./repair.js";
export * from "./types.js";
