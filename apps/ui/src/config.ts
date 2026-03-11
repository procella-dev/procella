/**
 * Base URL for the Procella API server.
 *
 * In production the UI is served from a CloudFront StaticSite (e.g. procella.dev)
 * while the API lives on a separate subdomain (e.g. api.procella.dev). SST sets
 * VITE_API_URL at build time so browser requests reach the correct origin.
 *
 * During local dev (vite dev server), VITE_API_URL is empty and the Vite proxy in
 * vite.config.ts forwards /trpc and /api/* to localhost:9090.
 */
export const apiBase: string = import.meta.env.VITE_API_URL ?? "";
