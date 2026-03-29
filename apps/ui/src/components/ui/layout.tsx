import type { CSSProperties, ReactNode } from "react";

type SpaceValue =
	| "0"
	| "0.5"
	| "1"
	| "1.5"
	| "2"
	| "2.5"
	| "3"
	| "3.5"
	| "4"
	| "5"
	| "6"
	| "7"
	| "8"
	| "10"
	| "12"
	| "16";

const SPACE_MAP: Record<SpaceValue, string> = {
	"0": "0px",
	"0.5": "0.125rem",
	"1": "0.25rem",
	"1.5": "0.375rem",
	"2": "0.5rem",
	"2.5": "0.625rem",
	"3": "0.75rem",
	"3.5": "0.875rem",
	"4": "1rem",
	"5": "1.25rem",
	"6": "1.5rem",
	"7": "1.75rem",
	"8": "2rem",
	"10": "2.5rem",
	"12": "3rem",
	"16": "4rem",
};

interface StackProps {
	children: ReactNode;
	space?: SpaceValue;
	align?: "start" | "center" | "end" | "stretch";
	className?: string;
	style?: CSSProperties;
}

export function Stack({ children, space = "4", align, className, style }: StackProps) {
	return (
		<div
			className={className}
			style={{
				display: "flex",
				flexDirection: "column",
				gap: SPACE_MAP[space],
				alignItems: align,
				...style,
			}}
		>
			{children}
		</div>
	);
}

interface RowProps {
	children: ReactNode;
	space?: SpaceValue;
	align?: "start" | "center" | "end" | "baseline" | "stretch";
	justify?: "start" | "center" | "end" | "between" | "around" | "evenly";
	className?: string;
	style?: CSSProperties;
}

const JUSTIFY_MAP = {
	start: "flex-start",
	center: "center",
	end: "flex-end",
	between: "space-between",
	around: "space-around",
	evenly: "space-evenly",
} as const;

export function Row({ children, space = "2", align, justify, className, style }: RowProps) {
	return (
		<div
			className={className}
			style={{
				display: "flex",
				flexDirection: "row",
				gap: SPACE_MAP[space],
				alignItems: align,
				justifyContent: justify ? JUSTIFY_MAP[justify] : undefined,
				...style,
			}}
		>
			{children}
		</div>
	);
}

interface GrowerProps {
	className?: string;
}

export function Grower({ className }: GrowerProps) {
	return <div className={className} style={{ flexGrow: 1 }} />;
}
