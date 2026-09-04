//! Accounts section bridge commands (issue #25): the provider catalog omp
//! knows about (`omp auth-broker list --json`), each provider's stored
//! OAuth accounts (`omp token <provider> --list`, run once per provider —
//! the CLI has no single "list every stored account across every provider"
//! call, see `parse_account_lines` below), and logging a provider out.
//! Login is deliberately not implemented here: it reuses the existing
//! rpc-ui login pass-through (`platform/ipc/src/session/login.ts`,
//! ADR-0009) on whichever session is active — the RPC protocol has a
//! `login` command but no `logout` one, so logout is the one Accounts
//! action this crate shells out for directly (`omp auth-broker logout
//! <provider>`, which needs no running session at all — it only touches
//! the credential store).

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;

use crate::omp_cli::{CliError, blocking, run_omp_cli, run_omp_json};

/// One OAuth/credential provider omp's auth broker knows about, exactly as
/// `omp auth-broker list --json` reports it (69 entries as of the pin this
/// was captured against — LLM providers, web-search providers, and local
/// OpenAI-compatible servers alike; not just chat-model providers).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthProvider {
    pub id: String,
    pub name: String,
}

/// One stored OAuth account for a provider, parsed from `omp token
/// <provider> --list`'s text output (`"<position>. <identity>"` per line —
/// `token` has no `--json` flag). `position` is the 1-based index `omp
/// token <provider> --account <position>` expects.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthAccount {
    pub provider_id: String,
    pub position: u32,
    pub identity: String,
}

/// Parses `omp token <provider> --list`'s stdout defensively: one `"N.
/// label"` line per stored account (`label` is the account's email,
/// account/project id, enterprise URL, or `credential #<id>` fallback,
/// optionally suffixed with `(org)` — see `commands/token.ts`'s `run()`).
/// A line that doesn't start with a number-dot prefix is skipped rather
/// than failing the whole parse, since this is text output with no schema
/// guarantee, not JSON.
fn parse_account_lines(stdout: &str, provider_id: &str) -> Vec<AuthAccount> {
    let mut accounts = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Some(dot) = line.find('.') else {
            continue;
        };
        let (num, rest) = line.split_at(dot);
        let Ok(position) = num.trim().parse::<u32>() else {
            continue;
        };
        let identity = rest[1..].trim();
        if identity.is_empty() {
            continue;
        }
        accounts.push(AuthAccount {
            provider_id: provider_id.to_string(),
            position,
            identity: identity.to_string(),
        });
    }
    accounts
}

/// List every OAuth/credential provider omp knows about (Accounts section
/// row set — one row per provider regardless of login state).
#[tauri::command]
#[specta::specta]
pub async fn auth_providers_list(app: AppHandle) -> Result<Vec<AuthProvider>, CliError> {
    blocking(move || run_omp_json(&app, &["auth-broker", "list", "--json"])).await
}

/// List every stored OAuth account across every provider. `omp token` has
/// no bulk-listing mode (`--list` requires a provider positional argument),
/// so this calls it once per provider from the same `auth-broker list
/// --json` catalog and aggregates; a provider with nothing stored (the
/// common case — `token <provider> --list` exits non-zero with "No OAuth
/// accounts found…") contributes no rows rather than failing the whole
/// list. Only a failure to resolve/spawn the binary at all propagates, so
/// one CLI quirk on one of ~70 providers can never blank the section.
#[tauri::command]
#[specta::specta]
pub async fn auth_accounts_list(app: AppHandle) -> Result<Vec<AuthAccount>, CliError> {
    blocking(move || list_accounts(&app)).await
}

fn list_accounts(app: &AppHandle) -> Result<Vec<AuthAccount>, CliError> {
    let providers: Vec<AuthProvider> = run_omp_json(app, &["auth-broker", "list", "--json"])?;
    let mut accounts = Vec::new();
    for provider in &providers {
        match run_omp_cli(app, &["token", &provider.id, "--list"]) {
            Ok(output) => accounts.extend(parse_account_lines(&output.stdout, &provider.id)),
            Err(CliError::Rejected { .. }) => {
                // No accounts stored for this provider (or some other
                // per-provider refusal) — not fatal to the aggregate list.
                // `auth-broker list` is authoritative for what providers
                // exist; a provider nobody has logged into simply
                // contributes zero rows.
            }
            Err(err @ CliError::Unavailable { .. }) => return Err(err),
        }
    }
    Ok(accounts)
}

/// Log a provider out of omp's own credential store. There is no RPC
/// equivalent (`login` exists on the rpc-ui protocol, `logout` does not),
/// and unlike `login` this needs no OAuth round trip or running session —
/// it's a direct credential-store mutation, always safe to shell out for.
/// `omp auth-broker logout <id>` succeeds unconditionally (even for a
/// provider with nothing stored), so this only ever fails via the usual
/// `CliError` paths (binary unresolvable/unspawnable).
#[tauri::command]
#[specta::specta]
pub async fn auth_logout(app: AppHandle, provider_id: String) -> Result<(), CliError> {
    blocking(move || run_omp_cli(&app, &["auth-broker", "logout", &provider_id]).map(|_| ())).await
}
