import { Link } from "react-router";
import stormPetrelSvg from "../assets/storm-petrel.svg";

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
			<img src={stormPetrelSvg} className={s.icon} alt="Procella logo" />
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
