//! Models section bridge command (issue #19/#27; ADR-0011 "Bespoke
//! sections"): the model catalog `omp models --json` reports, shelled out
//! through `run_omp_json` like every other omp-backed bridge (`config.rs`
//! #24, `auth.rs` #25). This module is read-only — enable/disable state
//! and role assignment are the `enabledModels`/`disabledProviders`/
//! `modelRoles` global config keys, read and written through the config
//! bridge (`config.rs`), never a second store here — ADR-0011's "no key
//! ever has two editors" is exactly what this split avoids.

use crate::omp_cli::{blocking, run_omp_json, CliError};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;

/// Per-model token cost, USD per million tokens (`omp models --json`'s
/// `cost` object; note `04-omp-cli-surface.md` §6).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ModelCost {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

/// One entry from `omp models --json`'s flat `models` array. Only the
/// fields the Models section renders are modeled here (provider grouping,
/// id/name/selector, context window and cost in mono) — `maxTokens`,
/// `reasoning`, `thinking`, `input` exist on omp's own `ModelEntry` but are
/// omitted since no row in this section shows them.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    /// Provider id, e.g. `"anthropic"` — omp's catalog carries no separate
    /// per-provider display name, so the GUI groups by and labels with
    /// this id directly.
    pub provider: String,
    pub id: String,
    /// `"<provider>/<id>"` — the canonical string `enabledModels` patterns
    /// and `modelRoles` values use everywhere else in config.
    pub selector: String,
    pub name: String,
    /// `f64`, not `u64`: specta-typescript refuses to export 64-bit
    /// integer types at all (its BigInt guard — see `config.rs`'s
    /// `JsonValue` doc comment for the same tradeoff). Token counts here
    /// are well under 2^53, so this loses no precision.
    pub context_window: f64,
    pub cost: ModelCost,
}

/// `omp models --json`'s exact envelope (note `04-omp-cli-surface.md` §6):
/// `{ "models": [...] }`, a flat array not grouped by provider — the
/// Models section groups it client-side. Deserializes directly from omp's
/// raw JSON output (field names already match; no intermediate wire type
/// is needed, unlike `config.rs`'s `RawConfigValue`).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ModelsCatalog {
    pub models: Vec<ModelEntry>,
}

/// omp's own model catalog (ADR-0011 "Bespoke sections"): every model
/// across every provider with at least one credential present. Returns
/// `{ models: [] }` — not an error — when omp has no credentials
/// configured at all (note `04-omp-cli-surface.md` §6); the Models section
/// renders that as an empty catalog, not a degraded state.
///
/// `async`, delegating to `blocking` (`omp_cli.rs`): Tauri runs non-async
/// commands on the main thread, which would freeze the webview for the
/// duration of the `omp models` subprocess.
#[tauri::command]
#[specta::specta]
pub async fn models_list(app: AppHandle) -> Result<ModelsCatalog, CliError> {
    blocking(move || run_omp_json(&app, &["models", "--json"])).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_captured_models_json_shape() {
        let raw = r#"{"models":[{"provider":"anthropic","id":"claude-3-5-sonnet-20240620","selector":"anthropic/claude-3-5-sonnet-20240620","name":"Claude Sonnet 3.5","contextWindow":200000,"maxTokens":8192,"reasoning":false,"thinking":null,"input":["text","image"],"cost":{"input":3,"output":15,"cacheRead":0.3,"cacheWrite":3.75}}]}"#;
        let catalog: ModelsCatalog = serde_json::from_str(raw).unwrap();
        assert_eq!(catalog.models.len(), 1);
        let model = &catalog.models[0];
        assert_eq!(model.provider, "anthropic");
        assert_eq!(model.selector, "anthropic/claude-3-5-sonnet-20240620");
        assert_eq!(model.context_window, 200_000.0);
        assert_eq!(model.cost.cache_write, 3.75);
    }
}
