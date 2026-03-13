/**
 * Tests for auditor.ts — Observability implementations
 */
import { describe, it, expect } from 'bun:test';
import { NoopAuditor, ConsoleAuditor, BufferedAuditor, type AuditEvent } from '../auditor.js';

describe('NoopAuditor', () => {
    it('accepts events without error', () => {
        const auditor = new NoopAuditor();
        expect(() => {
            auditor.record({
                timestamp: Date.now(),
                type: 'request',
                provider: 'test',
            });
        }).not.toThrow();
    });

    it('accepts structured output events without error', () => {
        const auditor = new NoopAuditor();
        expect(() => {
            auditor.record({
                timestamp: Date.now(),
                type: 'structured_request',
                provider: 'test',
                schemaName: 'User',
            });
        }).not.toThrow();
    });
});

describe('ConsoleAuditor', () => {
    it('creates with default prefix', () => {
        const auditor = new ConsoleAuditor();
        expect(auditor).toBeDefined();
    });

    it('creates with custom prefix', () => {
        const auditor = new ConsoleAuditor('[TEST]');
        expect(auditor).toBeDefined();
    });

    it('records all event types without error', () => {
        const auditor = new ConsoleAuditor('[TEST]');
        const types: AuditEvent['type'][] = [
            'request', 'response', 'stream_start', 'stream_end',
            'tool_call', 'tool_result', 'error', 'retry', 'failover',
            'structured_request', 'structured_response', 'structured_validation_error',
        ];

        for (const type of types) {
            expect(() => {
                auditor.record({
                    timestamp: Date.now(),
                    type,
                    provider: 'test',
                    model: 'test-model',
                    duration: 100,
                    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
                    error: type === 'error' || type === 'structured_validation_error' ? 'test error' : undefined,
                    metadata: type === 'failover' ? { nextProvider: 'backup' } : undefined,
                    schemaName: type.startsWith('structured') ? 'User' : undefined,
                    rawOutput: type === 'structured_validation_error' ? '{"name": "invalid"}' : undefined,
                });
            }).not.toThrow();
        }
    });

    it('logs structured_request with schema name', () => {
        const auditor = new ConsoleAuditor('[TEST]');
        // Should not throw when logging structured request
        expect(() => {
            auditor.record({
                timestamp: Date.now(),
                type: 'structured_request',
                provider: 'ollama',
                schemaName: 'User',
            });
        }).not.toThrow();
    });

    it('logs structured_response with duration and schema name', () => {
        const auditor = new ConsoleAuditor('[TEST]');
        expect(() => {
            auditor.record({
                timestamp: Date.now(),
                type: 'structured_response',
                provider: 'google',
                model: 'gemini-2.0-flash',
                duration: 150,
                schemaName: 'User',
                usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
            });
        }).not.toThrow();
    });

    it('logs structured_validation_error with schema name and error', () => {
        const auditor = new ConsoleAuditor('[TEST]');
        expect(() => {
            auditor.record({
                timestamp: Date.now(),
                type: 'structured_validation_error',
                provider: 'openai',
                schemaName: 'User',
                error: 'Validation failed: name is required',
                rawOutput: '{"age": 30}',
            });
        }).not.toThrow();
    });
});

describe('BufferedAuditor', () => {
    it('buffers events', () => {
        const auditor = new BufferedAuditor();
        const event: AuditEvent = {
            timestamp: Date.now(),
            type: 'request',
            provider: 'test',
        };

        auditor.record(event);
        auditor.record(event);
        auditor.record(event);

        expect(auditor.getEvents()).toHaveLength(3);
    });

    it('buffers structured output events', () => {
        const auditor = new BufferedAuditor();
        
        auditor.record({
            timestamp: Date.now(),
            type: 'structured_request',
            provider: 'ollama',
            schemaName: 'User',
        });
        auditor.record({
            timestamp: Date.now(),
            type: 'structured_response',
            provider: 'ollama',
            schemaName: 'User',
            duration: 100,
        });

        const events = auditor.getEvents();
        expect(events).toHaveLength(2);
        expect(events[0]?.type).toBe('structured_request');
        expect(events[0]?.schemaName).toBe('User');
        expect(events[1]?.type).toBe('structured_response');
    });

    it('buffers structured_validation_error events', () => {
        const auditor = new BufferedAuditor();
        
        auditor.record({
            timestamp: Date.now(),
            type: 'structured_validation_error',
            provider: 'openai',
            schemaName: 'User',
            error: 'Validation failed',
            rawOutput: '{"invalid": true}',
        });

        const events = auditor.getEvents();
        expect(events).toHaveLength(1);
        expect(events[0]?.type).toBe('structured_validation_error');
        expect(events[0]?.schemaName).toBe('User');
        expect(events[0]?.error).toBe('Validation failed');
        expect(events[0]?.rawOutput).toBe('{"invalid": true}');
    });

    it('flushes events to callback', async () => {
        const flushed: AuditEvent[][] = [];
        const auditor = new BufferedAuditor({
            onFlush: async (events) => {
                flushed.push([...events]);
            },
        });

        auditor.record({ timestamp: 1, type: 'request' });
        auditor.record({ timestamp: 2, type: 'response' });

        await auditor.flush();

        expect(flushed).toHaveLength(1);
        expect(flushed[0]).toHaveLength(2);
        expect(auditor.getEvents()).toHaveLength(0);
    });

    it('auto-flushes when buffer is full', async () => {
        let flushCount = 0;
        const auditor = new BufferedAuditor({
            maxBufferSize: 3,
            onFlush: async () => { flushCount++; },
        });

        auditor.record({ timestamp: 1, type: 'request' });
        auditor.record({ timestamp: 2, type: 'request' });
        auditor.record({ timestamp: 3, type: 'request' }); // triggers auto-flush

        // Give auto-flush time to complete
        await new Promise(r => setTimeout(r, 50));
        expect(flushCount).toBe(1);
    });

    it('clears without flushing', () => {
        const auditor = new BufferedAuditor();
        auditor.record({ timestamp: 1, type: 'request' });
        auditor.record({ timestamp: 2, type: 'response' });

        auditor.clear();
        expect(auditor.getEvents()).toHaveLength(0);
    });

    it('flush with no events is a no-op', async () => {
        let flushed = false;
        const auditor = new BufferedAuditor({
            onFlush: async () => { flushed = true; },
        });

        await auditor.flush();
        expect(flushed).toBe(false);
    });
});
