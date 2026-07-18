/**
 * Tool-argument coercion + validation for small models.
 *
 * 9–12B-class models routinely emit *almost* correct tool calls: a number as a
 * string, a single value where an array is expected, a JSON-encoded object as a
 * string, or the right values under the wrong keys. Large models don't; small
 * ones do, and it is the difference between a small model being usable in
 * production or not.
 *
 * This module is the provider-agnostic fix, used by both the library's own tool
 * loop and BentoKit core (which imports it directly). It does two things,
 * driven ENTIRELY by the tool's declared JSON-Schema `parameters` — never by a
 * hardcoded per-tool key map (that would be overfitting):
 *
 *   1. **Coerce** the unambiguous cases: `"5"` → `5` for a `number`; `"true"` →
 *      `true` for a `boolean`; a scalar → `[scalar]` for an `array`; a JSON
 *      string of an object → the object. Coercion is loss-free and only applies
 *      when the declared `type` makes the intent unambiguous.
 *   2. **Validate + explain**: when a call is missing a `required` field,
 *      violates an `enum`, or carries a value no coercion can rescue, return a
 *      crisp, model-actionable error naming the expected keys and types and the
 *      keys the model actually sent. A small model self-corrects on the next
 *      turn when told exactly this — far better than the opaque handler error
 *      (`invalid_action`) it would otherwise get, or the bare `null` the old
 *      loop fed back.
 *
 * **Fail-open by construction.** Anything the validator does not fully
 * understand — a property with no declared `type`, `oneOf`/`anyOf`/`$ref`
 * composition, a schema that isn't a plain object — passes through untouched and
 * is NEVER blocked. The only hard failures are simple, certain violations. This
 * is what lets it ship in front of every tool without false-blocking a
 * legitimate call; the tool-reliability benchmark's A/B gate is what proves it.
 */

/** The subset of a JSON-Schema property this coercer reasons about. */
interface PropertySchema {
    readonly type?: string | readonly string[];
    readonly enum?: readonly (string | number | boolean | null)[];
    readonly items?: unknown;
}

/** The tool `parameters` object (JSON Schema, `type: "object"`). */
export interface ToolParameterSchema {
    readonly type?: string;
    readonly properties?: Record<string, unknown>;
    readonly required?: readonly string[];
}

export interface ToolArgCoercionResult {
    /** The (possibly coerced) argument object to hand to the tool. */
    readonly args: Record<string, unknown>;
    /**
     * Set only on a hard validation failure. When present, the caller should
     * NOT run the handler — it should return this string to the model as the
     * tool result so the model retries with a corrected call.
     */
    readonly error?: string;
    /** True if any value was coerced (for telemetry/debug — not an error). */
    readonly corrected: boolean;
    /** Human-readable notes on what was coerced or flagged (debug/telemetry). */
    readonly notes: readonly string[];
}

/** Parse the raw `arguments` payload into an object, tolerating double-encoding. */
export function parseToolArguments(raw: unknown): Record<string, unknown> {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        return raw as Record<string, unknown>;
    }
    if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (!trimmed) return {};
        try {
            const parsed = JSON.parse(trimmed) as unknown;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                return parsed as Record<string, unknown>;
            }
        } catch {
            // Not JSON — fall through to empty; validation will report missing
            // required fields, which is the actionable signal.
        }
    }
    return {};
}

function normalizeTypes(type: PropertySchema["type"]): readonly string[] {
    if (typeof type === "string") return [type];
    if (Array.isArray(type)) return type.filter((t): t is string => typeof t === "string");
    return [];
}

function propSchema(value: unknown): PropertySchema | undefined {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as PropertySchema;
    }
    return undefined;
}

/** Coerce a single value toward one of the schema-declared types. */
function coerceValue(
    value: unknown,
    types: readonly string[],
): { readonly value: unknown; readonly coerced: boolean; readonly uncoercible: boolean } {
    // Already matches an allowed type → leave it. `null` matches "null"; arrays
    // are "array"; everything else via typeof.
    const jsType = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    const allows = (t: string): boolean => types.includes(t);
    if (types.length === 0) return { value, coerced: false, uncoercible: false };
    if (
        (jsType === "array" && allows("array")) ||
        (jsType === "null" && allows("null")) ||
        (jsType === "object" && allows("object")) ||
        (jsType === "string" && allows("string")) ||
        (jsType === "number" && (allows("number") || allows("integer"))) ||
        (jsType === "boolean" && allows("boolean"))
    ) {
        return { value, coerced: false, uncoercible: false };
    }

    // number / integer from a numeric string
    if ((allows("number") || allows("integer")) && typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed !== "" && Number.isFinite(Number(trimmed))) {
            const n = Number(trimmed);
            return { value: allows("integer") && !allows("number") ? Math.trunc(n) : n, coerced: true, uncoercible: false };
        }
    }
    // boolean from a stringified / numeric boolean
    if (allows("boolean")) {
        if (value === "true" || value === 1 || value === "1") return { value: true, coerced: true, uncoercible: false };
        if (value === "false" || value === 0 || value === "0") return { value: false, coerced: true, uncoercible: false };
    }
    // object from a JSON string
    if (allows("object") && typeof value === "string") {
        try {
            const parsed = JSON.parse(value) as unknown;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                return { value: parsed, coerced: true, uncoercible: false };
            }
        } catch {
            /* fall through */
        }
    }
    // array: a JSON-string array, else wrap a lone scalar
    if (allows("array")) {
        if (typeof value === "string") {
            try {
                const parsed = JSON.parse(value) as unknown;
                if (Array.isArray(parsed)) return { value: parsed, coerced: true, uncoercible: false };
            } catch {
                /* fall through to wrap */
            }
        }
        if (value !== undefined && value !== null) return { value: [value], coerced: true, uncoercible: false };
    }
    // string from a scalar (safe last resort when a string is acceptable)
    if (allows("string") && (typeof value === "number" || typeof value === "boolean")) {
        return { value: String(value), coerced: true, uncoercible: false };
    }

    return { value, coerced: false, uncoercible: true };
}

