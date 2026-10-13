/**
 * Tool calls written as message text: the Responses-API leak shape.
 *
 * GPT-5-family models are trained on the Harmony format, where a tool call is
 * a `commentary` message addressed to a recipient (`to=functions.<tool>`).
 * The server turns that header into a `function_call` item. When the model
 * puts the recipient in the body instead of the header, the server sees no
 * call and streams the attempt as an ordinary assistant message:
 *
 *     {"status":"Creating the site files."} for functions.progress
 *
 * Passed through, that JSON reaches the user as interim narration and is
 * replayed to the model as its own words on the next request. This guard keys
 * on the structural marker, never on wording:
 *
 *   - Only a message that OPENS like a call (a JSON object, a `to=functions.`
 *     header, or a raw Harmony control token) is held back. Anything else
 *     streams through untouched, delta by delta.
 *   - A held message is a leak only if, outside its JSON object, it addresses
 *     `functions.<tool>` for a tool offered in this request. Otherwise it is
 *     released unchanged: a JSON answer is still an answer.
 *   - A leak that is exactly one JSON object plus that recipient (and Harmony
 *     header words) is a well-formed call the caller can recover. Anything
 *     else, such as the model narrating its own format confusion, is a leak
 *     with no call: the caller drops it.
 */

/** How a message that may be a call has to start before it is held back. */
const CALL_OPENERS = ['{', 'to=functions.', '<|'] as const;

/** A Harmony recipient. The lookbehind keeps `cloud.functions.x` and `myfunctions.x` out. */
const RECIPIENT = /(?<![\w.])(?:to=)?functions\.([A-Za-z0-9_-]+)/g;

/** Raw Harmony control tokens (`<|constrain|>`, `<|message|>`, `<|call|>`, ...). */
const CONTROL_TOKEN = /<\|[a-z_]+\|>/g;

/** Header words that may surround a well-formed call: `commentary`, `<|constrain|>json`, ... */
const HEADER_WORDS: ReadonlySet<string> = new Set(['for', 'json', 'code', 'commentary', 'assistant']);

/** A message that turned out to be a tool call written as text. */
export interface TextToolCallLeak {
    /** The text withheld from the visible stream. */
    readonly text: string;
    /** The call it encodes when it is well-formed: the wire tool name and the raw JSON arguments. */
    readonly call?: { readonly name: string; readonly arguments: string };
}

/** What a finished message item settles into. */
export type TextToolCallVerdict =
    | { readonly kind: 'release'; readonly text: string }
    | { readonly kind: 'leak'; readonly leak: TextToolCallLeak };

interface HeldItem {
    state: 'pending' | 'stream' | 'hold';
    buffer: string;
}

/** Per-request guard over the text of each assistant message item. */
export class TextToolCallGuard {
    private readonly items = new Map<string, HeldItem>();

    /** @param toolNames wire names of the function tools offered in this request */
    constructor(private readonly toolNames: ReadonlySet<string>) {}

    /** Feed one text delta of a message item. Returns the text that is safe to show now ('' while held). */
    push(key: string, delta: string): string {
        // No tools offered: the model has nothing to call, so nothing to hold.
        if (this.toolNames.size === 0) return delta;

        let item = this.items.get(key);
        if (!item) {
            item = { state: 'pending', buffer: '' };
            this.items.set(key, item);
        }
        if (item.state === 'stream') return delta;

        item.buffer += delta;
        if (item.state === 'hold') return '';

        const head = item.buffer.trimStart();
        if (CALL_OPENERS.some(opener => head.startsWith(opener))) {
            item.state = 'hold';
            return '';
        }
        // Still a possible prefix of an opener (`t`, `to=fun`, `<`): wait for more.
        if (head === '' || CALL_OPENERS.some(opener => opener.startsWith(head))) return '';

        item.state = 'stream';
        const released = item.buffer;
        item.buffer = '';
        return released;
    }

    /** The message item ended: release what it held, or report the leak it turned out to be. */
    end(key: string): TextToolCallVerdict {
        const item = this.items.get(key);
        this.items.delete(key);
        if (!item) return { kind: 'release', text: '' };
        if (item.state !== 'hold') return { kind: 'release', text: item.buffer };
        return classifyHeldText(item.buffer, this.toolNames);
    }

    /** Items still open, e.g. when the stream ended without their `output_item.done`. */
    openKeys(): string[] {
        return [...this.items.keys()];
    }
}

/** Decide whether held message text is a tool call written as text. */
export function classifyHeldText(text: string, toolNames: ReadonlySet<string>): TextToolCallVerdict {
    const object = leadingJsonObject(text);
    const outside = object ? `${text.slice(0, object.start)} ${text.slice(object.end)}` : text;
    const recipients = [...outside.matchAll(RECIPIENT)].map(match => match[1] ?? '');
    const offered = recipients.filter(name => toolNames.has(name));
    if (offered.length === 0) return { kind: 'release', text };

    const leftover = outside.replace(RECIPIENT, ' ').replace(CONTROL_TOKEN, ' ').split(/\s+/).filter(Boolean);
    const oneCall = offered.length === recipients.length
        && new Set(offered).size === 1
        && leftover.every(word => HEADER_WORDS.has(word));

    if (!object || !oneCall) return { kind: 'leak', leak: { text } };
    return {
        kind: 'leak',
        leak: { text, call: { name: offered[0] ?? '', arguments: text.slice(object.start, object.end) } },
    };
}

/** The first balanced `{...}` in the text, when it parses as a plain JSON object. */
function leadingJsonObject(text: string): { start: number; end: number } | null {
    const start = text.indexOf('{');
    if (start < 0) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') inString = true;
        else if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) {
            try {
                const value: unknown = JSON.parse(text.slice(start, i + 1));
                const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
                return isObject ? { start, end: i + 1 } : null;
            } catch {
                return null;
            }
        }
    }
    return null;
}
