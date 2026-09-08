import {
	createGitHubSetupNonce,
	GITHUB_CONNECT_RETURN_PATH,
	GitHubSetupError,
} from "@procella/github";
import { ProcellaError } from "@procella/types";
import { TRPCError } from "@trpc/server";
import { z } from "zod/v4";
import { adminProcedure, protectedProcedure, router } from "../trpc.js";

const SETUP_ERROR_MESSAGES: Record<string, { code: TRPCError["code"]; message: string }> = {
	authorization_unavailable: {
		code: "PRECONDITION_FAILED",
		message: "GitHub user verification is not configured on this server",
	},
	authorization_required: {
		code: "FORBIDDEN",
		message:
			"Connect a GitHub account that owns this account or administers this organization, then retry",
	},
	authorization_failed: {
		code: "BAD_GATEWAY",
		message: "GitHub could not confirm your account administration",
	},
	invalid_state: {
		code: "BAD_REQUEST",
		message: "This GitHub connection could not be verified. Start the connection again",
	},
	expired_state: {
		code: "BAD_REQUEST",
		message: "The GitHub connection expired. Start the connection again",
	},
	replayed_state: {
		code: "BAD_REQUEST",
		message: "This GitHub connection was already used. Start the connection again",
	},
	unauthorized_account: {
		code: "BAD_REQUEST",
		message: "That GitHub installation belongs to a different account than the one you selected",
	},
	invalid_installation: {
		code: "BAD_REQUEST",
		message: "GitHub could not find that installation",
	},
	installation_conflict: {
		code: "CONFLICT",
		message: "That GitHub installation is already connected to another tenant",
	},
};

function trpcSetupError(error: unknown): TRPCError {
	if (error instanceof GitHubSetupError) {
		const mapped = SETUP_ERROR_MESSAGES[error.code];
		if (mapped) return new TRPCError(mapped);
		return new TRPCError({ code: "BAD_REQUEST", message: error.code });
	}
	// Other domain errors keep their own status through the tRPC error formatter.
	if (error instanceof ProcellaError) {
		return new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: error.message,
			cause: error,
		});
	}
	return new TRPCError({
		code: "INTERNAL_SERVER_ERROR",
		message: "Unable to start GitHub setup",
	});
}
function requireInteractiveUser(principalType: string): void {
	if (principalType !== "user") {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "GitHub setup requires an interactive user session",
		});
	}
}

const accountLoginSchema = z
	.string()
	.trim()
	.min(1)
	.max(100)
	.regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/);

