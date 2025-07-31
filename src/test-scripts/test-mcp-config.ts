/**
 * Simple test to verify MCP config loading
 */

import { readFile } from 'fs/promises';
import { join } from 'path';

async function testConfigLoading() {
    try {
        const path = join(process.cwd(), '.vscode', 'mcp.json');
        const content = await readFile(path, 'utf-8');
        
        console.log('Raw content:');
        console.log(content);
        console.log('\n' + '='.repeat(50) + '\n');
        
        const parsed = JSON.parse(content);
        console.log('Parsed JSON:');
        console.log(JSON.stringify(parsed, null, 2));
        
        console.log('\n✅ JSON parsing successful!');
        
    } catch (error) {
        console.error('❌ Error:', error);
    }
}

testConfigLoading();
