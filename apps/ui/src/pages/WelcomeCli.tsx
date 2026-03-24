export function WelcomeCli() {
	return (
		<div className="min-h-screen bg-deep-sky flex flex-col items-center justify-center">
			<div className="text-center space-y-3">
				<div className="text-4xl">✓</div>
				<h1 className="text-2xl font-bold text-mist">Logged in</h1>
				<p className="text-cloud text-sm">You can close this window and return to the terminal.</p>
			</div>
		</div>
	);
}
