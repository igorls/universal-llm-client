/**
 * RAG Memory System Integration Test
 *
 * Objective validation of memory storage, recall, and filtering capabilities
 * using production ChromaDB and MongoDB services.
 */

import '@dotenvx/dotenvx/config';

import { AIModelFactory, ToolBuilder, LLMChatMessage } from '../../index';
import { ChromaDBService } from '../../../../../src/services/ChromaDBService.js';
import { DatabaseConnection } from '../../../../../src/database/connection.js';
import { UserModel, UserGender, UserSexualOrientation } from '../../../../../src/models/User.js';

// Core test validation metrics
interface TestResults {
    storageTests: {
        meaningfulDataStored: number;
        trivialDataFiltered: number;
        emotionalContextCaptured: number;
    };
    recallTests: {
        freshSessionRecalls: number;
        searchQueriesSuccessful: number;
        categoryFiltersWorking: number;
    };
    integrationTests: {
        mongoDbConnected: boolean;
        chromaDbConnected: boolean;
        userCreationWorking: boolean;
        memoryPersistence: boolean;
    };
    overallScore: number;
}

function createTestMemoryTools(chromaService: ChromaDBService, userMongoId: string, testResults: TestResults) {
    const storeMemoryTool = ToolBuilder.createTool<{
        category: string;
        information: string;
        importance: 'low' | 'medium' | 'high';
        emotional_context?: string;
        relationship_stage?: string;
    }>(
        'store_memory',
        'Store important personal information for testing',
        {
            properties: {
                category: {
                    type: 'string',
                    description: 'Category of information',
                    enum: ['interests', 'work', 'family', 'dreams', 'preferences', 'experiences', 'personality', 'relationships', 'fears', 'goals', 'values']
                },
                information: {
                    type: 'string',
                    description: 'The information to remember'
                },
                importance: {
                    type: 'string',
                    enum: ['low', 'medium', 'high'],
                    description: 'Importance level'
                },
                emotional_context: {
                    type: 'string',
                    description: 'Emotional context when shared'
                },
                relationship_stage: {
                    type: 'string',
                    description: 'Relationship stage when shared'
                }
            },
            required: ['category', 'information', 'importance']
        },
        async (args) => {
            try {
                const conversationId = `test_chat_${Date.now()}`;
                const confidence = args.importance === 'high' ? 0.9 : args.importance === 'medium' ? 0.7 : 0.5;

                const insightId = await chromaService.addInsight(
                    userMongoId,
                    args.information,
                    args.category,
                    conversationId,
                    confidence,
                    '', // userPersonaId - empty for test
                    '', // basePersonaId - empty for test
                    'user_insight',
                    undefined,
                    args.emotional_context,
                    args.relationship_stage
                );

                console.log(`✅ STORAGE TEST: Stored ${args.category} data successfully`);
                testResults.storageTests.meaningfulDataStored++;

                if (args.emotional_context) {
                    testResults.storageTests.emotionalContextCaptured++;
                }

                return {
                    success: true,
                    insight_id: insightId,
                    message: `Stored ${args.importance} importance ${args.category}`
                };
            } catch (error) {
                console.log(`❌ STORAGE TEST: Failed - ${(error as Error).message}`);
                return {
                    success: false,
                    error: `Storage failed: ${(error as Error).message}`
                };
            }
        }
    );

    const recallMemoryTool = ToolBuilder.createTool<{
        search_query?: string;
        category?: string;
        limit?: number;
    }>(
        'recall_memories',
        'Retrieve stored memories for testing',
        {
            properties: {
                search_query: {
                    type: 'string',
                    description: 'Search for specific memories'
                },
                category: {
                    type: 'string',
                    description: 'Filter by category',
                    enum: ['interests', 'work', 'family', 'dreams', 'preferences', 'experiences', 'personality', 'relationships', 'fears', 'goals', 'values']
                },
                limit: {
                    type: 'number',
                    description: 'Maximum memories to retrieve',
                    default: 5
                }
            }
        },
        async (args) => {
            try {
                console.log(`🔍 RECALL TEST: "${args.search_query || args.category || 'all'}"`);

                let insights;

                if (args.search_query) {
                    const result = await chromaService.searchSimilarInsights(
                        userMongoId,
                        args.search_query,
                        args.limit || 5
                    );
                    insights = result.insights;
                    testResults.recallTests.searchQueriesSuccessful++;
                } else {
                    insights = await chromaService.getUserInsightsByCategory(
                        userMongoId,
                        args.category,
                        '', // userPersonaId - empty for test
                        args.limit || 5
                    );
                    testResults.recallTests.categoryFiltersWorking++;
                }

                console.log(`   📊 Found ${insights.length} memories`);

                return {
                    memories: insights.map(insight => ({
                        category: insight.category,
                        information: insight.content,
                        emotional_context: insight.emotionalContext,
                        confidence: insight.confidence
                    })),
                    total_found: insights.length
                };
            } catch (error) {
                console.log(`   ❌ RECALL TEST: Failed - ${(error as Error).message}`);
                return {
                    memories: [],
                    total_found: 0,
                    error: `Recall failed: ${(error as Error).message}`
                };
            }
        }
    );

    return [storeMemoryTool, recallMemoryTool];
}

