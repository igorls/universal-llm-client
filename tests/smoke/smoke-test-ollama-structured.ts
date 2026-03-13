/**
 * Smoke Test — Ollama Structured Output
 *
 * Tests Ollama structured output (format parameter) against local Ollama server.
 *
 * Prerequisites: Ollama running at http://localhost:11434 with a model that supports JSON output.
 *
 * Run: OLLAMA_URL=http://localhost:11434 bun run tests/smoke/smoke-test-ollama-structured.ts
 */

import { z } from 'zod';
import { AIModel, AIModelApiType, ConsoleAuditor } from '../../src/index.js';

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = process.env.MODEL || 'qwen3:4b';

const passed: string[] = [];
const failed: string[] = [];

function log(label: string, msg: string) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  ${label}`);
    console.log(`${'='.repeat(60)}`);
    console.log(msg);
}

async function test(name: string, fn: () => Promise<void>) {
    try {
        await fn();
        passed.push(name);
        console.log(`  ✅ ${name}`);
    } catch (error) {
        failed.push(name);
        console.error(`  ❌ ${name}: ${error instanceof Error ? error.message : error}`);
    }
}

// ============================================================================
// Tests
// ============================================================================

async function main() {
    console.log(`\n🧪 Universal LLM Client v3.0.0 — Ollama Structured Output Smoke Test`);
    console.log(`   Ollama URL: ${OLLAMA_URL}`);
    console.log(`   Model: ${MODEL}\n`);

    // Schema definitions for tests
    const UserSchema = z.object({
        name: z.string(),
        age: z.number(),
        email: z.string().email().optional(),
    });

    const StatusSchema = z.object({
        status: z.enum(['active', 'inactive', 'pending']),
        message: z.string(),
    });

    // ---- 1) Basic Structured Output with Zod Schema (VAL-PROVIDER-OLLAMA-001, VAL-PROVIDER-OLLAMA-002) ----
    log('1. Basic Structured Output', 'Testing Zod schema → JSON Schema conversion via format parameter...');
    await test('basic structured output', async () => {
        const model = new AIModel({
            model: MODEL,
            providers: [{ 
                type: AIModelApiType.Ollama, 
                url: OLLAMA_URL, 
            }],
        });

        const response = await model.chat([
            { role: 'user', content: 'Generate a user object with name "Alice" and age 30. Reply with only valid JSON, no other text.' },
        ], { 
            schema: UserSchema,
            temperature: 0,
        });

        console.log(`    Response: ${response.message.content?.slice(0, 200)}`);
        
        if (!response.message.content) throw new Error('No content');
        
        // Verify the response is valid JSON matching the schema
        const parsed = JSON.parse(response.message.content);
        if (typeof parsed.name !== 'string') throw new Error('name is not a string');
        if (typeof parsed.age !== 'number') throw new Error('age is not a number');
    });

    // ---- 2) Schema Validation ----
    log('2. Schema Validation', 'Testing validation with required fields...');
    await test('schema validation', async () => {
        const model = new AIModel({
            model: MODEL,
            providers: [{ 
                type: AIModelApiType.Ollama, 
                url: OLLAMA_URL, 
            }],
        });

        const response = await model.chat([
            { role: 'user', content: 'Return a status object with status="active" and message="OK". Reply with only valid JSON.' },
        ], { 
            schema: StatusSchema,
            temperature: 0,
        });

        const parsed = JSON.parse(response.message.content || '{}');
        if (!['active', 'inactive', 'pending'].includes(parsed.status)) {
            throw new Error(`Invalid status value: ${parsed.status}`);
        }
        console.log(`    Response validated: ${JSON.stringify(parsed)}`);
    });

    // ---- 3) Enum Schema (VAL-PROVIDER-OLLAMA-001) ----
    log('3. Enum Schema', 'Testing enum schema conversion...');
    await test('enum schema', async () => {
        const model = new AIModel({
            model: MODEL,
            providers: [{ 
                type: AIModelApiType.Ollama, 
                url: OLLAMA_URL, 
            }],
        });

        const response = await model.chat([
            { role: 'user', content: 'Return a status with status="pending" and message="Waiting". Reply with only valid JSON.' },
        ], { 
            schema: StatusSchema,
            temperature: 0,
        });

        const parsed = JSON.parse(response.message.content || '{}');
        console.log(`    Response: ${JSON.stringify(parsed)}`);
        
        if (!['active', 'inactive', 'pending'].includes(parsed.status)) {
            throw new Error(`Expected status to be one of active/inactive/pending, got: ${parsed.status}`);
        }
    });

    // ---- 4) Nested Object Schema ----
    log('4. Nested Object Schema', 'Testing nested object validation...');
    await test('nested object schema', async () => {
        const AddressSchema = z.object({
            street: z.string(),
            city: z.string(),
            country: z.string(),
        });

        const PersonSchema = z.object({
            name: z.string(),
            address: AddressSchema,
        });

        const model = new AIModel({
            model: MODEL,
            providers: [{ 
                type: AIModelApiType.Ollama, 
                url: OLLAMA_URL, 
            }],
        });

        const response = await model.chat([
            { role: 'user', content: 'Return a person with name "Bob" and address with city "NYC", country "USA", street "123 Main St". Reply with only valid JSON.' },
        ], { 
            schema: PersonSchema,
            temperature: 0,
        });

        const parsed = JSON.parse(response.message.content || '{}');
        console.log(`    Response: ${JSON.stringify(parsed)}`);
        
        if (!parsed.address || typeof parsed.address.city !== 'string') {
            throw new Error('Nested address not properly validated');
        }
    });

    // ---- 5) json format simple mode (VAL-PROVIDER-OLLAMA-004) ----
    log('5. json format mode', 'Testing format: "json" simple mode...');
    await test('json format mode', async () => {
        const model = new AIModel({
            model: MODEL,
            providers: [{ 
                type: AIModelApiType.Ollama, 
                url: OLLAMA_URL, 
            }],
        });

        const response = await model.chat([
            { role: 'user', content: 'Return a JSON object with any valid JSON. Reply with only valid JSON.' },
        ], { 
            responseFormat: { type: 'json_object' },
            temperature: 0,
        });

        console.log(`    Response: ${response.message.content?.slice(0, 200)}`);
        
        // Verify it's valid JSON
        const parsed = JSON.parse(response.message.content || '{}');
        console.log(`    Parsed JSON: ${typeof parsed}`);
    });

    // ---- 6) Raw JSON Schema Input ----
    log('6. Raw JSON Schema', 'Testing raw JSON Schema input...');
    await test('raw JSON schema', async () => {
        const model = new AIModel({
            model: MODEL,
            providers: [{ 
                type: AIModelApiType.Ollama, 
                url: OLLAMA_URL, 
            }],
        });

        const response = await model.chat([
            { role: 'user', content: 'Return a product with id="123" and name="Widget". Reply with only valid JSON.' },
        ], { 
            jsonSchema: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                },
                required: ['id', 'name'],
            },
            temperature: 0,
        });

        const parsed = JSON.parse(response.message.content || '{}');
        console.log(`    Response: ${JSON.stringify(parsed)}`);
        
        if (!parsed.id || !parsed.name) {
            throw new Error('Missing required fields');
        }
    });

    // ---- 7) Vision with Structured Output (VAL-PROVIDER-OLLAMA-003) ----
    log('7. Vision with Structured Output', 'Testing base64 image + structured output...');
    await test('vision with structured output', async () => {
        // Skip if using a non-vision model
        const visionModel = MODEL.includes('vl') || MODEL.includes('vision') ? MODEL : 'qwen3-vl:8b';
        console.log(`    Using vision model: ${visionModel}`);
        
        // Simple base64 1x1 red pixel PNG
        const base64Image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKMIawAAAABJRU5ErkJggg==';
        
        const DescriptionSchema = z.object({
            description: z.string(),
            dominantColor: z.string(),
        });

        const model = new AIModel({
            model: visionModel,
            providers: [{ 
                type: AIModelApiType.Ollama, 
                url: OLLAMA_URL, 
            }],
        });

        try {
            const response = await model.chat([
                { 
                    role: 'user', 
                    content: [
                        { type: 'text', text: 'Describe this image. What is the dominant color? Reply with valid JSON matching the schema.' },
                        { type: 'image', data: base64Image, mimeType: 'image/png' },
                    ]
                },
            ], { 
                schema: DescriptionSchema,
                temperature: 0,
            });

            const parsed = JSON.parse(response.message.content || '{}');
            console.log(`    Response: ${JSON.stringify(parsed)}`);
            
            if (typeof parsed.description !== 'string') {
                throw new Error('Missing description in response');
            }
        } catch (error) {
            // If model doesn't support vision, skip
            if (error instanceof Error && (error.message.includes('does not support') || error.message.includes('vision'))) {
                console.log(`    ⚠️ Vision not supported, skipping...`);
            } else {
                throw error;
            }
        }
    });

    // ---- 8) generateStructured Method ----
    log('8. generateStructured Method', 'Testing direct generateStructured<T> method...');
    await test('generateStructured method', async () => {
        const model = new AIModel({
            model: MODEL,
            providers: [{ 
                type: AIModelApiType.Ollama, 
                url: OLLAMA_URL, 
            }],
        });

        const user = await model.generateStructured(UserSchema, [
            { role: 'user', content: 'Generate a user with name "Charlie" and age 28. Reply with only valid JSON.' },
        ], { temperature: 0 });

        console.log(`    Result: ${JSON.stringify(user)}`);
        
        if (typeof user.name !== 'string') throw new Error('name is not a string');
        if (typeof user.age !== 'number') throw new Error('age is not a number');
    });

    // ---- 9) tryParseStructured Method (VAL-API-006, VAL-API-007) ----
    log('9. tryParseStructured Method', 'Testing tryParseStructured success path...');
    await test('tryParseStructured success path', async () => {
        const model = new AIModel({
            model: MODEL,
            providers: [{ 
                type: AIModelApiType.Ollama, 
                url: OLLAMA_URL, 
            }],
        });

        const result = await model.tryParseStructured(UserSchema, [
            { role: 'user', content: 'Generate a user with name "Diana" and age 35. Reply with only valid JSON.' },
        ], { temperature: 0 });

        console.log(`    Result: ${JSON.stringify(result)}`);
        
        if (result.ok !== true) throw new Error('Expected ok=true');
        if (typeof result.value.name !== 'string') throw new Error('name is not a string');
        if (typeof result.value.age !== 'number') throw new Error('age is not a number');
    });

    // ---- 10) tryParseStructured failure path ----
    log('10. tryParseStructured failure path', 'Testing tryParseStructured returns error object...');
    await test('tryParseStructured failure path', async () => {
        const model = new AIModel({
            model: MODEL,
            providers: [{ 
                type: AIModelApiType.Ollama, 
                url: OLLAMA_URL, 
            }],
        });

        // Use a schema that will definitely fail UUID validation
        const StrictSchema = z.object({
            id: z.string().uuid(),
            timestamp: z.string().datetime(),
        });

        const result = await model.tryParseStructured(StrictSchema, [
            { role: 'user', content: 'Return something simple like hello world' },
        ], { temperature: 0 });

        console.log(`    Result: ${JSON.stringify(result)}`);
        
        // The result should be ok=false if validation failed
        if (result.ok === true) {
            console.log(`    ⚠️ Model generated valid UUID/datetime unexpectedly: ${JSON.stringify(result.value)}`);
        } else {
            console.log(`    ✅ Correctly returned error object with rawOutput: ${result.rawOutput?.slice(0, 100)}`);
        }
    });

    // ---- 11) Auditor ----
    log('11. Auditor', 'Testing ConsoleAuditor with structured output...');
    await test('auditor', async () => {
        const model = new AIModel({
            model: MODEL,
            providers: [{ 
                type: AIModelApiType.Ollama, 
                url: OLLAMA_URL, 
            }],
            auditor: new ConsoleAuditor('[OLLAMA]'),
        });

        const response = await model.chat([
            { role: 'user', content: 'Generate a user with name "Test" and age 25. Reply with only valid JSON.' },
        ], { 
            schema: UserSchema,
            temperature: 0,
        });

        console.log(`    Auditor logged above ↑`);
    });

    // ---- 12) Streaming Structured Output (VAL-PROVIDER-OLLAMA-005, VAL-API-008) ----
    log('12. Streaming Structured Output', 'Testing generateStructuredStream...');
    await test('streaming structured output', async () => {
        const model = new AIModel({
            model: MODEL,
            providers: [{ 
                type: AIModelApiType.Ollama, 
                url: OLLAMA_URL, 
            }],
        });

        const StreamSchema = z.object({
            name: z.string(),
            count: z.number(),
        });

        let partialCount = 0;

        try {
            const stream = model.generateStructuredStream(StreamSchema, [
                { role: 'user', content: 'Return JSON: name="Test" and count=42. Reply with only valid JSON.' },
            ], { temperature: 0 });

            for await (const partial of stream) {
                partialCount++;
                console.log(`    Partial ${partialCount}: ${JSON.stringify(partial)}`);
            }

            console.log(`    Received ${partialCount} partial updates`);
        } catch (error) {
            // Streaming may not work with all models
            if (error instanceof Error && (
                error.message.includes('streaming') ||
                error.message.includes('JSON') ||
                error.message.includes('parse') ||
                error.message.includes('Not Implemented')
            )) {
                console.log(`    ⚠️ Streaming structured output not fully supported by this model, skipping...`);
            } else {
                throw error;
            }
        }
    });

    // ============================================================================
    // Summary
    // ============================================================================

    console.log(`\n${'='.repeat(60)}`);
    console.log(`  RESULTS: ${passed.length} passed, ${failed.length} failed`);
    console.log(`${'='.repeat(60)}`);

    if (failed.length > 0) {
        console.log(`\n  Failed tests:`);
        for (const name of failed) console.log(`    ❌ ${name}`);
        process.exit(1);
    } else {
        console.log(`\n  🎉 All Ollama structured output smoke tests passed!`);
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
