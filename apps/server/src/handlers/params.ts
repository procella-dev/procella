// @strata/server — Route parameter extraction helpers.
//
// Hono's c.req.param() returns string | undefined because the type system
// doesn't know which params are defined by the route. These helpers provide
// safe extraction with descriptive errors.

import { BadRequestError } from "@strata/types";
import type { Context } from "hono";
import type { Env } from "../types.js";

/** Extract a required route parameter, throwing BadRequestError if missing. */
export function param(c: Context<Env>, name: string): string {
	const value = c.req.param(name);
	if (!value) {
		throw new BadRequestError(`Missing required parameter: ${name}`);
	}
	return value;
}

/** Extract the update context set by updateAuth middleware. */
export function updateContext(c: Context<Env>): { updateId: string; stackId: string } {
	const ctx = c.get("updateContext");
	if (!ctx) {
		throw new BadRequestError("Missing update context");
	}
	return ctx;
}
