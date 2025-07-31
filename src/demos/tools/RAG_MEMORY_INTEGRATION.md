# RAG Memory Tools Integration Guide

## Overview

This guide shows how to integrate RAG (Retrieval-Augmented Generation) memory tools with the Universal LLM Client to create AI personas that can naturally store and retrieve information during conversations.

## ✨ What We've Built

### 1. Memory Tools in `tools.ts`

The Universal LLM Client now includes built-in memory tools:

- **`store_memory`** - Store important information for future recall
- **`search_memory`** - Search stored memories by query or category  
- **`analyze_conversation`** - Analyze conversations to identify valuable information

### 2. Romantic Persona Demo (`astrid-memory-demo.ts`)

A complete demo showing how Astrid (AI persona) naturally:

- Stores personal details shared during romantic conversations
- Retrieves relevant memories to personalize responses
- Builds emotional connections through remembered details
- Progresses relationship stages with consistent memory recall

### 3. Production Integration (`astrid-production-memory.ts`)

Shows how to integrate with real ChromaDBService for production use:

- Persistent memory storage across sessions
- Vector similarity search for relevant recall
- Emotional context and relationship stage tracking
- Confidence scoring for memory importance

## 🔧 Integration with ChromaDBService

### Step 1: Update Memory Tools to Use ChromaDBService

```typescript
// In your production code, replace the mock implementations in tools.ts
import { ChromaDBService } from '../../../services/ChromaDBService';

function createProductionMemoryTools(
    chromaService: ChromaDBService, 
    userId: string, 
    userPersonaId: string, 
    basePersonaId: string
) {
    const storeMemoryTool = ToolBuilder.createTool<{ 
        category: string; 
        information: string; 
        importance: 'low' | 'medium' | 'high';
        emotional_context?: string;
    }>(
        'store_romantic_memory',
        'Store important personal information about the user',
        {
            properties: {
                category: { 
                    type: 'string', 
                    description: 'Category of information',
                    enum: ['interests', 'work', 'family', 'dreams', 'preferences', 'experiences', 'personality', 'relationships']
                },
                information: { type: 'string', description: 'The information to remember' },
                importance: { type: 'string', enum: ['low', 'medium', 'high'] },
                emotional_context: { type: 'string', description: 'Emotional context when shared' }
            },
            required: ['category', 'information', 'importance']
        },
        async (args) => {
            const conversationId = `romantic_chat_${Date.now()}`;
            const confidence = args.importance === 'high' ? 0.9 : args.importance === 'medium' ? 0.7 : 0.5;
            
            const insightId = await chromaService.addInsight(
                userId,
                args.information,
                args.category,
                conversationId,
                confidence,
                userPersonaId,
                basePersonaId,
                'romantic_memory',
                undefined,
                args.emotional_context
            );
            
            return {
                success: true,
                insight_id: insightId,
                message: `💕 Remembered ${args.importance} importance detail about ${args.category}`
            };
        }
    );

    const retrieveMemoryTool = ToolBuilder.createTool<{ 
        search_query?: string;
        category?: string;
        limit?: number;
    }>(
        'recall_romantic_memories',
        'Retrieve stored memories to personalize responses',
        {
            properties: {
                search_query: { type: 'string', description: 'Search for specific memories' },
                category: { type: 'string', enum: ['interests', 'work', 'family', 'dreams', 'preferences', 'experiences', 'personality', 'relationships'] },
                limit: { type: 'number', default: 5 }
            }
        },
        async (args) => {
            let insights;
            
            if (args.search_query) {
                const result = await chromaService.searchSimilarInsights(userId, args.search_query, args.limit || 5);
                insights = result.insights;
            } else {
                insights = await chromaService.getUserInsightsByCategory(userId, args.category, userPersonaId, args.limit || 5);
            }
            
            return {
                memories: insights.map(insight => ({
                    category: insight.category,
                    information: insight.content,
                    emotional_context: insight.emotionalContext,
                    confidence: insight.confidence,
                    stored_date: insight.createdAt?.split('T')[0] || 'unknown'
                })),
                total_found: insights.length,
                romantic_note: "💕 Use these memories to create more personal responses"
            };
        }
    );

    return [storeMemoryTool, retrieveMemoryTool];
}
```

