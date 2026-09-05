//! Config bridge (ADR-0011, issue #19/#24): the Settings page's sole
//! transport for omp's own configuration. Every value shown and every
//! write flows through `omp config list|set|reset|unset|schema --json` via
//! `run_omp_cli`/`run_omp_json` (`omp_cli.rs`) — this crate holds no
//! settings store of its own (`gui/CONTEXT.md`'s Settings definition: "the
//! app reads and writes it only through omp, never keeping a copy").
//! `run_omp_cli` pins the working directory to a scratch directory, so
//! every call here is global-only by construction (ADR-0011 §"Scope").
//!
//! `browser.rs`'s Relay toggle is migrated onto this same helper
//! (`browser_set_relay`/`disable_relay` now call `write_value`/
//! `unset_value` here instead of shelling out from the home directory) so
//! there is exactly one `omp config` invocation path in this crate.

use crate::omp_cli::{CliError, blocking, run_omp_cli, run_omp_json};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;
use tauri::AppHandle;

/// A minimal JSON value good enough for arbitrary config values,
/// defaults, and condition operands — a hand-rolled analog of
/// `serde_json::Value` whose `Number` variant is a plain `f64` rather
/// than `serde_json::Number`'s internal i64/u64 representation, which
/// `specta-typescript` refuses to export at all (its BigInt guard: 64-bit
/// integers get silently truncated by `JSON.parse`, so specta forces an
/// explicit, lossy-but-safe choice — see `specta_typescript::Error`'s
/// "BigInt Forbidden" docs). Every value flowing through this bridge is a
/// user-facing setting, never an opaque 64-bit id, so `f64` is exact for
/// anything that matters here. Deserializes directly from omp's raw JSON
/// output (`run_omp_json` parses straight into this type — there is no
/// intermediate `serde_json::Value` step).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(untagged)]
pub enum JsonValue {
    Null(()),
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<JsonValue>),
    Object(BTreeMap<String, JsonValue>),
}

/// One entry from `omp config list --json`, keyed by dotted setting path
/// (e.g. `browser.relay`). `value` is `None` when the setting has never
/// been explicitly overridden (its default applies) or when `redacted` is
/// true — omp never echoes a credential-shaped value even when set.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConfigEntry {
    pub key: String,
    pub value: Option<JsonValue>,
    /// `"boolean" | "string" | "number" | "enum" | "array" | "record"`.
    pub value_type: String,
    pub description: String,
    #[serde(default)]
    pub redacted: bool,
}

/// Wire shape of one value in `omp config list --json`'s object — field
/// names exactly as omp emits them (`type`, not `valueType`), kept private
/// so `ConfigEntry`'s own field naming can follow this crate's camelCase
/// convention instead of omp's.
#[derive(Debug, Deserialize)]
struct RawConfigValue {
    #[serde(default)]
    value: Option<JsonValue>,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    redacted: bool,
}

/// `omp config schema --json`'s envelope (ADR-0011 §"schema/structure";
/// contract `00-contracts.md` §F). Consumed by #26 for the schema-driven
/// omp tabs; #24 only needs it to exist and degrade gracefully on an
/// override binary that predates it (`CliError::Unavailable{stage:Parse}`
/// on an old binary's missing `schema` action, or `{stage:Rejected}` on a
/// binary whose `--help` doesn't even list the action).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSchema {
    pub version: String,
    pub tabs: Vec<SchemaTab>,
    pub settings: Vec<SchemaEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SchemaTab {
    pub id: String,
    pub label: String,
    pub groups: Vec<String>,
}

/// Declarative visibility condition (ADR-0011 §"schema/structure",
/// contract §F): evaluated live in the app against the values the binary
/// reports, never baked in at build time.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SchemaCondition {
    #[serde(rename_all = "camelCase")]
    Setting {
        depends_on: String,
        equals: JsonValue,
    },
    Platform {
        platform: String,
    },
    Terminal {
        capability: String,
    },
}

/// One `SETTINGS_SCHEMA` entry with its UI metadata. `tab`/`group`/`label`/
/// `description` are `None` for keys omp's own settings panel never shows
/// (the Advanced-only keys, issue #19 story #16); `options` carries either
/// an array of `{ value, label, description? }` submenu choices, the
/// literal string `"runtime"` (choices the app itself resolves — e.g.
/// installed theme names), or `null` — left as raw JSON rather than a
/// second Rust enum since no bridge command here branches on its shape.
/// `values` (enum choices) is additive beyond the contract's field list:
/// `config list --json` never carries it (note `04-omp-cli-surface.md`
/// §1), so this is the only source of enum choices for a generic editor.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SchemaEntry {
    pub key: String,
    #[serde(rename = "type")]
    pub value_type: String,
    pub default: Option<JsonValue>,
    pub values: Option<Vec<String>>,
    pub tab: Option<String>,
    pub group: Option<String>,
    pub label: Option<String>,
    pub description: Option<String>,
    pub warning: Option<String>,
    pub options: Option<JsonValue>,
    #[serde(default)]
    pub ordered: bool,
    #[serde(default)]
    pub secret: bool,
    pub condition: Option<SchemaCondition>,
}

