import { Link } from "react-router";

/**
 * Shared brand logo used across Layout, Login, and HomePage.
 * Renders the stacked-layers SVG icon + "Procella" text, optionally wrapped in a Link.
 */
export function ProcellaLogo({
	size = "md",
	linkTo,
	className = "",
}: {
	size?: "sm" | "md" | "lg";
	linkTo?: string;
	className?: string;
}) {
	const sizes = {
		sm: { icon: "w-5 h-5", text: "text-[15px]" },
		md: { icon: "w-6 h-6", text: "text-2xl" },
		lg: { icon: "w-7 h-7", text: "text-3xl" },
	};
	const s = sizes[size];

	const content = (
		<>
			<svg
				viewBox="0 0 24 24"
				fill="none"
				className={`${s.icon} text-blue-500`}
				role="img"
				aria-label="Procella logo"
			>
				<title>Procella logo</title>
				<path
					d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			</svg>
			<span className={`${s.text} font-bold tracking-tight text-zinc-100`}>Procella</span>
		</>
	);

	if (linkTo) {
		return (
			<Link to={linkTo} className={`flex items-center gap-2.5 ${className}`}>
				{content}
			</Link>
		);
	}

	return <span className={`flex items-center gap-2.5 ${className}`}>{content}</span>;
}