export const githubRouter = router({
	status: protectedProcedure.query(async ({ ctx }) => {
		if (!ctx.github) {
			return {
				configured: false as const,
				connectAvailable: false,
				connectedLogin: null,
				installations: [],
			};
		}
		const connectAvailable =
			ctx.github.connectAvailable && Boolean(ctx.appOrigin) && Boolean(ctx.githubOutboundAppId);
		return {
			configured: true as const,
			connectAvailable,
			// Reported for the caller's own tenant and session, and only the login;
			// the vaulted GitHub token never leaves the server.
			connectedLogin: connectAvailable
				? await ctx.github.resolveConnectedLogin(ctx.caller.tenantId, ctx.caller.userId)
				: null,
			installations: await ctx.github.listInstallations(ctx.caller.tenantId),
		};
	}),

	/**
	 * Cookie-mode safe outbound handoff. A one-time server transaction bound to
	 * the tenant, the admin, and a fresh `__Host-` browser nonce is minted
	 * before the browser is told anything, and its signed reference travels in
	 * the redirect URL the browser hands back to Descope. The browser's own
	 * cookie-authenticated Descope SDK performs the outbound connect call, so
	 * no session or refresh token is ever read here or handed to the caller.
	 * The redirect URL is always built from this server's own configured
	 * dashboard origin, never from client input, so a caller cannot redirect
	 * the flow to another origin. No GitHub account is selected yet: that
	 * happens against the App's own installation listing once the identity is
	 * confirmed, not against free-text input.
	 */
	startConnect: adminProcedure.input(z.object({})).mutation(async ({ ctx }) => {
		requireInteractiveUser(ctx.caller.principalType);
		if (!ctx.github) {
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message: "GitHub App is not configured on this server",
			});
		}
		if (!ctx.github.connectAvailable || !ctx.appOrigin || !ctx.githubOutboundAppId) {
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message: "GitHub user verification is not configured on this server",
			});
		}
		if (!ctx.setGitHubSetupCookie) {
			throw new TRPCError({
				code: "INTERNAL_SERVER_ERROR",
				message: "GitHub setup cookie support is unavailable",
			});
		}

		const browserNonce = createGitHubSetupNonce();
		try {
			const state = await ctx.github.beginConnect(
				ctx.caller.tenantId,
				ctx.caller.userId,
				browserNonce,
			);
			const redirectUrl = new URL(GITHUB_CONNECT_RETURN_PATH, ctx.appOrigin);
			redirectUrl.searchParams.set("state", state);
			// The cookie must exist before the browser can complete the outbound
			// connect it is about to start, so it is set here rather than after.
			ctx.setGitHubSetupCookie(browserNonce);
			return {
				appId: ctx.githubOutboundAppId,
				tenantId: ctx.caller.tenantId,
				redirectUrl: redirectUrl.toString(),
			};
		} catch (error) {
			throw trpcSetupError(error);
		}
	}),

	/**
	 * Continues the flow after the Descope callback. Authority comes from the
	 * signed connect transaction plus the browser nonce cookie, never from the
	 * browser. Vaults the confirmed GitHub token for this tenant and admin;
	 * nothing is selected yet, so no account-administration check happens
	 * here. This is the token-confirmation half of what used to be a single
	 * `createInstallationUrl` call.
	 */
	confirmConnect: adminProcedure
		.input(z.object({ state: z.string().min(1).max(4096) }))
		.mutation(async ({ ctx, input }) => {
			requireInteractiveUser(ctx.caller.principalType);
			if (!ctx.github) {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: "GitHub App is not configured on this server",
				});
			}
			if (!ctx.githubSetupNonce) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "This GitHub connection could not be verified. Start the connection again",
				});
			}

			try {
				const identity = await ctx.github.confirmConnect(input.state, ctx.githubSetupNonce, {
					tenantId: ctx.caller.tenantId,
					userId: ctx.caller.userId,
				});
				return { login: identity.login };
			} catch (error) {
				throw trpcSetupError(error);
			}
		}),

	/**
	 * Lists the GitHub accounts the connected identity administers, joined
	 * with any App installation already visible for that account and whether
	 * this tenant, or another one, already claims it. Requires a confirmed
	 * connection, and exposes the caller's GitHub organization membership, so
	 * it is restricted to interactive admins.
	 */
	connectTargets: adminProcedure.query(async ({ ctx }) => {
		requireInteractiveUser(ctx.caller.principalType);
		if (!ctx.github) {
			throw new TRPCError({
				code: "PRECONDITION_FAILED",
				message: "GitHub App is not configured on this server",
			});
		}

		try {
			const targets = await ctx.github.listConnectTargets(ctx.caller.tenantId, ctx.caller.userId);
			return { targets };
		} catch (error) {
			throw trpcSetupError(error);
		}
	}),

	/**
	 * Binds an already-installed App installation to this tenant. The
	 * installation id comes from our own authenticated `connectTargets`
	 * response, not from a GitHub-driven redirect, so there is no signed
	 * state or browser nonce to verify here: the server re-derives the
	 * account from GitHub by installation id and re-checks administration
	 * before saving the binding.
	 */
	connectInstallation: adminProcedure
		.input(z.object({ installationId: z.number().int().positive() }))
		.mutation(async ({ ctx, input }) => {
			requireInteractiveUser(ctx.caller.principalType);
			if (!ctx.github) {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: "GitHub App is not configured on this server",
				});
			}

			try {
				const installation = await ctx.github.connectInstallation(
					ctx.caller.tenantId,
					ctx.caller.userId,
					input.installationId,
				);
				return { installation };
			} catch (error) {
				throw trpcSetupError(error);
			}
		}),

	/**
	 * Issues a fresh GitHub App installation URL for `accountLogin`. Requires
	 * a confirmed connection and verifies the caller administers that
	 * account, allowing invisible membership: the App is not installed there
	 * yet, so GitHub hides the org from a plain membership check. Mints a
	 * fresh browser nonce and sets its cookie only after the state is issued,
	 * so a failed attempt never extends the browser binding's window.
	 */
	createInstallationUrl: adminProcedure
		.input(z.object({ accountLogin: accountLoginSchema }))
		.mutation(async ({ ctx, input }) => {
			requireInteractiveUser(ctx.caller.principalType);
			if (!ctx.github) {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: "GitHub App is not configured on this server",
				});
			}
			if (!ctx.setGitHubSetupCookie) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: "GitHub setup cookie support is unavailable",
				});
			}

			// The nonce identifies the browser, not one attempt, so an existing
			// cookie is reused: minting a new one per call would invalidate the
			// binding of an install already in flight in another tab, and its
			// GitHub callback would then fail verification even though the App
			// was installed.
			const browserNonce = ctx.githubSetupNonce ?? createGitHubSetupNonce();
			let url: string;
			try {
				url = await ctx.github.issueInstallationUrl(
					ctx.caller.tenantId,
					ctx.caller.userId,
					input.accountLogin,
					browserNonce,
				);
			} catch (error) {
				throw trpcSetupError(error);
			}
			// The installation state carries a fresh TTL, so the browser binding
			// it is tied to needs a matching fresh cookie. Only on success, so a
			// failed attempt never extends the window.
			ctx.setGitHubSetupCookie(browserNonce);
			return { url };
		}),

	removeInstallation: adminProcedure
		.input(z.object({ installationId: z.number().int().positive() }))
		.mutation(async ({ ctx, input }) => {
			if (ctx.github) {
				try {
					await ctx.github.removeInstallation(
						ctx.caller.tenantId,
						input.installationId,
						ctx.caller.userId,
					);
				} catch (error) {
					throw trpcSetupError(error);
				}
			}
			return { success: true };
		}),
});
