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
                    error: type === 'error' ? 'test error' : undefined,
                    metadata: type === 'failover' ? { nextProvider: 'backup' } : undefined,
                });
            }).not.toThrow();
        }
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
