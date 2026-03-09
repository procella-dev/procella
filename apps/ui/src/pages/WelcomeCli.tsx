export function WelcomeCli() {
	return (
		<div className="min-h-screen bg-zinc-950 flex flex-col items-center justify-center">
			<div className="text-center space-y-3">
				<div className="text-4xl">✓</div>
				<h1 className="text-2xl font-bold text-zinc-100">Logged in</h1>
				<p className="text-zinc-400 text-sm">
					You can close this window and return to the terminal.
				</p>
			</div>
		</div>
	);
}
