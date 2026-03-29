export class CheckpointDedup {
	private hashes = new Map<string, string>();

	async isDuplicate(updateId: string, content: string): Promise<boolean> {
		const hash = await this.computeHash(content);
		if (this.hashes.get(updateId) === hash) return true;
		this.hashes.set(updateId, hash);
		return false;
	}

	clear(updateId: string): void {
		this.hashes.delete(updateId);
	}

	private async computeHash(content: string): Promise<string> {
		const bytes = new TextEncoder().encode(content);
		const digest = await crypto.subtle.digest("SHA-256", bytes);
		return Buffer.from(digest).toString("hex");
	}
}

export const checkpointDedup = new CheckpointDedup();
