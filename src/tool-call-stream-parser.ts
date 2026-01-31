/**
 * Stream-based Tool Call Parser inspired by XMLStreamParser architecture
 * Handles both streaming and non-streaming tool call parsing with robust error handling
 */

import { EventEmitter } from 'events';
import type { LLMToolCall } from './interfaces.js';

export interface ToolCallEvent {
    type: 'tool_call' | 'text' | 'thinking' | 'error';
    toolCall?: LLMToolCall;
    content?: string;
    error?: string;
    timestamp: number;
}

export interface ToolCallParseResult {
    toolCalls: LLMToolCall[];
    textContent: string;
    events: ToolCallEvent[];
    stats: {
        totalToolCalls: number;
        totalTextBlocks: number;
        processingTimeMs: number;
        parsingErrors: number;
        eventCounts: Record<string, number>;
    };
}

export class ToolCallStreamParser extends EventEmitter {
    private buffer = '';
    private currentToolCallId = 0;

    constructor() {
        super();
    }

    /**
     * Parse tool calls from streaming content (similar to XMLStreamParser.process)
     * @param contentStream - AsyncIterable of content chunks or single content string
     * @returns Promise<ToolCallParseResult> - Complete parsing result with events and stats
     */
    async parse(contentStream: AsyncIterable<string> | string): Promise<ToolCallParseResult> {
        const startTime = Date.now();
        const events: ToolCallEvent[] = [];
        const toolCalls: LLMToolCall[] = [];
        let textContent = '';
        let parsingErrors = 0;
        const eventCounts: Record<string, number> = {
            tool_call: 0,
            text: 0,
            thinking: 0,
            error: 0
        };

        // Collect events during processing
        const originalEmit = this.emit.bind(this);
        this.emit = function (event: string, data?: any) {
            if (event === 'toolCallEvent') {
                events.push(data);
                const type = data.type;
                if (eventCounts[type] !== undefined) {
                    eventCounts[type]++;
                } else {
                    eventCounts[type] = 1;
                }

                if (data.type === 'tool_call' && data.toolCall) {
                    toolCalls.push(data.toolCall);
                } else if (data.type === 'text' && data.content) {
                    textContent += data.content + ' ';
                } else if (data.type === 'error') {
                    parsingErrors++;
                }
            }
            return originalEmit(event, data);
        };

        try {
            if (typeof contentStream === 'string') {
                // Handle single string content
                this.processToken(contentStream);
                this.finalize();
            } else {
                // Handle streaming content
                for await (const chunk of contentStream) {
                    if (chunk) {
                        this.processToken(chunk);
                    }
                }
                this.finalize();
            }
        } finally {
            // Restore original emit
            this.emit = originalEmit;
        }

        const processingTimeMs = Date.now() - startTime;

        return {
            toolCalls,
            textContent: textContent.trim(),
            events,
            stats: {
                totalToolCalls: toolCalls.length,
                totalTextBlocks: eventCounts.text || 0,
                processingTimeMs,
                parsingErrors,
                eventCounts
            }
        };
    }

    /**
     * Process a single token from the stream (similar to XMLStreamParser.processToken)
     * @param token - The token to process
     */
    processToken(token: string): void {
        this.buffer += token;

        // Process all complete structures in the buffer
        let iterations = 0;
        const maxIterations = 100; // Prevent infinite loops

        while (this.buffer.length > 0 && iterations < maxIterations) {
            iterations++;

            try {
                const processed = this.processBuffer();
                if (!processed.consumed) {
                    break; // No more complete structures to process
                }
                if (processed.event) {
                    // Emit event immediately when parsed
                    this.emit('toolCallEvent', processed.event);
                }
            } catch (error) {
                this.emit('toolCallEvent', {
                    type: 'error',
                    error: error instanceof Error ? error.message : String(error),
                    timestamp: Date.now()
                });
                // Skip the problematic character and continue
                this.buffer = this.buffer.substring(1);
            }
        }

        if (iterations >= maxIterations) {
            this.emit('warning', `Parser hit max iterations limit. Buffer: "${this.buffer.substring(0, 100)}..."`);
        }
    }

    /**
     * Finalize processing when stream ends (similar to XMLStreamParser.finalize)
     */
    finalize(): void {
        // Handle any remaining content when the stream ends
        const remainingContent = this.buffer.trim();
        if (remainingContent) {
            // Try to extract any remaining text content
            const cleanContent = this.extractTextFromBuffer(remainingContent);
            if (cleanContent) {
                this.emit('toolCallEvent', {
                    type: 'text',
                    content: cleanContent,
                    timestamp: Date.now()
                });
            }
        }
        this.buffer = '';
        this.emit('complete');
    }

