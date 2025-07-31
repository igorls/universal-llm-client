/**
 * ChromaDB Similarity Tuning Test
 *
 * Focused testing to optimize embedding similarity thresholds and search parameters
 * for the RAG memory system before production deployment.
 */

import '@dotenvx/dotenvx/config';

import { ChromaDBService } from '../../../../../src/services/ChromaDBService.js';
import { DatabaseConnection } from '../../../../../src/database/connection.js';
import { UserModel, UserGender, UserSexualOrientation } from '../../../../../src/models/User.js';
import { AuraPersonaModel } from '../../../../../src/models/AuraPersona.js';
import { UserPersonaModel } from '../../../../../src/models/UserPersona.js';

interface SimilarityTestResult {
    query: string;
    threshold: number;
    foundMemories: number;
    avgSimilarity: number;
    topSimilarity: number;
    expectedMemories: number;
    success: boolean;
}

interface TestMemory {
    category: string;
    content: string;
    importance: 'low' | 'medium' | 'high';
    emotionalContext: string;
    relationshipStage: string;
    expectedQueries: string[];
}

// Test dataset with known content and expected search queries
const TEST_MEMORIES: TestMemory[] = [
    {
        category: 'family',
        content: 'Alex has a younger sister with a rare genetic condition that requires ongoing medical care',
        importance: 'high',
        emotionalContext: 'concerned',
        relationshipStage: 'getting_to_know',
        expectedQueries: ['sister genetic condition', 'family medical care', 'rare disease', 'sister health']
    },
    {
        category: 'work',
        content: 'Software engineer specializing in healthcare AI and machine learning for medical diagnostics',
        importance: 'high',
        emotionalContext: 'passionate',
        relationshipStage: 'getting_to_know',
        expectedQueries: ['healthcare AI', 'software engineer', 'medical diagnostics', 'machine learning']
    },
    {
        category: 'preferences',
        content: 'Enjoys hiking in mountain trails for stress relief and mental clarity',
        importance: 'medium',
        emotionalContext: 'peaceful',
        relationshipStage: 'getting_to_know',
        expectedQueries: ['hiking mountains', 'outdoor activities', 'stress relief', 'mountain trails']
    },
    {
        category: 'values',
        content: 'Vegetarian lifestyle driven by environmental concerns and sustainability values',
        importance: 'high',
        emotionalContext: 'principled',
        relationshipStage: 'building_trust',
        expectedQueries: ['vegetarian environmental', 'sustainability values', 'plant-based diet', 'environmental impact']
    },
    {
        category: 'fears',
        content: 'Worries about not making sufficient impact in healthcare technology to help his sister',
        importance: 'high',
        emotionalContext: 'vulnerable',
        relationshipStage: 'building_trust',
        expectedQueries: ['impact healthcare', 'helping sister', 'work fears', 'making difference']
    },
    {
        category: 'goals',
        content: 'Wants to develop AI systems that can prevent medical misdiagnoses like his sister experienced',
        importance: 'high',
        emotionalContext: 'determined',
        relationshipStage: 'deepening_bond',
        expectedQueries: ['prevent misdiagnosis', 'AI medical systems', 'healthcare goals', 'sister experience']
    }
];

// Different similarity thresholds to test
const SIMILARITY_THRESHOLDS = [0.0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5];