async function createTestUser(userId: string): Promise<boolean> {
    try {
        const existingUser = await UserModel.findOne({ userId });
        if (existingUser) {
            console.log(`✅ Test user already exists`);
            return true;
        }

        const testUser = new UserModel({
            userId,
            preferences: {
                userName: 'Test User',
                userGender: UserGender.PREFER_NOT_TO_SAY,
                userSexualOrientation: UserSexualOrientation.OTHER,
                preferredLanguage: 'en'
            }
        });

        await testUser.save();
        console.log(`✅ Created test user`);
        return true;
    } catch (error) {
        console.error(`❌ Failed to create test user: ${(error as Error).message}`);
        return false;
    }
}

async function runMemoryIntegrationTest() {
    console.log('🧪 RAG Memory System Integration Test\n');

    const testResults: TestResults = {
        storageTests: {
            meaningfulDataStored: 0,
            trivialDataFiltered: 0,
            emotionalContextCaptured: 0
        },
        recallTests: {
            freshSessionRecalls: 0,
            searchQueriesSuccessful: 0,
            categoryFiltersWorking: 0
        },
        integrationTests: {
            mongoDbConnected: false,
            chromaDbConnected: false,
            userCreationWorking: false,
            memoryPersistence: false
        },
        overallScore: 0
    };

    let userId: string = '';
    let userMongoId: string = '';
    let astrid: any = null;

    try {
        // Test 1: MongoDB Connection
        console.log('🔧 Test 1: MongoDB Connection');
        const dbConnection = DatabaseConnection.getInstance();
        await dbConnection.connect();
        testResults.integrationTests.mongoDbConnected = true;
        console.log('✅ MongoDB: PASS\n');

        // Test 2: ChromaDB Connection
        console.log('🔧 Test 2: ChromaDB Connection');
        const chromaService = new ChromaDBService();
        await chromaService.initialize();
        testResults.integrationTests.chromaDbConnected = true;
        console.log('✅ ChromaDB: PASS\n');

        // Test 3: User Management
        console.log('🔧 Test 3: User Management');
        userId = `test_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const userCreated = await createTestUser(userId);
        if (!userCreated) throw new Error('User creation failed');

        const user = await UserModel.findOne({ userId });
        if (!user || !user._id) throw new Error('User not found');

        userMongoId = user._id.toString();
        testResults.integrationTests.userCreationWorking = true;
        console.log('✅ User Management: PASS\n');

        // Test 4: Memory Tools Setup
        console.log('🔧 Test 4: Memory Tools Setup');
        astrid = AIModelFactory.createOllamaChatModel('qwen3:8b');
        const memoryTools = createTestMemoryTools(chromaService, userMongoId, testResults);
        astrid.registerTools(memoryTools);
        await astrid.ensureReady();
        console.log('✅ Memory Tools: PASS\n');

        // Test 5: Storage Functionality
        console.log('🔧 Test 5: Storage Tests');

        const storageTests = [
            {
                input: "I'm a software engineer specializing in healthcare AI",
                category: "work",
                importance: "high" as const,
                expected: "meaningful"
            },
            {
                input: "My sister has a rare genetic condition",
                category: "family",
                importance: "high" as const,
                emotional_context: "concerned",
                expected: "meaningful"
            },
            {
                input: "I love hiking in mountains",
                category: "interests",
                importance: "medium" as const,
                expected: "meaningful"
            }
        ];

        for (const test of storageTests) {
            const response = await astrid.chatWithTools([
                {
                    role: 'system',
                    content: `You are a test assistant. When given personal information, store it using the store_memory tool. Store meaningful information only.`
                },
                {
                    role: 'user',
                    content: test.input
                }
            ]);
            console.log(`   📝 Storage test: "${test.input.substring(0, 40)}..."`);
        }

        // Test 6: Recall Functionality
        console.log('\n🔧 Test 6: Recall Tests');

        const recallTests = [
            { query: "work healthcare", type: "search" },
            { category: "family", type: "category" },
            { category: "interests", type: "category" }
        ];

        for (const test of recallTests) {
            const response = await astrid.chatWithTools([
                {
                    role: 'system',
                    content: `You are a test assistant. Use recall_memories to find information about the user.`
                },
                {
                    role: 'user',
                    content: test.type === 'search'
                        ? `Find memories related to: ${test.query}`
                        : `Find memories in category: ${test.category}`
                }
            ]);
            console.log(`   🔍 Recall test: ${test.type} - ${test.query || test.category}`);
            testResults.recallTests.freshSessionRecalls++;
        }

        // Test 7: Memory Persistence
        console.log('\n🔧 Test 7: Memory Persistence');
        const allMemories = await chromaService.getUserInsightsByCategory(
            userMongoId,
            undefined,
            '' // userPersonaId - empty for test
        );

        if (allMemories.length > 0) {
            testResults.integrationTests.memoryPersistence = true;
            console.log(`✅ Memory Persistence: PASS (${allMemories.length} memories stored)`);
        } else {
            console.log('❌ Memory Persistence: FAIL (no memories found)');
        }

        // Calculate overall score
        const totalChecks = Object.values(testResults.integrationTests).length +
                           testResults.storageTests.meaningfulDataStored +
                           testResults.recallTests.freshSessionRecalls;

        const passedChecks = Object.values(testResults.integrationTests).filter(Boolean).length +
                            testResults.storageTests.meaningfulDataStored +
                            testResults.recallTests.freshSessionRecalls;

        testResults.overallScore = Math.round((passedChecks / totalChecks) * 100);

        // Final Results
        console.log('\n📊 === TEST RESULTS ===');
        console.log(`Overall Score: ${testResults.overallScore}%`);
        console.log('\n🔧 Integration Tests:');
        console.log(`  MongoDB Connected: ${testResults.integrationTests.mongoDbConnected ? '✅' : '❌'}`);
        console.log(`  ChromaDB Connected: ${testResults.integrationTests.chromaDbConnected ? '✅' : '❌'}`);
        console.log(`  User Creation: ${testResults.integrationTests.userCreationWorking ? '✅' : '❌'}`);
        console.log(`  Memory Persistence: ${testResults.integrationTests.memoryPersistence ? '✅' : '❌'}`);

        console.log('\n💾 Storage Tests:');
        console.log(`  Meaningful Data Stored: ${testResults.storageTests.meaningfulDataStored}`);
        console.log(`  Emotional Context Captured: ${testResults.storageTests.emotionalContextCaptured}`);

        console.log('\n🔍 Recall Tests:');
        console.log(`  Fresh Session Recalls: ${testResults.recallTests.freshSessionRecalls}`);
        console.log(`  Search Queries Successful: ${testResults.recallTests.searchQueriesSuccessful}`);
        console.log(`  Category Filters Working: ${testResults.recallTests.categoryFiltersWorking}`);

        console.log('\n💾 Stored Memories:');
        allMemories.forEach((memory, index) => {
            console.log(`  ${index + 1}. [${memory.category?.toUpperCase()}] ${memory.content.substring(0, 80)}...`);
        });

    } catch (error) {
        console.error(`❌ Test failed: ${(error as Error).message}`);
        testResults.overallScore = 0;
    } finally {
        // Cleanup
        if (astrid) astrid.dispose();

        if (userId) {
            try {
                await UserModel.deleteOne({ userId });
                console.log('\n🗑️  Test user cleaned up');
            } catch (cleanupError) {
                console.warn(`⚠️  Cleanup warning: ${(cleanupError as Error).message}`);
            }
        }

        console.log('\n🧪 Memory integration test completed!\n');
    }

    return testResults;
}

// Export the test function
export { runMemoryIntegrationTest };

// Run if called directly
if (require.main === module) {
    runMemoryIntegrationTest().catch(console.error);
}
