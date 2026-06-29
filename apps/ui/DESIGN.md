# Procella UI — Design System

Dark storm-console aesthetic. All tokens live in `src/index.css` under `@theme`.

## Brand palette

| Token | Value | Usage |
|---|---|---|
| `deep-sky` | `#0d1b2a` | Page background |
| `slate-brand` | `#1b2838` | Cards, nav active, secondary surfaces |
| `surface-popup` | `#0f1f30` | Dialogs, table headers, form inputs |
| `lightning` | `#00d4ff` | Primary accent, focus rings, CTAs |
| `flash` | `#ffb800` | Warning / amber accent |
| `mist` | `#e2e8f0` | Primary text |
| `cloud` | `#8b9bb0` | Secondary / muted text |
| `success` | `#10b981` | Success states |
| `danger` | `#ef4444` | Errors, destructive actions |

## Status tokens

| Token | Colour | Meaning |
|---|---|---|
| `status-success` | `#3b82f6` | Succeeded update |
| `status-error` | `#ef4444` | Failed update |
| `status-active` | `#f59e0b` | In-progress update |
| `status-idle` | `#8494a7` | Idle / no recent update |

## Typography

- **Sans**: Inter (UI labels, body)
- **Mono**: JetBrains Mono (stack names, code, timestamps)
- Mono scale: `mono-xs` 0.75rem → `mono-lg` 1rem

## Component utilities (src/index.css `@layer components`)

| Class | Purpose |
|---|---|
| `input-field` | Dark text input/select; `bg-surface-popup`, `border-cloud/20`, `focus:ring-lightning` |
| `btn-primary` | Lightning CTA; `bg-lightning text-deep-sky hover:bg-lightning/90` |
| `btn-ghost` | Text-only button; `text-cloud hover:text-mist` |
| `btn-danger` | Destructive; `bg-danger/80 hover:bg-danger text-white` |
| `btn-secondary` | Muted secondary; `bg-slate-brand hover:bg-slate-brand/70 text-mist/80` |

## Shadows

- `shadow-drop-short` — subtle card lift
- `shadow-drop-medium` — dialogs / popovers

## Animation

- `home-fade-in` / `home-fade-in-delay-{1,2}` — page entry
- `skeleton-shimmer` — loading placeholders
- `status-pulse` — live status dot
