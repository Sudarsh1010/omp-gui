# Credentials are omp's; the app is a pass-through

**Status:** accepted

The app stores and manages no credentials. Provider auth lives entirely in omp's own credential store (`~/.omp`, shared with the user's terminal omp). The app renders login UX only when omp emits it — `get_login_providers`/`login` commands and OAuth flows arriving as `extension_ui_request` frames (URL elicitation) — plus a read-only "logged in as…" affordance per provider.

Any app-side credential management was rejected: it would duplicate omp's store, create a second source of truth for the most sensitive bytes in the system, and break the shared-with-the-CLI property that makes sessions portable between the app and the terminal.
