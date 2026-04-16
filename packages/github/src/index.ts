import { timingSafeEqual } from "node:crypto";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { Config } from "@procella/config";
import type { Database } from "@procella/db";
import { githubInstallations } from "@procella/db";
import { desc, eq, sql } from "drizzle-orm";

export interface GitHubInstallationData {
	installationId: number;
	accountLogin: string;
	accountType: "Organization" | "User";
	repositorySelection: "all" | "selected";
}

export interface GitHubInstallationInfo extends GitHubInstallationData {
	id: string;
	tenantId: string;
	createdAt: Date;
	updatedAt: Date;
}

export interface GitHubAppConfig {
	appId: string;
	privateKey: string;
	webhookSecret: string;
}

export interface GitHubService {
	handleWebhookEvent(event: string, payload: unknown): Promise<void>;
	postPRComment(
		installationId: number,
		owner: string,
		repo: string,
		prNumber: number,
		body: string,
	): Promise<void>;
	setCommitStatus(
		installationId: number,
		owner: string,
		repo: string,
		sha: string,
		state: "pending" | "success" | "failure" | "error",
		description: string,
		context?: string,
	): Promise<void>;
	saveInstallation(tenantId: string, installation: GitHubInstallationData): Promise<void>;
	removeInstallation(installationId: number): Promise<void>;
	getInstallation(tenantId: string): Promise<GitHubInstallationInfo | null>;
}

export function buildGitHubAppConfig(config: Config): GitHubAppConfig | null {
	if (!config.githubAppId || !config.githubAppPrivateKey || !config.githubAppWebhookSecret) {
		return null;
	}

	return {
		appId: config.githubAppId,
		privateKey: config.githubAppPrivateKey,
		webhookSecret: config.githubAppWebhookSecret,
	};
}

export async function verifyGitHubWebhookSignature(
	payload: string,
	signature: string,
	secret: string,
): Promise<boolean> {
	if (!signature?.startsWith("sha256=")) {
		return false;
	}

	const expected = signature.slice(7);
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
	const computed = Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

	const computedBuf = Buffer.from(computed, "hex");
	const expectedBuf = Buffer.from(expected, "hex");
	if (computedBuf.length !== expectedBuf.length) {
		return false;
	}

	return timingSafeEqual(computedBuf, expectedBuf);
}

export function buildPRCommentBody(update: {
	org: string;
	project: string;
	stack: string;
	kind: string;
	status: string;
	resourceChanges?: { creates?: number; updates?: number; deletes?: number; sames?: number };
	permalink?: string;
}): string {
	const statusLabel =
		update.status === "succeeded"
			? "✅ succeeded"
			: update.status === "failed"
				? "❌ failed"
				: update.status === "cancelled"
					? "⚪ cancelled"
					: update.status;

	const creates = update.resourceChanges?.creates ?? 0;
	const updates = update.resourceChanges?.updates ?? 0;
	const deletes = update.resourceChanges?.deletes ?? 0;
	const sames = update.resourceChanges?.sames ?? 0;

	const lines = [
		"## Pulumi Preview Results",
		`**Stack:** \`${update.org}/${update.project}/${update.stack}\``,
		`**Operation:** ${update.kind}`,
		`**Status:** ${statusLabel}`,
		"",
		"| Action | Count |",
		"|--------|-------|",
		`| Create | ${creates} |`,
		`| Update | ${updates} |`,
		`| Delete | ${deletes} |`,
		`| Same | ${sames} |`,
	];

	if (update.permalink) {
		lines.push("", `[View details](${update.permalink})`);
	}

	return lines.join("\n");
}

export function mapUpdateStatusToCommitState(
	status: string,
): "pending" | "success" | "failure" | "error" {
	if (status === "succeeded") {
		return "success";
	}
	if (status === "failed" || status === "cancelled") {
		return "failure";
	}
	if (status === "running" || status === "requested" || status === "not started") {
		return "pending";
	}
	return "error";
}

export class OctokitGitHubService implements GitHubService {
	private readonly db: Database;
	private readonly config: GitHubAppConfig;

	constructor({ db, config }: { db: Database; config: GitHubAppConfig }) {
		this.db = db;
		this.config = config;
	}

	async handleWebhookEvent(event: string, payload: unknown): Promise<void> {
		const body = payload as {
			action?: string;
			installation?: {
				id?: number;
				account?: { login?: string; type?: "Organization" | "User" };
				repository_selection?: "all" | "selected";
			};
		};

		if (event === "installation" || event === "installation_repositories") {
			const installation = body.installation;
			if (!installation?.id) {
				return;
			}

			if (event === "installation" && body.action === "deleted") {
				await this.removeInstallation(installation.id);
				return;
			}

			const accountLogin = installation.account?.login;
			if (!accountLogin) {
				return;
			}

			await this.saveInstallation(accountLogin, {
				installationId: installation.id,
				accountLogin,
				accountType: installation.account?.type ?? "Organization",
				repositorySelection: installation.repository_selection ?? "all",
			});
		}
	}

	async postPRComment(
		installationId: number,
		owner: string,
		repo: string,
		prNumber: number,
		body: string,
	): Promise<void> {
		const octokit = this.createInstallationClient(installationId);
		// Phase 1 limitation: post a new Procella comment for each update.
		// Phase 2 will switch to find-and-update existing Procella comment threads.
		await octokit.rest.issues.createComment({
			owner,
			repo,
			issue_number: prNumber,
			body,
		});
	}

	async setCommitStatus(
		installationId: number,
		owner: string,
		repo: string,
		sha: string,
		state: "pending" | "success" | "failure" | "error",
		description: string,
		context = "procella/preview",
	): Promise<void> {
		const octokit = this.createInstallationClient(installationId);
		await octokit.rest.repos.createCommitStatus({
			owner,
			repo,
			sha,
			state,
			description,
			context,
		});
	}

	async saveInstallation(tenantId: string, installation: GitHubInstallationData): Promise<void> {
		await this.db
			.insert(githubInstallations)
			.values({
				tenantId,
				installationId: installation.installationId,
				accountLogin: installation.accountLogin,
				accountType: installation.accountType,
				repositorySelection: installation.repositorySelection,
			})
			.onConflictDoUpdate({
				target: [githubInstallations.tenantId, githubInstallations.installationId],
				set: {
					accountLogin: installation.accountLogin,
					accountType: installation.accountType,
					repositorySelection: installation.repositorySelection,
					updatedAt: sql`now()`,
				},
			});
	}

	async removeInstallation(installationId: number): Promise<void> {
		await this.db
			.delete(githubInstallations)
			.where(eq(githubInstallations.installationId, installationId));
	}

	async getInstallation(tenantId: string): Promise<GitHubInstallationInfo | null> {
		const [row] = await this.db
			.select()
			.from(githubInstallations)
			.where(eq(githubInstallations.tenantId, tenantId))
			.orderBy(desc(githubInstallations.updatedAt))
			.limit(1);

		if (!row) {
			return null;
		}

		return {
			id: row.id,
			tenantId: row.tenantId,
			installationId: row.installationId,
			accountLogin: row.accountLogin,
			accountType: row.accountType as "Organization" | "User",
			repositorySelection: row.repositorySelection as "all" | "selected",
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		};
	}

	private createInstallationClient(installationId: number): Octokit {
		return new Octokit({
			authStrategy: createAppAuth,
			auth: {
				appId: this.config.appId,
				privateKey: this.config.privateKey,
				installationId,
			},
		});
	}
}
