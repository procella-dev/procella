export const DOMAIN = "procella.cloud";

/**
 * Base URL for the Procella API server.
 *
 * In production, set VITE_API_URL at build time if the API lives on a
 * separate origin (e.g. api.procella.cloud).
 *
 * During local dev (vite dev server), VITE_API_URL is empty and the Vite proxy
 * in vite.config.ts forwards /trpc and /api/* to localhost:9090.
 */
export const apiBase: string = (import.meta.env.VITE_API_URL ?? "").replace(/\/+$/, "");

/**
 * Base URL for the dashboard app.
 *
 * In production the landing page lives on procella.cloud while the dashboard
 * lives on app.procella.cloud. Links from the landing page (e.g. "Sign in")
 * need the absolute app origin so navigation crosses domains correctly.
 *
 * During local dev and Vercel previews VITE_APP_URL is empty, so links
 * resolve as relative paths on the same origin.
 */
export const appUrl: string = (import.meta.env.VITE_APP_URL ?? "").replace(/\/+$/, "");

/**
 * URL for the Pulumi CLI API (the backend that `pulumi login` connects to).
 *
 * In production this is https://api.procella.cloud (or api.{stage}.procella.cloud
 * for preview envs) — a separate Lambda from the dashboard's web API.
 *
 * During local dev VITE_CLI_API_URL is empty; the Vite proxy forwards /api/*
 * to the same Hono server on localhost:9090, so window.location.origin works.
 */
export const cliApiUrl: string =
	(import.meta.env.VITE_CLI_API_URL ?? "").replace(/\/+$/, "") || window.location.origin;
