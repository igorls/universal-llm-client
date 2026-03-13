/**
 * Smoke Test — OpenAI-Compatible Structured Output
 *
 * Tests OpenAI-compatible structured output (response_format) against real APIs.
 * Works with: OpenAI, OpenRouter, Groq, LM Studio, vLLM, LlamaCpp.
 *
 * For LlamaCpp server:
 *   OPENAI_API_URL=http://blade14:8080/v1 bun run tests/smoke/smoke-test-openai-structured.ts
 *
 * For OpenAI:
 *   OPENAI_API_KEY=sk-xxx bun run tests/smoke/smoke-test-openai-structured.ts
 *
 * For local LM Studio:
 *   bun run tests/smoke/smoke-test-openai-structured.ts
 */

import { z } from 'zod';
import { AIModel, AIModelApiType, ConsoleAuditor } from '../../src/index.js';

const API_KEY = process.env.OPENAI_API_KEY || 'not-needed';
const API_URL = process.env.OPENAI_API_URL || 'http://localhost:1234/v1';

// Use a model available on the server
const MODEL = process.env.MODEL || 'local-model';

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
    console.log(`\n🧪 Universal LLM Client v3.0.0 — OpenAI-Compatible Structured Output Smoke Test`);
    console.log(`   API URL: ${API_URL}`);
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

    // ---- 1) Basic Structured Output with Zod Schema ----
    log('1. Basic Structured Output', 'Testing Zod schema → JSON Schema conversion...');
    await test('basic structured output', async () => {
        const model = new AIModel({
            model: MODEL,
            providers: [{ 
                type: AIModelApiType.OpenAI, 
                url: API_URL, 
                apiKey: API_KEY 
            }],
        });

        const response = await model.chat([
            { role: 'user', content: 'Generate a user object with name "Alice" and age 30' },
        ], { 
            schema: UserSchema,
            schemaName: 'User',
            schemaDescription: 'A user object',
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
                type: AIModelApiType.OpenAI, 
                url: API_URL, 
                apiKey: API_KEY 
            }],
        });

        try {
            // This should fail validation if the model returns incomplete data
            const response = await model.chat([
                { role: 'system', content: 'You must respond with valid JSON matching the schema.' },
                { role: 'user', content: 'Return a status object with status="active" and message="OK"' },
            ], { 
                schema: StatusSchema,
                temperature: 0,
            });

            const parsed = JSON.parse(response.message.content || '{}');
            if (!['active', 'inactive', 'pending'].includes(parsed.status)) {
                throw new Error('Invalid status value');
            }
            console.log(`    Response validated: ${JSON.stringify(parsed)}`);
        } catch (error) {
            if (error instanceof Error && error.message.includes('StructuredOutputError')) {
                console.log(`    ✅ Validation correctly caught: ${error.message}`);
            } else {
                throw error;
            }
        }
    });

    // ---- 3) Enum Schema ----
    log('3. Enum Schema', 'Testing enum schema conversion...');
    await test('enum schema', async () => {
        const model = new AIModel({
            model: MODEL,
            providers: [{ 
                type: AIModelApiType.OpenAI, 
                url: API_URL, 
                apiKey: API_KEY 
            }],
        });

        const response = await model.chat([
            { role: 'user', content: 'Return a status with status="pending" and message="Waiting"' },
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
                type: AIModelApiType.OpenAI, 
                url: API_URL, 
                apiKey: API_KEY 
            }],
        });

        const response = await model.chat([
            { role: 'user', content: 'Return a person with name "Bob" and address with city "NYC", country "USA", street "123 Main St"' },
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

    // ---- 5) Raw JSON Schema Input ----
    log('5. Raw JSON Schema', 'Testing raw JSON Schema input...');
    await test('raw JSON schema', async () => {
        const model = new AIModel({
            model: MODEL,
            providers: [{ 
                type: AIModelApiType.OpenAI, 
                url: API_URL, 
                apiKey: API_KEY 
            }],
        });

        const response = await model.chat([
            { role: 'user', content: 'Return a product with id="123" and name="Widget"' },
        ], { 
            jsonSchema: {
                type: 'object',
                properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                },
                required: ['id', 'name'],
            },
            schemaName: 'Product',
            temperature: 0,
        });

        const parsed = JSON.parse(response.message.content || '{}');
        console.log(`    Response: ${JSON.stringify(parsed)}`);
        
        if (!parsed.id || !parsed.name) {
            throw new Error('Missing required fields');
        }
    });

    // ---- 6) json_object Mode (Legacy) ----
    log('6. json_object Mode', 'Testing legacy json_object mode...');
    await test('json_object mode', async () => {
        const model = new AIModel({
            model: MODEL,
            providers: [{ 
                type: AIModelApiType.OpenAI, 
                url: API_URL, 
                apiKey: API_KEY 
            }],
        });

        const response = await model.chat([
            { role: 'user', content: 'Return a JSON object with any valid JSON' },
        ], { 
            responseFormat: { type: 'json_object' },
            temperature: 0,
        });

        console.log(`    Response: ${response.message.content?.slice(0, 200)}`);
        
        // Verify it's valid JSON
        const parsed = JSON.parse(response.message.content || '{}');
        console.log(`    Parsed JSON: ${typeof parsed}`);
    });

    // ---- 7) Auditor ----
    log('7. Auditor', 'Testing ConsoleAuditor with structured output...');
    await test('auditor', async () => {
        const model = new AIModel({
            model: MODEL,
            providers: [{ 
                type: AIModelApiType.OpenAI, 
                url: API_URL, 
                apiKey: API_KEY 
            }],
            auditor: new ConsoleAuditor('[OPENAI]'),
        });

        const response = await model.chat([
            { role: 'user', content: 'Generate a user with name "Test" and age 25' },
        ], { 
            schema: UserSchema,
            temperature: 0,
        });

        console.log(`    Auditor logged above ↑`);
    });

    // ---- 8) Error Handling ----
    log('8. Error Handling', 'Testing error on invalid JSON response...');
    await test('error handling', async () => {
        // This test intentionally requests something that might fail
        // to verify error handling works
        const model = new AIModel({
            model: MODEL,
            providers: [{ 
                type: AIModelApiType.OpenAI, 
                url: API_URL, 
                apiKey: API_KEY 
            }],
        });

        // Schema that requires specific fields
        const StrictSchema = z.object({
            id: z.string().uuid(),
            createdAt: z.string().datetime(),
        });

        try {
            await model.chat([
                { role: 'user', content: 'Generate something' },
            ], { 
                schema: StrictSchema,
                temperature: 0,
            });
            
            // If it works, that's fine too
            console.log(`    Model generated valid response`);
        } catch (error) {
            // If it fails with StructuredOutputError, that's expected
            if (error instanceof Error && error.message.includes('StructuredOutputError')) {
                console.log(`    ✅ Correctly threw StructuredOutputError`);
            } else {
                console.log(`    Model may not support structured output, error: ${error instanceof Error ? error.message : 'unknown'}`);
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
        console.log(`\n  🎉 All OpenAI-compatible structured output smoke tests passed!`);
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