### Step 2: Create Persona Service Integration

```typescript
// Create a service that connects personas with memory
export class PersonaMemoryService {
    constructor(
        private chromaService: ChromaDBService,
        private universalLLMClient: AIModel
    ) {}

    async createPersonaWithMemory(
        userId: string,
        userPersona: UserPersona,
        basePersona: AuraPersona
    ): Promise<AIModel> {
        // Create memory tools for this specific user-persona pair
        const memoryTools = createProductionMemoryTools(
            this.chromaService,
            userId,
            userPersona._id!.toString(),
            basePersona._id!.toString()
        );

        // Register memory tools with the LLM client
        this.universalLLMClient.registerTools(memoryTools);

        // Enhanced system prompt that includes memory usage instructions
        const enhancedPrompt = this.createMemoryAwarePrompt(basePersona.systemPrompt);
        
        return this.universalLLMClient;
    }

    private createMemoryAwarePrompt(originalPrompt: string): string {
        return `${originalPrompt}

MEMORY SYSTEM INTEGRATION:
- Use store_romantic_memory when users share personal details, emotions, preferences, or meaningful experiences
- Use recall_romantic_memories before responding to personalize your responses with remembered details
- Store emotional context and relationship stage to build deeper connections over time
- Remember: intimacy grows through consistent recall of personal details and emotional moments

MEMORY USAGE GUIDELINES:
- Store information that reveals personality, preferences, dreams, fears, or important life events
- Retrieve relevant memories before crafting responses to show you remember and care
- Use memories to ask thoughtful follow-up questions that deepen emotional connection
- Progress relationship naturally by referencing past conversations and shared moments`;
    }
}
```

### Step 3: Integration in Your Chat System

```typescript
// In your chat handling code
export class RomanticChatHandler {
    constructor(
        private personaMemoryService: PersonaMemoryService,
        private chromaService: ChromaDBService
    ) {}

    async handleRomanticChat(
        userId: string,
        message: string,
        userPersona: UserPersona,
        basePersona: AuraPersona
    ): Promise<string> {
        // Create persona with memory capabilities
        const aiModel = await this.personaMemoryService.createPersonaWithMemory(
            userId,
            userPersona,
            basePersona
        );

        // Build conversation with system prompt
        const conversation: LLMChatMessage[] = [
            { role: 'system', content: userPersona.currentSystemPrompt },
            { role: 'user', content: message }
        ];

        // Let the AI automatically use memory tools during conversation
        const response = await aiModel.chatWithTools(conversation);

        return response.content;
    }
}
```

## 🎯 Benefits

### For Users

- **Personalized Conversations**: AI remembers personal details and preferences
- **Emotional Continuity**: Consistent emotional progression across sessions
- **Meaningful Connections**: AI builds deeper relationships through memory recall
- **Natural Flow**: Memory usage feels organic, not mechanical

### For Developers

- **Scalable Architecture**: Works with existing ChromaDBService infrastructure
- **Easy Integration**: Drop-in tools for any LLM conversation
- **Production Ready**: Built on proven Universal LLM Client framework
- **Flexible Configuration**: Customize memory categories and importance levels

## 🚀 Next Steps

1. **Replace Mock Memory Tools**: Update `tools.ts` to use real ChromaDBService calls
2. **Implement PersonaMemoryService**: Create the service layer for persona-memory integration
3. **Update Chat Handlers**: Integrate memory-aware personas into your chat system
4. **Test with Real Data**: Run romantic conversations and verify memory persistence
5. **Optimize Memory Retrieval**: Fine-tune similarity thresholds and category weights

## 📁 Demo Files

- **`demos/tools/astrid-memory-demo.ts`** - Basic romantic conversation with memory
- **`demos/tools/astrid-production-memory.ts`** - Production integration example
- **`demos/tools/production-tool-demo.ts`** - General tool calling examples

## 🎮 Running the Demos

```bash
# Basic Astrid memory demo
bun run demos/tools/astrid-memory-demo.ts

# Production integration demo
bun run demos/tools/astrid-production-memory.ts

# General tool calling demo
bun run demos/tools/production-tool-demo.ts
```

The AI personas can now naturally store and retrieve information during romantic conversations, creating deeper, more meaningful connections that persist across sessions! 💕