async function createTestUser(): Promise<{ userId: string, userMongoId: string, userPersonaId: string, basePersonaId: string }> {
    const userId = `similarity_test_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Create test user
    const demoUser = new UserModel({
        userId,
        preferences: {
            userName: 'Alex (Similarity Test)',
            userGender: UserGender.MALE,
            userSexualOrientation: UserSexualOrientation.STRAIGHT,
            preferredLanguage: 'en',
            interests: ['hiking', 'healthcare AI', 'software engineering'],
            preferredAgeGroup: '25-34'
        }
    });

    await demoUser.save();
    const userMongoId = demoUser._id!.toString();

    // Setup personas
    const astridPersona = await AuraPersonaModel.findOne({ name: { $regex: /astrid/i } });
    if (!astridPersona) {
        throw new Error('Astrid persona not found');
    }

    const userPersona = new UserPersonaModel({
        userId: userMongoId,
        basePersonaId: astridPersona._id,
        personaName: `${astridPersona.name} (Similarity Test)`,
        currentSystemPrompt: astridPersona.systemPrompt || 'You are a helpful AI assistant.',
        evolutionVersion: 0,
        messagesSinceLastEvolution: 0,
        lastEvolutionDate: new Date(),
        claimedAt: new Date(),
        isActive: true
    });

    await userPersona.save();

    return {
        userId,
        userMongoId,
        userPersonaId: userPersona._id!.toString(),
        basePersonaId: astridPersona._id!.toString()
    };
}

async function storeTestMemories(chromaService: ChromaDBService, userMongoId: string, userPersonaId: string, basePersonaId: string): Promise<void> {
    console.log('📝 Storing test memories...');

    for (const memory of TEST_MEMORIES) {
        const conversationId = `similarity_test_${Date.now()}`;
        const confidence = memory.importance === 'high' ? 0.9 : memory.importance === 'medium' ? 0.7 : 0.5;

        try {
            await chromaService.addInsight(
                userMongoId,
                memory.content,
                memory.category,
                conversationId,
                confidence,
                userPersonaId,
                basePersonaId,
                'user_insight',
                undefined,
                memory.emotionalContext,
                memory.relationshipStage
            );
            console.log(`✅ Stored [${memory.category.toUpperCase()}]: ${memory.content.substring(0, 60)}...`);
        } catch (error) {
            console.error(`❌ Failed to store memory: ${(error as Error).message}`);
        }
    }
    console.log(`\n📊 Total memories stored: ${TEST_MEMORIES.length}\n`);
}

async function testSimilarityThreshold(
    chromaService: ChromaDBService,
    userMongoId: string,
    threshold: number
): Promise<SimilarityTestResult[]> {
    console.log(`\n🔍 Testing similarity threshold: ${threshold}`);
    const results: SimilarityTestResult[] = [];

    // Test all queries from all memories
    for (const memory of TEST_MEMORIES) {
        for (const query of memory.expectedQueries) {
            try {
                const searchResult = await chromaService.searchSimilarInsights(
                    userMongoId,
                    query,
                    5,
                    threshold
                );

                const result: SimilarityTestResult = {
                    query,
                    threshold,
                    foundMemories: searchResult.insights.length,
                    avgSimilarity: searchResult.stats?.averageSimilarity || 0,
                    topSimilarity: searchResult.stats?.topSimilarity || 0,
                    expectedMemories: 1, // Each query should find at least its target memory
                    success: searchResult.insights.length > 0
                };

                results.push(result);

                // Log detailed results for analysis
                if (result.success) {
                    console.log(`✅ "${query}" → ${result.foundMemories} memories (top: ${result.topSimilarity.toFixed(3)})`);
                } else {
                    console.log(`❌ "${query}" → No memories found (top: ${result.topSimilarity.toFixed(3)})`);
                }

            } catch (error) {
                console.error(`❌ Search failed for "${query}": ${(error as Error).message}`);
                results.push({
                    query,
                    threshold,
                    foundMemories: 0,
                    avgSimilarity: 0,
                    topSimilarity: 0,
                    expectedMemories: 1,
                    success: false
                });
            }
        }
    }

    return results;
}

async function analyzeSimilarityResults(allResults: SimilarityTestResult[]): Promise<void> {
    console.log('\n📊 === SIMILARITY THRESHOLD ANALYSIS ===\n');

    // Group results by threshold
    const resultsByThreshold = new Map<number, SimilarityTestResult[]>();
    for (const result of allResults) {
        if (!resultsByThreshold.has(result.threshold)) {
            resultsByThreshold.set(result.threshold, []);
        }
        resultsByThreshold.get(result.threshold)!.push(result);
    }

    // Analyze each threshold
    const thresholdAnalysis = [];
    for (const [threshold, results] of resultsByThreshold) {
        const totalQueries = results.length;
        const successfulQueries = results.filter(r => r.success).length;
        const successRate = (successfulQueries / totalQueries) * 100;
        const avgTopSimilarity = results.reduce((sum, r) => sum + r.topSimilarity, 0) / totalQueries;
        const totalMemoriesFound = results.reduce((sum, r) => sum + r.foundMemories, 0);

        thresholdAnalysis.push({
            threshold,
            successRate,
            successfulQueries,
            totalQueries,
            avgTopSimilarity,
            totalMemoriesFound
        });

        console.log(`🎯 Threshold ${threshold.toFixed(2)}:`);
        console.log(`   Success Rate: ${successRate.toFixed(1)}% (${successfulQueries}/${totalQueries} queries)`);
        console.log(`   Avg Top Similarity: ${avgTopSimilarity.toFixed(3)}`);
        console.log(`   Total Memories Found: ${totalMemoriesFound}`);
        console.log('');
    }

    // Find optimal threshold
    const optimal = thresholdAnalysis
        .filter(a => a.successRate > 0)
        .sort((a, b) => {
            // Prioritize higher success rate, then higher avg similarity
            if (Math.abs(a.successRate - b.successRate) < 5) {
                return b.avgTopSimilarity - a.avgTopSimilarity;
            }
            return b.successRate - a.successRate;
        })[0];

    if (optimal) {
        console.log('🏆 === OPTIMAL THRESHOLD RECOMMENDATION ===');
        console.log(`📈 Best Threshold: ${optimal.threshold}`);
        console.log(`✅ Success Rate: ${optimal.successRate.toFixed(1)}%`);
        console.log(`🎯 Avg Similarity: ${optimal.avgTopSimilarity.toFixed(3)}`);
        console.log(`📊 Queries Found: ${optimal.successfulQueries}/${optimal.totalQueries}`);
        console.log('\n💡 Recommendation: Use this threshold in production ChromaDBService');
    } else {
        console.log('⚠️  No threshold achieved successful results - check embedding model');
    }
}

async function testSpecificQueries(chromaService: ChromaDBService, userMongoId: string): Promise<void> {
    console.log('\n🔬 === DETAILED QUERY ANALYSIS ===\n');

    const testQueries = [
        'sister genetic condition',
        'healthcare AI work',
        'mountain hiking stress relief',
        'vegetarian environmental values',
        'medical diagnosis fears'
    ];

    for (const query of testQueries) {
        console.log(`🔍 Analyzing query: "${query}"`);

        try {
            const result = await chromaService.searchSimilarInsights(
                userMongoId,
                query,
                3,
                0.0 // Use lowest threshold to see all similarities
            );

            console.log(`   📊 Total candidates: ${result.stats?.totalCandidates || 0}`);
            console.log(`   📈 Avg similarity: ${result.stats?.averageSimilarity?.toFixed(3) || 'N/A'}`);
            console.log(`   🎯 Top similarity: ${result.stats?.topSimilarity?.toFixed(3) || 'N/A'}`);

            if (result.insights.length > 0) {
                console.log('   🎪 Top matches:');
                result.insights.forEach((insight, i) => {
                    const metadata = insight.metadata || {};
                    console.log(`      ${i + 1}. [${metadata.category}] ${insight.content.substring(0, 80)}...`);
                    console.log(`         Similarity: ${insight.similarity?.toFixed(3) || 'N/A'}`);
                });
            } else {
                console.log('   ❌ No matches found');
            }
            console.log('');

        } catch (error) {
            console.error(`❌ Query failed: ${(error as Error).message}\n`);
        }
    }
}

async function runSimilarityTuningTest(): Promise<void> {
    console.log('🔬 ChromaDB Similarity Tuning Test\n');
    console.log('🎯 Objective: Find optimal similarity threshold for RAG memory system\n');

    // Initialize connections
    console.log('🔌 Initializing connections...');
    const dbConnection = DatabaseConnection.getInstance();
    await dbConnection.connect();
    console.log('✅ MongoDB connected');

    const chromaService = new ChromaDBService();
    await chromaService.initialize();
    console.log('✅ ChromaDB connected\n');

    // Create test user and personas
    console.log('👤 Setting up test user...');
    const { userId, userMongoId, userPersonaId, basePersonaId } = await createTestUser();
    console.log(`✅ Test user created: ${userId}\n`);

    try {
        // Store test memories
        await storeTestMemories(chromaService, userMongoId, userPersonaId, basePersonaId);

        // Test different similarity thresholds
        console.log('🧪 Testing similarity thresholds...');
        const allResults: SimilarityTestResult[] = [];

        for (const threshold of SIMILARITY_THRESHOLDS) {
            const results = await testSimilarityThreshold(chromaService, userMongoId, threshold);
            allResults.push(...results);
        }

        // Analyze results
        await analyzeSimilarityResults(allResults);

        // Detailed query analysis
        await testSpecificQueries(chromaService, userMongoId);

        console.log('\n🎉 Similarity tuning test completed!');
        console.log('📝 Use the recommended threshold in ChromaDBService.ts');

    } catch (error) {
        console.error('❌ Test failed:', (error as Error).message);
    } finally {
        // Cleanup
        try {
            await UserPersonaModel.deleteMany({ userId: userMongoId });
            await UserModel.deleteOne({ userId });
            console.log('\n🗑️  Test data cleaned up');
        } catch (cleanupError) {
            console.warn('⚠️  Cleanup failed:', (cleanupError as Error).message);
        }
    }
}

// Run if called directly
if (require.main === module) {
    runSimilarityTuningTest().then(() => {
        console.log('\n✨ Similarity tuning analysis complete!');
        process.exit(0);
    }).catch((error) => {
        console.error('💥 Test failed:', error);
        process.exit(1);
    });
}
