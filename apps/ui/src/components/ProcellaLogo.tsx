import { Link } from "react-router";

/**
 * Shared brand logo used across Layout, Login, and HomePage.
 * Renders the Storm Petrel mascot SVG icon + "Procella" text, optionally wrapped in a Link.
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
				className={`${s.icon} text-lightning`}
				role="img"
				aria-label="Procella logo"
			>
				<title>Procella logo</title>
				{/* Upper wing - swept back */}
				<path d="M13 11.5 Q8 7.5 3 4.5 Q7 8 13 11.5Z" fill="currentColor" />
				{/* Lower wing - swept back */}
				<path d="M13 12.5 Q8 16.5 3 19.5 Q7 16 13 12.5Z" fill="currentColor" />
				{/* Body - streamlined ellipse */}
				<ellipse cx="15" cy="12" rx="4.5" ry="1.8" fill="currentColor" />
				{/* Head */}
				<circle cx="19.5" cy="11.2" r="1.5" fill="currentColor" />
				{/* Forked tail */}
				<path d="M10.5 11.5 L7 9.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
				<path
					d="M10.5 12.5 L7 14.5"
					stroke="currentColor"
					strokeWidth="1.2"
					strokeLinecap="round"
				/>
				{/* Eye - Flash amber accent */}
				<circle cx="20.2" cy="10.8" r="0.45" fill="#FFB800" />
				{/* White rump patch */}
				<ellipse cx="11.5" cy="12.3" rx="1" ry="0.55" fill="white" opacity="0.85" />
			</svg>
			<span className={`${s.text} font-bold tracking-tight text-mist`}>Procella</span>
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
