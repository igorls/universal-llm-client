/**
 * Tests for tools.ts — ToolBuilder and ToolExecutor
 */
import { describe, it, expect } from 'bun:test';
import { ToolBuilder, ToolExecutor, createTimeTool, createRandomNumberTool } from '../tools.js';

describe('ToolBuilder', () => {
    it('builds a basic tool definition', () => {
        const tool = new ToolBuilder('test_tool')
            .description('A test tool')
            .build();

        expect(tool.type).toBe('function');
        expect(tool.function.name).toBe('test_tool');
        expect(tool.function.description).toBe('A test tool');
        expect(tool.function.parameters.type).toBe('object');
    });

    it('adds required parameters', () => {
        const tool = new ToolBuilder('search')
            .description('Search')
            .addParameter('query', 'string', 'Search query', true)
            .build();

        expect(tool.function.parameters.properties).toHaveProperty('query');
        expect(tool.function.parameters.required).toEqual(['query']);
    });

    it('adds optional parameters', () => {
        const tool = new ToolBuilder('search')
            .description('Search')
            .addParameter('query', 'string', 'Search query', true)
            .addParameter('limit', 'number', 'Max results', false)
            .build();

        expect(tool.function.parameters.properties).toHaveProperty('limit');
        expect(tool.function.parameters.required).toEqual(['query']);
    });

    it('adds parameters with extra schema properties', () => {
        const tool = new ToolBuilder('config')
            .description('Configure')
            .addParameter('theme', 'string', 'Color theme', false, {
                enum: ['light', 'dark'],
            })
            .build();

        const themeParam = (tool.function.parameters.properties as Record<string, Record<string, unknown>>)?.['theme'];
        expect(themeParam?.enum).toEqual(['light', 'dark']);
    });

    it('builds function definition only', () => {
        const fn = new ToolBuilder('test')
            .description('Test')
            .buildFunction();

        expect(fn.name).toBe('test');
        expect(fn.description).toBe('Test');
    });
});

describe('ToolExecutor', () => {
    describe('withTimeout', () => {
        it('resolves if handler completes in time', async () => {
            const handler = async () => 'result';
            const wrapped = ToolExecutor.withTimeout(handler, 1000);
            expect(await wrapped({})).toBe('result');
        });

        it('rejects if handler exceeds timeout', async () => {
            const handler = async () => {
                await new Promise(r => setTimeout(r, 500));
                return 'too late';
            };
            const wrapped = ToolExecutor.withTimeout(handler, 50);
            expect(wrapped({})).rejects.toThrow('timeout');
        });
    });

    describe('safe', () => {
        it('returns result on success', async () => {
            const handler = async () => 42;
            const wrapped = ToolExecutor.safe(handler);
            expect(await wrapped({})).toBe(42);
        });

        it('catches errors and returns error object', async () => {
            const handler = async () => { throw new Error('boom'); };
            const wrapped = ToolExecutor.safe(handler);
            const result = await wrapped({}) as { error: string };
            expect(result.error).toBe('boom');
        });
    });

    describe('withValidation', () => {
        it('passes through if all required fields present', async () => {
            const handler = async (args: unknown) => args;
            const wrapped = ToolExecutor.withValidation(handler, ['name']);
            expect(await wrapped({ name: 'test' })).toEqual({ name: 'test' });
        });

        it('throws if required field is missing', async () => {
            const handler = async () => 'ok';
            const wrapped = ToolExecutor.withValidation(handler, ['name']);
            expect(wrapped({ other: 'value' })).rejects.toThrow('Missing required argument: name');
        });

        it('throws if args is not an object', async () => {
            const handler = async () => 'ok';
            const wrapped = ToolExecutor.withValidation(handler, ['name']);
            expect(wrapped(null)).rejects.toThrow('must be an object');
        });
    });

    describe('timed', () => {
        it('returns result with duration', async () => {
            const handler = async () => 'hello';
            const wrapped = ToolExecutor.timed(handler);
            const result = await wrapped({}) as { result: string; duration: number };
            expect(result.result).toBe('hello');
            expect(result.duration).toBeGreaterThanOrEqual(0);
        });
    });

    describe('compose', () => {
        it('composes multiple wrappers', async () => {
            const handler = async () => 'result';
            const composed = ToolExecutor.compose(
                handler,
                h => ToolExecutor.safe(h),
                h => ToolExecutor.withTimeout(h, 5000),
            );
            expect(await composed({})).toBe('result');
        });
    });
});

describe('Common Tools', () => {
    describe('createTimeTool', () => {
        it('returns a valid tool definition', () => {
            const tool = createTimeTool();
            expect(tool.name).toBe('get_current_time');
            expect(tool.description).toBeTruthy();
            expect(tool.parameters.type).toBe('object');
        });

        it('handler returns time info', async () => {
            const tool = createTimeTool();
            const result = await tool.handler({}) as { iso: string; timestamp: number };
            expect(result.iso).toBeTruthy();
            expect(result.timestamp).toBeGreaterThan(0);
        });

        it('handler respects timezone parameter', async () => {
            const tool = createTimeTool();
            const result = await tool.handler({ timezone: 'America/New_York' }) as { timezone: string };
            expect(result.timezone).toBe('America/New_York');
        });
    });

    describe('createRandomNumberTool', () => {
        it('returns a valid tool definition', () => {
            const tool = createRandomNumberTool();
            expect(tool.name).toBe('random_number');
            expect(tool.description).toBeTruthy();
        });

        it('handler returns number in range', async () => {
            const tool = createRandomNumberTool();
            const result = await tool.handler({ min: 1, max: 10 }) as { value: number };
            expect(result.value).toBeGreaterThanOrEqual(1);
            expect(result.value).toBeLessThanOrEqual(10);
        });
    });
});