    private processBuffer(): { event?: ToolCallEvent; consumed: boolean } {
        // 1. Check for LM Studio XML-style tool calls: <tool_call>...</tool_call>
        const xmlToolCallMatch = this.buffer.match(/^([^<]*)<tool_call>\s*({[^}]*(?:{[^}]*(?:{[^}]*}[^}]*)*[^}]*)*})\s*<\/tool_call>/s);
        if (xmlToolCallMatch) {
            const beforeTag = (xmlToolCallMatch[1] || '').trim();
            const toolCallJson = xmlToolCallMatch[2];
            if (!toolCallJson) return { consumed: false }; // Should not happen with regex match

            this.buffer = this.buffer.substring(xmlToolCallMatch[0].length);

            if (beforeTag) {
                // Return the text before the tag first, will process the tag on next call
                this.buffer = `<tool_call>${toolCallJson}</tool_call>${this.buffer}`;
                return { event: { type: 'text', content: beforeTag, timestamp: Date.now() }, consumed: true };
            }

            const toolCall = this.parseToolCallJson(toolCallJson);
            if (toolCall) {
                return { event: { type: 'tool_call', toolCall, timestamp: Date.now() }, consumed: true };
            }
        }

        // 2. Check for thinking/reasoning tags: <think>...</think>
        const thinkMatch = this.buffer.match(/^([^<]*)<think>(.*?)<\/think>/s);
        if (thinkMatch) {
            const beforeTag = (thinkMatch[1] || '').trim();
            const thinkingContent = (thinkMatch[2] || '').trim();
            this.buffer = this.buffer.substring(thinkMatch[0].length);

            if (beforeTag) {
                // Return the text before the tag first, will process the tag on next call
                this.buffer = `<think>${thinkingContent}</think>${this.buffer}`;
                return { event: { type: 'text', content: beforeTag, timestamp: Date.now() }, consumed: true };
            }
            return { event: { type: 'thinking', content: thinkingContent, timestamp: Date.now() }, consumed: true };
        }

        // 3. Check for plain JSON tool calls (no XML wrapper)
        const jsonToolCallMatch = this.buffer.match(/^([^{]*)({"name":\s*"[^"]+"\s*,\s*"arguments":\s*{[^}]*(?:{[^}]*(?:{[^}]*}[^}]*)*[^}]*)*})/);
        if (jsonToolCallMatch) {
            const beforeJson = (jsonToolCallMatch[1] || '').trim();
            const toolCallJson = jsonToolCallMatch[2];
            if (!toolCallJson) return { consumed: false }; // Should not happen with regex match

            this.buffer = this.buffer.substring(jsonToolCallMatch[0].length);

            if (beforeJson) {
                // Return the text before the JSON first, will process the JSON on next call
                this.buffer = toolCallJson + this.buffer;
                return { event: { type: 'text', content: beforeJson, timestamp: Date.now() }, consumed: true };
            }

            const toolCall = this.parseToolCallJson(toolCallJson);
            if (toolCall) {
                return { event: { type: 'tool_call', toolCall, timestamp: Date.now() }, consumed: true };
            }
        }

        // 4. Check if we have loose text before any tags or structured content
        const nextTagIndex = this.buffer.indexOf('<');
        const nextJsonIndex = this.buffer.indexOf('{"name"');
        const nextStructuredIndex = Math.min(
            nextTagIndex >= 0 ? nextTagIndex : Infinity,
            nextJsonIndex >= 0 ? nextJsonIndex : Infinity
        );

        if (nextStructuredIndex > 0 && nextStructuredIndex !== Infinity) {
            const looseText = this.buffer.substring(0, nextStructuredIndex).trim();
            this.buffer = this.buffer.substring(nextStructuredIndex);
            if (looseText) {
                return { event: { type: 'text', content: looseText, timestamp: Date.now() }, consumed: true };
            }
        }

        // 5. If we have incomplete structured content at the beginning, wait for more
        if ((this.buffer.startsWith('<') && !this.buffer.includes('>')) ||
            (this.buffer.startsWith('{"name"') && !this.buffer.includes('}}'))) {
            return { consumed: false };
        }

        // If we reach here, we don't have enough complete content to process
        return { consumed: false };
    }

    private parseToolCallJson(jsonString: string): LLMToolCall | null {
        try {
            const parsed = JSON.parse(jsonString);

            if (parsed.name && typeof parsed.name === 'string') {
                return {
                    id: `call_${Date.now()}_${this.currentToolCallId++}`,
                    type: 'function',
                    function: {
                        name: parsed.name,
                        arguments: JSON.stringify(parsed.arguments || {})
                    }
                };
            }
        } catch (error) {
            this.emit('toolCallEvent', {
                type: 'error',
                error: `Failed to parse tool call JSON: ${jsonString.substring(0, 100)}...`,
                timestamp: Date.now()
            });
        }

        return null;
    }

    private extractTextFromBuffer(buffer: string): string {
        // Remove any incomplete XML tags or JSON structures
        return buffer
            .replace(/<[^>]*$/g, '') // Remove incomplete opening tags at end
            .replace(/{"[^}]*$/g, '') // Remove incomplete JSON at end
            .replace(/<[^>]*>/g, ' ') // Remove complete tags
            .replace(/\s+/g, ' ') // Normalize whitespace
            .trim();
    }
}

// Factory function for easy integration with Universal LLM Client
export function createToolCallParser(): ToolCallStreamParser {
    return new ToolCallStreamParser();
}

// Utility function for quick parsing without events
export async function parseToolCallsFromContent(content: string): Promise<LLMToolCall[]> {
    const parser = new ToolCallStreamParser();
    const result = await parser.parse(content);
    return result.toolCalls;
}