/** Levenshtein distance (small, pure) for "did you mean" hints only. */
function editDistance(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    let curr = new Array<number>(n + 1);
    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
        }
        [prev, curr] = [curr, prev];
    }
    return prev[n]!;
}

function describeProperty(name: string, schema: PropertySchema | undefined): string {
    if (!schema) return name;
    if (schema.enum && schema.enum.length > 0) {
        return `${name} (one of ${schema.enum.map((v) => String(v)).join("|")})`;
    }
    const types = normalizeTypes(schema.type);
    return types.length > 0 ? `${name} (${types.join("|")})` : name;
}

/**
 * Coerce and validate model-supplied tool arguments against the tool's declared
 * JSON-Schema `parameters`. Pure and fail-open — see the module doc.
 *
 * Only reasons about model-supplied keys; harness-injected fields (the
 * `_`-prefixed metadata BentoKit adds *after* this runs) are never seen here and
 * are never `required`.
 */
export function coerceAndValidateToolArgs(
    rawArgs: unknown,
    schema: ToolParameterSchema | undefined,
    toolName: string,
): ToolArgCoercionResult {
    const args = parseToolArguments(rawArgs);
    const notes: string[] = [];

    const properties = schema?.properties;
    if (!properties || typeof properties !== "object") {
        // No schema to reason about → pass through untouched (fail-open).
        return { args, corrected: false, notes };
    }

    const out: Record<string, unknown> = { ...args };
    let corrected = false;
    const enumViolations: string[] = [];
    const typeViolations: string[] = [];

    for (const [key, rawProp] of Object.entries(properties)) {
        if (!(key in out)) continue;
        const prop = propSchema(rawProp);
        if (!prop) continue;
        const value = out[key];

        const types = normalizeTypes(prop.type);
        if (types.length > 0 && value !== undefined) {
            const c = coerceValue(value, types);
            if (c.coerced) {
                out[key] = c.value;
                corrected = true;
                notes.push(`coerced "${key}" to ${types.join("|")}`);
            } else if (c.uncoercible) {
                typeViolations.push(`${key} must be ${types.join("|")}`);
            }
        }

        // enum check runs on the (possibly coerced) value.
        if (prop.enum && prop.enum.length > 0) {
            const v = out[key];
            if (!prop.enum.some((e) => e === v)) {
                enumViolations.push(`${key} must be one of ${prop.enum.map((e) => String(e)).join("|")}`);
            }
        }
    }

    // Missing required (after coercion). `undefined`/`null`/`""` all count as absent.
    const required = schema?.required ?? [];
    const missing = required.filter((k) => {
        const v = out[k];
        return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
    });

    if (missing.length === 0 && enumViolations.length === 0 && typeViolations.length === 0) {
        return { args: out, corrected, notes };
    }

    // Build one self-correcting message. This is the highest-value output: a
    // small model reliably fixes the call when handed exactly this.
    const expected = Object.entries(properties)
        .map(([name, p]) => {
            const isReq = required.includes(name);
            return `${isReq ? "" : "optional "}${describeProperty(name, propSchema(p))}`;
        })
        .join(", ");
    const sentKeys = Object.keys(args);

    const parts: string[] = [`Invalid arguments for ${toolName}.`];
    if (missing.length > 0) parts.push(`Missing required: ${missing.join(", ")}.`);
    if (enumViolations.length > 0) parts.push(enumViolations.join("; ") + ".");
    if (typeViolations.length > 0) parts.push(typeViolations.join("; ") + ".");
    parts.push(`Expected: ${expected}.`);
    parts.push(sentKeys.length > 0 ? `You sent keys: [${sentKeys.join(", ")}].` : "You sent no arguments.");

    // "Did you mean" hints: an unknown key close to a missing required key.
    const knownKeys = new Set(Object.keys(properties));
    const hints: string[] = [];
    for (const sent of sentKeys) {
        if (knownKeys.has(sent)) continue;
        for (const want of missing) {
            const d = editDistance(sent.toLowerCase(), want.toLowerCase());
            if (d > 0 && d <= Math.max(1, Math.floor(want.length / 3))) {
                hints.push(`"${sent}" → "${want}"?`);
            }
        }
    }
    if (hints.length > 0) parts.push(`Did you mean ${hints.join(" ")}`);
    parts.push("Call the tool again with the corrected arguments.");

    return { args: out, corrected, notes, error: parts.join(" ") };
}
