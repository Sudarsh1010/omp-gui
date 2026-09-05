/**
 * Pure record-manipulation helpers for the bespoke Settings editors (#29,
 * issue #19 stories #27-29; ADR-0011 "Bespoke sections"): every write these
 * editors make is a full-record replacement through `SettingsController
 * .set`, so the only logic worth testing in isolation is deriving the next
 * record from the previous one — never the React wiring around it. Kept
 * framework-agnostic so the GUI components (`gui/src/components/settings/
 * bespoke/*`) stay thin dispatchers onto these.
 */

/** `tools.approval`'s value shape: per-tool override, honored in every
 * global approval mode (`tools.approvalMode`). An absent tool inherits the
 * global mode instead of one of these three. */
export type ToolPolicy = "allow" | "prompt" | "deny";
export type ToolApprovalRecord = Record<string, ToolPolicy>;

/** Sets or clears one tool's approval override. `policy` of `undefined`
 * removes the tool's entry entirely — the "inherits mode" / Clear state —
 * rather than writing a null, matching how every other key in the record
 * is either present with a policy or simply absent. Returns the same
 * reference when the write would be a no-op. */
export function setToolPolicy(
  record: ToolApprovalRecord,
  tool: string,
  policy: ToolPolicy | undefined,
): ToolApprovalRecord {
  if (policy === undefined) {
    if (!(tool in record)) return record;
    const next = { ...record };
    delete next[tool];
    return next;
  }
  if (record[tool] === policy) return record;
  return { ...record, [tool]: policy };
}

/** `retry.fallbackChains`'s value shape: a role, model selector, or
 * provider-wildcard key mapped to an ordered list of fallback selectors. */
export type FallbackChainsRecord = Record<string, string[]>;

export type ChainEntryMove = "up" | "down" | "remove";

/** Reorders or removes one chain entry by index. A no-op (returns the same
 * reference) for an out-of-range index or a boundary move (`"up"` at index
 * 0, `"down"` at the last index), so a caller never has to guard the call
 * itself. Removing the last entry in a chain drops the key entirely —
 * `key: []` is not a shape omp's own default (`{}`) would ever produce. */
export function moveChainEntry(
  record: FallbackChainsRecord,
  key: string,
  index: number,
  move: ChainEntryMove,
): FallbackChainsRecord {
  const chain = record[key];
  if (!chain || index < 0 || index >= chain.length) return record;

  if (move === "remove") {
    const next = chain.filter((_, i) => i !== index);
    if (next.length === 0) {
      const rest = { ...record };
      delete rest[key];
      return rest;
    }
    return { ...record, [key]: next };
  }

  const swapWith = move === "up" ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= chain.length) return record;
  const next = chain.slice();
  [next[index], next[swapWith]] = [next[swapWith], next[index]];
  return { ...record, [key]: next };
}

/** Appends `selector` to `key`'s chain, creating the key if it is not yet
 * present. A blank selector is a no-op — the "Add" control never writes an
 * empty string into a chain. */
export function addChainEntry(
  record: FallbackChainsRecord,
  key: string,
  selector: string,
): FallbackChainsRecord {
  const trimmed = selector.trim();
  if (!trimmed) return record;
  const chain = record[key] ?? [];
  return { ...record, [key]: [...chain, trimmed] };
}

/** Declares a new, initially empty chain key — the "Add key" input's
 * action for a custom `provider/*` wildcard or model selector. A no-op for
 * a blank or already-present key. */
export function addChainKey(record: FallbackChainsRecord, key: string): FallbackChainsRecord {
  const trimmed = key.trim();
  if (!trimmed || trimmed in record) return record;
  return { ...record, [trimmed]: [] };
}

/** Drops a chain key entirely — a row's own remove action, distinct from
 * `moveChainEntry`'s per-entry removal. */
export function removeChainKey(record: FallbackChainsRecord, key: string): FallbackChainsRecord {
  if (!(key in record)) return record;
  const rest = { ...record };
  delete rest[key];
  return rest;
}

/** `providers.maxInFlightRequests`'s value shape: provider id to a
 * positive concurrency ceiling. An omitted provider is unlimited (omp's
 * own schema description for the key). */
export type ProviderLimitsRecord = Record<string, number>;

/** Sets or clears one provider's limit. `limit` of `undefined` removes the
 * provider — the empty-input "no limit" state. `limit` is otherwise
 * trusted to already be a positive integer; `validateLimit` is the gate a
 * caller runs first, so this function itself never rejects a value. */
export function setProviderLimit(
  record: ProviderLimitsRecord,
  provider: string,
  limit: number | undefined,
): ProviderLimitsRecord {
  if (limit === undefined) {
    if (!(provider in record)) return record;
    const next = { ...record };
    delete next[provider];
    return next;
  }
  if (record[provider] === limit) return record;
  return { ...record, [provider]: limit };
}

export type LimitValidation =
  | { kind: "empty" }
  | { kind: "valid"; value: number }
  | { kind: "invalid"; message: string };

/** Validates a provider-limit input's raw text against omp's own rule
 * ("Provider request limits must be positive numbers", the `config set`
 * validator) before a write is even attempted. `"empty"` is the distinct
 * "clear this provider's limit" case a blank field means; `"invalid"` is
 * everything else that isn't a positive whole number — the editor renders
 * that as a rejected row and never calls `SettingsController.set` for it. */
export function validateLimit(text: string): LimitValidation {
  const trimmed = text.trim();
  if (trimmed === "") return { kind: "empty" };
  if (!/^\d+$/.test(trimmed)) {
    return { kind: "invalid", message: "Must be a positive whole number." };
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return { kind: "invalid", message: "Must be a positive whole number." };
  }
  return { kind: "valid", value };
}
