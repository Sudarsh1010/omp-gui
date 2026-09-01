# Building UI

How agents build user interface in this repo. The rule exists because `@omp-gui/ui`
already carries the full component library, theme (`base-lyra`), and icon set
(phosphor) — hand-rolling raw markup fragments the design system and reintroduces
the inconsistencies the shared package was created to prevent.

## The rule

**Any React UI surface MUST use `@omp-gui/ui`.** Do not hand-roll primitives
(`<button>`, `<input>`, `<select>`, dialogs, tables, …). Import the equivalent
component from `@omp-gui/ui/components/*` instead.

This is scoped by *surface type*, not package: it applies to every React app in the
repo. Today that is `gui`. `platform/www` is vanilla TS and `platform/ipc` is
non-UI, so neither is in scope — but `www` comes into scope automatically if it ever
becomes a React app.

The library already contains ~57 primitives (button, card, dialog, table, tabs,
tooltip, toast, sidebar, command, …). Check `platform/ui/src/components/` before
assuming a component is missing.

## Two-tier workflow

The consuming app's `components.json` encodes a two-tier split (`ui` alias →
`@omp-gui/ui/components`, `components` alias → app-local `@/components`):

- **Primitives** (net-new shadcn components: button, dialog, table, …) are added to
  **`platform/ui`**. Run `shadcn add` from `platform/ui` so they land in the shared
  library and every app gets them.
- **App-specific compositions** (screens, panels, feature widgets built *from* those
  primitives) live in the consuming app, e.g. **`gui/src/components/`**.

Never `shadcn add` a primitive directly into `gui` — that re-fragments the library.

## Use the shadcn skill

For any component work — adding, composing, fixing, styling — invoke the **shadcn**
skill. It knows the CLI workflow, the `base-lyra` style, the phosphor icon library,
and the composition rules (compose from existing components before writing custom
markup; use semantic color tokens, not raw values).

## Consuming components

Import from the package's export map:

```tsx
import { Button } from "@omp-gui/ui/components/button";
import { Card, CardHeader, CardTitle, CardContent } from "@omp-gui/ui/components/card";
```
