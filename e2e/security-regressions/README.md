# Security regression suite

This directory holds the consolidated regression tests for the remediated audit findings in `vulns.txt`.

## Finding IDs

- **L1-L8**: LOW hardening regressions
- **VL1-VL5**: library-version regressions

## Coverage matrix

| Finding | Covered by | Notes |
|---|---|---|
| L1 | `e2e/security-regressions/low-and-versions.test.ts` | `validateName()` rejects control chars/newlines |
| L2 | `e2e/security-regressions/low-and-versions.test.ts` | HTTP security headers on `/healthz` |
| L3 | `e2e/security-regressions/low-and-versions.test.ts` | `POST /api/auth/cli-token` rate limit |
| L4 | `e2e/security-regressions/low-and-versions.test.ts` | ignores spoofed `X-Forwarded-For` unless trust proxy is enabled |
| L5 | `e2e/security-regressions/low-and-versions.test.ts` | `.env.example` placeholder regression |
| L6 | `e2e/security-regressions/low-and-versions.test.ts` | `apps/ui/Caddyfile` self-hosted TLS note |
| L7 | `e2e/security-regressions/low-and-versions.test.ts` | auth logging must not leak `sub=...` |
| L8 | `e2e/security-regressions/low-and-versions.test.ts` | audit route classifier regex anchors on `NAME_SEGMENT` |
| VL1 | `e2e/security-regressions/low-and-versions.test.ts` | `drizzle-orm >= 0.45.2` |
| VL2 | `e2e/security-regressions/low-and-versions.test.ts` | `@trpc/server >= 11.1.1` |
| VL3 | `e2e/security-regressions/low-and-versions.test.ts` | `hono >= 4.12.14` in server + telemetry packages |
| VL4 | `e2e/security-regressions/low-and-versions.test.ts` | `jose >= 6.0.0` |
| VL5 | `e2e/security-regressions/low-and-versions.test.ts` | Docker image must not pass through `/events` |

## Running the suite

- **Unit regressions:** `bun run test:security`
- **HTTP/e2e regressions:** `bun run test:security:e2e`

`test:security:e2e` enables the server-backed checks for L2-L4 and uses the standard `./e2e/setup.ts` preload.
