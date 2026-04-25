export interface PreparePulumiHomeOptions {
	createPulumiHome: () => Promise<string>;
	ensurePulumiPlugins: (pulumiHome: string) => Promise<void>;
	cleanupPulumiHome: (pulumiHome: string) => Promise<void>;
}

export async function preparePulumiHome(options: PreparePulumiHomeOptions): Promise<string> {
	const pulumiHome = await options.createPulumiHome();
	try {
		await options.ensurePulumiPlugins(pulumiHome);
		return pulumiHome;
	} catch (error) {
		try {
			await options.cleanupPulumiHome(pulumiHome);
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				`Failed to prepare Pulumi home ${pulumiHome} and clean it up`,
			);
		}
		throw error;
	}
}
