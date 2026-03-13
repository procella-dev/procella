/**
 * Base URL for the Procella API server.
 *
 * In production, set VITE_API_URL at build time if the API lives on a
 * separate origin (e.g. api.procella.dev).
 *
 * During local dev (vite dev server), VITE_API_URL is empty and the Vite proxy
 * in vite.config.ts forwards /trpc and /api/* to localhost:9090.
 */
export const apiBase: string = import.meta.env.VITE_API_URL ?? "";
