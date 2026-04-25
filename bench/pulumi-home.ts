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
		await options.cleanupPulumiHome(pulumiHome);
		throw error;
	}
}
