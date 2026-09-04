/**
 * Serializes a Settings control's value into the raw CLI string
 * `omp config set <key> <value>` expects (ADR-0011 contract §C: "value
 * passed to `config_set` is the raw CLI string omp expects: TS serializes
 * booleans/numbers/enums/strings as plain text and arrays/records as JSON
 * text"). `valueType` is a `ConfigEntry`/`SchemaEntry`'s
 * `"boolean" | "string" | "number" | "enum" | "array" | "record"`.
 */
export function serializeConfigValue(valueType: string, value: unknown): string {
  switch (valueType) {
    case "array":
    case "record":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    default:
      // "string" | "enum" | "number" (and any future type) are plain text —
      // omp's own per-type parser (`config-cli.ts`'s `parseAndSetValue`)
      // does the real validation; this only needs to produce the text a
      // human typing at the CLI would.
      return String(value);
  }
}
