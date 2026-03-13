#!/bin/bash
# Mission initialization script
# Runs once per worker session

set -e

echo "=== Initializing mission environment ==="

# Install dependencies
echo "Installing dependencies..."
bun install

# Verify TypeScript
echo "Verifying TypeScript..."
bun run typecheck

echo "=== Environment ready ==="