/// `omp config list --json`, mapped into the crate's own `ConfigEntry`
/// shape and ordered by key (the source object is already key-ordered by
/// `BTreeMap`, so no extra sort is needed).
fn list_entries(app: &AppHandle) -> Result<Vec<ConfigEntry>, CliError> {
    let raw: BTreeMap<String, RawConfigValue> = run_omp_json(app, &["config", "list", "--json"])?;
    Ok(raw
        .into_iter()
        .map(|(key, v)| ConfigEntry {
            key,
            value: v.value,
            value_type: v.kind,
            description: v.description,
            redacted: v.redacted,
        })
        .collect())
}

/// Re-reads the list after a `set`/`reset` and returns the one entry that
/// changed. `omp config set|reset --json` only echoes `{key, value}` (note
/// `04-omp-cli-surface.md` §3-4) — never `type`/`description` — so a
/// re-list is how the full `ConfigEntry` the row needs comes back.
fn entry_after(app: &AppHandle, key: &str) -> Result<ConfigEntry, CliError> {
    list_entries(app)?
        .into_iter()
        .find(|entry| entry.key == key)
        .ok_or_else(|| CliError::Unavailable {
            stage: crate::omp_cli::CliStage::Parse,
            message: format!("omp config list --json has no entry for \"{key}\" after the write"),
        })
}

/// List every setting omp's global config recognizes, current value
/// included. Scope is global-only: `run_omp_cli` runs from a scratch
/// directory, so a project's `.claude/settings.json` can never leak in.
#[tauri::command]
#[specta::specta]
pub async fn config_list(app: AppHandle) -> Result<Vec<ConfigEntry>, CliError> {
    blocking(move || list_entries(&app)).await
}

/// Set `key` to `value` (the raw CLI string omp expects for that key's
/// type — plain text for boolean/number/enum/string, JSON text for
/// array/record; `platform/ipc/src/settings/serialize.ts` produces it) and
/// return the entry as it now reads. Rejects with omp's own validation
/// message (`CliError::Rejected`) for an unknown key or a mistyped value.
///
/// Crate-visible so `browser.rs`'s Relay toggle (`browser.relay`) and its
/// connected-CDP-URL write can go through this same lever instead of
/// their own `omp config` shell-outs. Callers that don't need the
/// resulting `ConfigEntry` (a fire-and-forget best-effort write) should
/// use `write_value` instead — it skips the follow-up `config list`
/// read-back this function does via `entry_after`.
pub(crate) fn set_value(app: &AppHandle, key: &str, value: &str) -> Result<ConfigEntry, CliError> {
    run_omp_cli(app, &["config", "set", key, value, "--json"])?;
    entry_after(app, key)
}

/// Set `key` to `value` with exactly one `omp config` invocation — no
/// follow-up `config list` read-back. For callers that only need the
/// write to take effect, not the `ConfigEntry` it produced (`browser.rs`'s
/// relay/CDP-config writes, which are best-effort and discard the
/// result): a synchronous caller on the main thread should never pay for
/// two shell-outs when one suffices.
pub(crate) fn write_value(app: &AppHandle, key: &str, value: &str) -> Result<(), CliError> {
    run_omp_cli(app, &["config", "set", key, value, "--json"]).map(|_| ())
}

#[tauri::command]
#[specta::specta]
pub async fn config_set(
    app: AppHandle,
    key: String,
    value: String,
) -> Result<ConfigEntry, CliError> {
    blocking(move || set_value(&app, &key, &value)).await
}

/// Restore `key` to omp's current schema default and return the entry.
/// Crate-visible for the same reason as `set_value` — disabling Relay
/// resets `browser.relay` through this lever. Callers that discard the
/// resulting entry should use `unset_value` instead.
pub(crate) fn reset_value(app: &AppHandle, key: &str) -> Result<ConfigEntry, CliError> {
    run_omp_cli(app, &["config", "reset", key, "--json"])?;
    entry_after(app, key)
}

/// Restore `key` to omp's current schema default with exactly one `omp
/// config` invocation — no follow-up `config list` read-back. The
/// `write_value` counterpart for callers that only care that the reset
/// happened (`browser.rs`'s relay/CDP-config clears).
pub(crate) fn unset_value(app: &AppHandle, key: &str) -> Result<(), CliError> {
    run_omp_cli(app, &["config", "reset", key, "--json"]).map(|_| ())
}

#[tauri::command]
#[specta::specta]
pub async fn config_reset(app: AppHandle, key: String) -> Result<ConfigEntry, CliError> {
    blocking(move || reset_value(&app, &key)).await
}

