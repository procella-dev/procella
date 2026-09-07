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
	 * the tenant, the admin, the requested account, and a fresh `__Host-` browser
	 * nonce is minted before the browser is told anything, and its signed
	 * reference travels in the redirect URL the browser hands back to Descope.
	 * The browser's own cookie-authenticated Descope SDK performs the outbound
	 * connect call, so no session or refresh token is ever read here or handed
	 * to the caller. The redirect URL is always built from this server's own
	 * configured dashboard origin, never from client input, so a caller cannot
	 * redirect the flow to another origin.
	 */
	startConnect: adminProcedure
		.input(z.object({ accountLogin: accountLoginSchema }))
		.mutation(async ({ ctx, input }) => {
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
					input.accountLogin,
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
	 * browser: the requested account is read out of the verified transaction.
	 */
	createInstallationUrl: adminProcedure
		.input(z.object({ state: z.string().min(1).max(4096) }))
		.mutation(async ({ ctx, input }) => {
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
			if (!ctx.setGitHubSetupCookie) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: "GitHub setup cookie support is unavailable",
				});
			}

			const browserNonce = ctx.githubSetupNonce;
			let url: string;
			try {
				url = await ctx.github.issueInstallationUrl(input.state, browserNonce, {
					tenantId: ctx.caller.tenantId,
					userId: ctx.caller.userId,
				});
			} catch (error) {
				throw trpcSetupError(error);
			}
			// The installation state gets a fresh TTL, so the browser binding it is
			// tied to has to get one too: otherwise the cookie minted at connect
			// time expires mid-installation. Only on success, so a failed attempt
			// never extends the window.
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
