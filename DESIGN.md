---
version: alpha
name: OpenInspection Native Client
description: An offline field-inspection tool with a quiet, task-first interface built for returning to local work safely.
colors:
  primary: "#6265f0"
  background: "#f8fafc"
  surface: "#ffffff"
  foreground: "#0f172a"
  mutedForeground: "#475569"
typography:
  sans:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
  mono:
    fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace"
rounded:
  button: "6px"
  input: "8px"
  card: "8px"
  modal: "12px"
  pill: "4px"
spacing:
  screen-gap: "1.5rem"
  section-gap: "0.75rem"
  card-padding: "0.875rem"
  settings-width: "42rem"
components:
  button-primary: { backgroundColor: "{colors.primary}", textColor: "{colors.surface}", rounded: "{rounded.button}", height: "2.75rem" }
  button-secondary: { backgroundColor: "{colors.surface}", textColor: "{colors.mutedForeground}", rounded: "{rounded.button}" }
  input: { backgroundColor: "{colors.surface}", textColor: "{colors.foreground}", rounded: "{rounded.input}" }
  notice: { backgroundColor: "{colors.background}", textColor: "{colors.mutedForeground}", rounded: "{rounded.card}", padding: "0.5rem 0.75rem" }
  screen: { backgroundColor: "{colors.background}", textColor: "{colors.foreground}", width: "{spacing.settings-width}", rounded: "{rounded.modal}" }
---

# OpenInspection Native Client Design

## Overview

### Creative North Star

This is the compact field console an inspector returns to between site visits: clear status, familiar controls, and reliable access to work saved on the device. The interface prioritizes a legible task path over decorative branding.

### Product context and register

- **Audience and primary job:** Inspectors setting up a server, signing in, continuing offline work, and recovering device data.
- **Target market(s) and evidence:** The app is an English-only public native client; see `README.md` and `docs/development.md`.
- **Locale(s) and language policy:** English UI copy; date presentation follows the app's existing locale helper in `src/platform/format-locale.ts`.
- **Usage scene:** Android phones and tablets plus a Windows desktop window, often used alongside inspection work and sometimes without a network.
- **Register:** Product. Server setup, work, account, and recovery tasks use one shared interface across the native and desktop shells.
- **Memorable signature:** The work list and recovery actions remain available around local inspection data, including when offline.
- **Restraint:** Keep settings compact and scannable. The Electron-only settings block uses the existing section rhythm and semantic theme tokens.
- **Anti-references:** Avoid marketing-page hero layouts, decorative dashboards, and status colors used without labels.
- **Token ownership/runtime mapping:** The field-ui package theme remains the canonical source for semantic colors, radii, and shadows. This file records intent and a small subset of values; it does not generate CSS. Runtime mapping is `src/styles.css` importing `@inspectorhub/field-ui/theme.css`, with system-font overrides in `src/styles.css`; shared control conventions are in `src/ui/kit.tsx`.

## Colors

The light palette uses a cool slate app background, white content surface, dark readable text, and the field-ui indigo primary. The listed colors mirror the package's light scheme; borders and status tones remain owned by that package and are intentionally not duplicated here. Dark mode is selected through `html[data-color-scheme]` and preserves the same hierarchy with the package's dark values. Do not add screen-local color values. Forced-colors mode uses the system highlight outline in `src/styles.css`.

## Typography

The native client deliberately overrides the package's web-font-first stacks with the operating-system system stack in `src/styles.css`. Headings use the same system family with a stronger weight and tighter tracking; body copy stays at the platform's 16px base; paths and technical values use the system monospace stack. Labels and actions use sentence case and familiar field-work terms.

## Layout

The shared screen is a centered, single-column card on wider viewports and a full-width column on phones. Existing screen and section gaps come from Tailwind's established spacing rhythm and `src/ui/kit.tsx`; settings remains a natural-height page that can scroll. A compact desktop settings section sits among the existing settings sections. The Electron shell uses the same renderer UI and theme as Android; only privileged folder actions and updater presentation are desktop-specific.

## Elevation & Depth

Static content relies on surface and border contrast. The existing screen card and modal/popover primitives may use the shared theme's subtle shadows. Do not introduce a new shadow token for desktop settings.

## Shapes

Buttons use the shared 6px radius; inputs and cards use 8px; modal surfaces use 12px; compact pills use 4px. These values are defined by `@inspectorhub/field-ui/theme.css`. Avoid one-off geometry in the desktop panel.

## Components

### Foundational visual states

Reuse `Button`, `Screen`, `Notice`, and section heading conventions from `src/ui/kit.tsx` and `src/ui/Settings.tsx`. Focus-visible uses the theme focus shadow plus a forced-colors outline. Busy controls preserve size and use the shared progress cursor; disabled actions remain visibly unavailable.

### Buttons and actions

Use the shared primary, secondary, quiet, and danger variants. Actions name their result, use real buttons, and keep folder access visually secondary to the inspection workflow.

### Navigation and data display

Screens have one first-level heading and settings sections use second-level headings. Long server addresses wrap; technical values use monospace where the existing screen does so.

### Forms and overlays

Forms use app-owned validation and the existing dialog primitives. No browser-native alert, confirm, or prompt UI is allowed. Destructive local-data clearing retains its existing confirmation flow.

### Iconography

The host UI uses text labels and small inline glyphs rather than a separate icon package. Icon-like glyphs remain decorative when a text label is available.

### Motion

Routine navigation is immediate. Follow system reduced-motion behavior already provided by shared styles; motion must not delay access to local work.

### Content and data visualization

Write short, direct English copy. Use the exact action name again in feedback, and explain offline or recovery consequences where the existing workflow does.

## Do's and Don'ts

- **Do:** Preserve the same Settings hierarchy and theme tokens across Android and Electron.
- **Do:** Keep local-data and log-folder access explicit and open those folders through the desktop bridge.
- **Don't:** Add private service strategy or a second color/font/radius system to the public app.
- **Don't:** Hide important status behind hover, color alone, or a narrow desktop-only control.