/// Remove `key` from the global config file entirely (distinct from
/// `config_reset`, which writes an explicit default value in the record
/// itself).
#[tauri::command]
#[specta::specta]
pub async fn config_unset(app: AppHandle, key: String) -> Result<(), CliError> {
    blocking(move || run_omp_cli(&app, &["config", "unset", &key, "--json"]).map(|_| ())).await
}

/// The running binary's own description of its settings surface — tabs,
/// groups, labels, descriptions, options, and declarative conditions
/// (ADR-0011 §"schema/structure"). #26 renders the omp-tab sections from
/// this; an override binary predating `config schema` degrades that
/// section to Advanced-only, per ADR-0011's fallback paragraph.
#[tauri::command]
#[specta::specta]
pub async fn config_schema(app: AppHandle) -> Result<ConfigSchema, CliError> {
    blocking(move || run_omp_json(&app, &["config", "schema", "--json"])).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_value_round_trips_every_shape() {
        let parsed: JsonValue =
            serde_json::from_str(r#"{"a":null,"b":true,"c":1.5,"d":"text","e":[1,null,"x"]}"#)
                .unwrap();
        let JsonValue::Object(obj) = parsed else {
            panic!("expected an object");
        };
        assert!(matches!(obj.get("a"), Some(JsonValue::Null(()))));
        assert!(matches!(obj.get("b"), Some(JsonValue::Bool(true))));
        assert!(matches!(obj.get("c"), Some(JsonValue::Number(n)) if *n == 1.5));
        assert!(matches!(obj.get("d"), Some(JsonValue::String(s)) if s == "text"));
        assert!(matches!(obj.get("e"), Some(JsonValue::Array(items)) if items.len() == 3));
    }

    /// Matches `omp config list --json`'s exact per-key shape (note
    /// `04-omp-cli-surface.md` §1, §10): a plain entry with a `value`, an
    /// unset credential-shaped entry with `value` omitted entirely, and
    /// the one `redacted: true` entry observed on the pinned binary
    /// (`images.urls.credentials`).
    #[test]
    fn raw_config_value_parses_the_real_list_shape() {
        let raw: BTreeMap<String, RawConfigValue> = serde_json::from_str(
            r#"{
                "autoResume": {"value": false, "type": "boolean", "description": "Auto Resume"},
                "auth.broker.url": {"type": "string", "description": ""},
                "images.urls.credentials": {"redacted": true, "type": "record", "description": ""}
            }"#,
        )
        .unwrap();

        let auto_resume = &raw["autoResume"];
        assert!(matches!(auto_resume.value, Some(JsonValue::Bool(false))));
        assert_eq!(auto_resume.kind, "boolean");
        assert!(!auto_resume.redacted);

        let unset = &raw["auth.broker.url"];
        assert!(unset.value.is_none());

        let redacted = &raw["images.urls.credentials"];
        assert!(redacted.value.is_none());
        assert!(redacted.redacted);
    }

    /// Matches `omp config schema --json`'s envelope and a `condition`
    /// entry exactly as the pinned 18.1.10 binary emits it — proves
    /// `depends_on`'s `#[serde(rename_all = "camelCase")]` on the
    /// `Setting` variant actually parses the wire's `dependsOn`, not just
    /// that specta's generated TS type says so.
    #[test]
    fn config_schema_parses_the_real_envelope_shape() {
        let schema: ConfigSchema = serde_json::from_str(
            r#"{
                "version": "18.1.10",
                "tabs": [{"id": "appearance", "label": "Appearance", "groups": ["Theme"]}],
                "settings": [
                    {
                        "key": "advisor.syncBacklog",
                        "type": "enum",
                        "default": "off",
                        "values": ["off", "1", "3", "5"],
                        "tab": "model",
                        "group": "Advisor",
                        "label": "Advisor Sync Backlog",
                        "description": "desc",
                        "warning": null,
                        "options": null,
                        "ordered": false,
                        "secret": false,
                        "condition": {"kind": "setting", "dependsOn": "advisor.enabled", "equals": true}
                    },
                    {
                        "key": "terminal.showImages",
                        "type": "boolean",
                        "default": true,
                        "values": null,
                        "tab": "appearance",
                        "group": "Images",
                        "label": "Show Inline Images",
                        "description": "desc",
                        "warning": null,
                        "options": null,
                        "ordered": false,
                        "secret": false,
                        "condition": {"kind": "terminal", "capability": "imageProtocol"}
                    }
                ]
            }"#,
        )
        .unwrap();

        assert_eq!(schema.tabs[0].id, "appearance");
        match &schema.settings[0].condition {
            Some(SchemaCondition::Setting { depends_on, equals }) => {
                assert_eq!(depends_on, "advisor.enabled");
                assert!(matches!(equals, JsonValue::Bool(true)));
            }
            other => panic!("expected a setting condition, got {other:?}"),
        }
        assert!(matches!(
            &schema.settings[1].condition,
            Some(SchemaCondition::Terminal { capability }) if capability == "imageProtocol"
        ));
    }
}
