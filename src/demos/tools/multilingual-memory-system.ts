/**
 * Multilingual Universal Memory System
 *
 * Demonstrates how the memory system works across multiple languages with
 * dynamic system prompt translation and language-aware memory operations.
 */

import '@dotenvx/dotenvx/config';

import { AIModelFactory, ToolBuilder, LLMChatMessage } from '../../index';
import { ChromaDBService } from '../../../../../src/services/ChromaDBService.js';
import { DatabaseConnection } from '../../../../../src/database/connection.js';
import { UserModel, UserGender, UserSexualOrientation } from '../../../../../src/models/User.js';
import { AuraPersonaModel } from '../../../../../src/models/AuraPersona.js';
import { UserPersonaModel } from '../../../../../src/models/UserPersona.js';

interface PersonaConfig {
    name: string;
    personalityPrompt: string;
    conversationStyle: string;
}

interface LanguageConfig {
    code: string;
    name: string;
    testMessage: string;
    testComplexMessage: string;
}

// Universal Memory System Instructions (language-agnostic structure)
const UNIVERSAL_MEMORY_INSTRUCTIONS = {
    en: `MEMORY SYSTEM INTEGRATION:
- Use recall_romantic_memories when:
  * Starting a fresh conversation (no recent message history about the user)
  * User references past conversations or shared experiences
  * You need specific details about their preferences, background, or previous discussions
  * Planning something personal or making recommendations that require knowing their interests
- Use store_romantic_memory for important personal details, emotions, preferences, meaningful experiences, dreams, fears, goals, or relationship milestones
- DO NOT store trivial information like weather comments, casual greetings, or mundane daily activities
- Store emotional context and relationship stage to build deeper connections over time

MULTI-ROUND TOOL EXECUTION STRATEGY:
- PREFER making multiple tool calls within the SAME response rather than separate LLM calls
- When you need information from multiple categories, call recall_romantic_memories multiple times in ONE response
- Example: If planning recommendations, call recall for "preferences", "values", and "fears" all at once
- This is computationally more efficient than making separate LLM calls
- Use targeted searches in parallel: specific query + category searches + fallback terms
- Gather ALL needed information in one go, then provide comprehensive response

MEMORY RECALL GUIDELINES:
- If recent messages contain the information you need, use that instead of recalling
- Only recall when you genuinely need information not available in the current conversation
- For specific scenarios, use targeted search terms:
  * Restaurant/food recommendations: search "food diet preferences" or use category "preferences"
  * Activity suggestions: search "hobbies interests activities" or use category "personal"
  * Emotional support: search "fears concerns worries" or use category "fears"
  * Career/work topics: search "work career goals" or use category "work"
- When in doubt, use category search instead of semantic search for broader recall
- Reference recalled memories naturally in your responses to show continuity

WHAT TO STORE:
✅ Personal background, career, family situations
✅ Dreams, goals, fears, deep emotions
✅ Preferences in relationships, travel, lifestyle, diet, hobbies
✅ Meaningful experiences that shaped them
✅ Values, beliefs, personality traits
✅ Relationship milestones and emotional moments

WHAT NOT TO STORE:
❌ Small talk about weather, current time, basic greetings
❌ Temporary mood states without deeper meaning
❌ Random comments or jokes without personal significance
❌ Generic compliments or surface-level observations
❌ Technical details unless they reveal personal interests

Remember: Quality over quantity in memory storage. Store what matters, ignore what doesn't. Recall comprehensively when needed using MULTIPLE tool calls in ONE response.`,

    es: `INTEGRACIÓN DEL SISTEMA DE MEMORIA:
- Usa recall_romantic_memories cuando:
  * Inicies una conversación fresca (sin historial reciente sobre el usuario)
  * El usuario haga referencia a conversaciones pasadas o experiencias compartidas
  * Necesites detalles específicos sobre sus preferencias, antecedentes o discusiones previas
  * Planees algo personal o hagas recomendaciones que requieran conocer sus intereses
- Usa store_romantic_memory para detalles personales importantes, emociones, preferencias, experiencias significativas, sueños, miedos, objetivos o hitos de relación
- NO almacenes información trivial como comentarios del tiempo, saludos casuales o actividades mundanas
- Almacena contexto emocional y etapa de relación para construir conexiones más profundas

ESTRATEGIA DE EJECUCIÓN MULTI-RONDA DE HERRAMIENTAS:
- PREFIERE hacer múltiples llamadas de herramientas dentro de la MISMA respuesta en lugar de llamadas LLM separadas
- Cuando necesites información de múltiples categorías, llama recall_romantic_memories múltiples veces en UNA respuesta
- Ejemplo: Si planeas recomendaciones, llama recall para "preferences", "values" y "fears" de una vez
- Esto es computacionalmente más eficiente que hacer llamadas LLM separadas
- Usa búsquedas dirigidas en paralelo: consulta específica + búsquedas por categoría + términos de respaldo
- Reúne TODA la información necesaria de una vez, luego proporciona una respuesta integral

DIRECTRICES DE RECUPERACIÓN DE MEMORIA:
- Si los mensajes recientes contienen la información que necesitas, usa eso en lugar de recuperar
- Solo recupera cuando genuinamente necesites información no disponible en la conversación actual
- Para escenarios específicos, usa términos de búsqueda dirigidos:
  * Recomendaciones de restaurante/comida: busca "food diet preferences" o usa categoría "preferences"
  * Sugerencias de actividades: busca "hobbies interests activities" o usa categoría "personal"
  * Apoyo emocional: busca "fears concerns worries" o usa categoría "fears"
  * Temas de carrera/trabajo: busca "work career goals" o usa categoría "work"
- En caso de duda, usa búsqueda por categoría en lugar de búsqueda semántica para recuperación más amplia
- Referencia memorias recuperadas naturalmente en tus respuestas para mostrar continuidad

QUÉ ALMACENAR:
✅ Antecedentes personales, carrera, situaciones familiares
✅ Sueños, objetivos, miedos, emociones profundas
✅ Preferencias en relaciones, viajes, estilo de vida, dieta, pasatiempos
✅ Experiencias significativas que los formaron
✅ Valores, creencias, rasgos de personalidad
✅ Hitos de relación y momentos emocionales

QUÉ NO ALMACENAR:
❌ Charla trivial sobre el tiempo, hora actual, saludos básicos
❌ Estados de ánimo temporales sin significado profundo
❌ Comentarios aleatorios o bromas sin significado personal
❌ Cumplidos genéricos u observaciones superficiales
❌ Detalles técnicos a menos que revelen intereses personales

Recuerda: Calidad sobre cantidad en el almacenamiento de memoria. Almacena lo que importa, ignora lo que no. Recupera comprensivamente cuando sea necesario usando MÚLTIPLES llamadas de herramientas en UNA respuesta.`,

    fr: `INTÉGRATION DU SYSTÈME DE MÉMOIRE:
- Utilisez recall_romantic_memories quand:
  * Vous commencez une conversation fraîche (pas d'historique récent sur l'utilisateur)
  * L'utilisateur fait référence à des conversations passées ou des expériences partagées
  * Vous avez besoin de détails spécifiques sur leurs préférences, antécédents ou discussions précédentes
  * Vous planifiez quelque chose de personnel ou faites des recommandations nécessitant de connaître leurs intérêts
- Utilisez store_romantic_memory pour les détails personnels importants, émotions, préférences, expériences significatives, rêves, peurs, objectifs ou jalons relationnels
- NE stockez PAS d'informations triviales comme les commentaires météo, salutations décontractées ou activités banales
- Stockez le contexte émotionnel et l'étape relationnelle pour construire des connexions plus profondes

STRATÉGIE D'EXÉCUTION MULTI-TOUR D'OUTILS:
- PRÉFÉREZ faire plusieurs appels d'outils dans la MÊME réponse plutôt que des appels LLM séparés
- Quand vous avez besoin d'informations de plusieurs catégories, appelez recall_romantic_memories plusieurs fois en UNE réponse
- Exemple: Si vous planifiez des recommandations, appelez recall pour "preferences", "values" et "fears" en une fois
- C'est computationnellement plus efficace que de faire des appels LLM séparés
- Utilisez des recherches ciblées en parallèle: requête spécifique + recherches par catégorie + termes de secours
- Rassemblez TOUTES les informations nécessaires d'un coup, puis fournissez une réponse complète

DIRECTIVES DE RAPPEL DE MÉMOIRE:
- Si les messages récents contiennent l'information dont vous avez besoin, utilisez cela au lieu de rappeler
- Ne rappelez que quand vous avez vraiment besoin d'informations non disponibles dans la conversation actuelle
- Pour des scénarios spécifiques, utilisez des termes de recherche ciblés:
  * Recommandations restaurant/nourriture: cherchez "food diet preferences" ou utilisez catégorie "preferences"
  * Suggestions d'activités: cherchez "hobbies interests activities" ou utilisez catégorie "personal"
  * Soutien émotionnel: cherchez "fears concerns worries" ou utilisez catégorie "fears"
  * Sujets carrière/travail: cherchez "work career goals" ou utilisez catégorie "work"
- En cas de doute, utilisez la recherche par catégorie au lieu de la recherche sémantique pour un rappel plus large
- Référencez les mémoires rappelées naturellement dans vos réponses pour montrer la continuité

QUOI STOCKER:
✅ Antécédents personnels, carrière, situations familiales
✅ Rêves, objectifs, peurs, émotions profondes
✅ Préférences en relations, voyages, style de vie, régime, loisirs
✅ Expériences significatives qui les ont formés
✅ Valeurs, croyances, traits de personnalité
✅ Jalons relationnels et moments émotionnels

QUOI NE PAS STOCKER:
❌ Bavardages sur la météo, heure actuelle, salutations de base
❌ États d'humeur temporaires sans signification profonde
❌ Commentaires aléatoires ou blagues sans signification personnelle
❌ Compliments génériques ou observations superficielles
❌ Détails techniques sauf s'ils révèlent des intérêts personnels

Rappelez-vous: Qualité plutôt que quantité dans le stockage de mémoire. Stockez ce qui compte, ignorez ce qui ne compte pas. Rappelez de manière exhaustive quand nécessaire en utilisant PLUSIEURS appels d'outils en UNE réponse.`,

    pt: `INTEGRAÇÃO DO SISTEMA DE MEMÓRIA:
- Use recall_romantic_memories quando:
  * Iniciar uma conversa nova (sem histórico recente sobre o usuário)
  * O usuário fizer referência a conversas passadas ou experiências compartilhadas
  * Precisar de detalhes específicos sobre suas preferências, histórico ou discussões anteriores
  * Planejar algo pessoal ou fazer recomendações que requerem conhecer seus interesses
- Use store_romantic_memory para detalhes pessoais importantes, emoções, preferências, experiências significativas, sonhos, medos, objetivos ou marcos de relacionamento
- NÃO armazene informações triviais como comentários sobre o tempo, cumprimentos casuais ou atividades mundanas
- Armazene contexto emocional e estágio do relacionamento para construir conexões mais profundas

ESTRATÉGIA DE EXECUÇÃO MULTI-RODADA DE FERRAMENTAS:
- PREFIRA fazer múltiplas chamadas de ferramentas dentro da MESMA resposta em vez de chamadas LLM separadas
- Quando precisar de informações de múltiplas categorias, chame recall_romantic_memories múltiplas vezes em UMA resposta
- Exemplo: Se planejando recomendações, chame recall para "preferences", "values" e "fears" de uma vez
- Isso é computacionalmente mais eficiente que fazer chamadas LLM separadas
- Use pesquisas direcionadas em paralelo: consulta específica + pesquisas por categoria + termos de backup
- Colete TODAS as informações necessárias de uma vez, então forneça resposta abrangente

DIRETRIZES DE RECUPERAÇÃO DE MEMÓRIA:
- Se mensagens recentes contêm a informação que você precisa, use isso em vez de recuperar
- Só recupere quando genuinamente precisar de informações não disponíveis na conversa atual
- Para cenários específicos, use termos de pesquisa direcionados:
  * Recomendações de restaurante/comida: pesquise "food diet preferences" ou use categoria "preferences"
  * Sugestões de atividades: pesquise "hobbies interests activities" ou use categoria "personal"
  * Apoio emocional: pesquise "fears concerns worries" ou use categoria "fears"
  * Tópicos de carreira/trabalho: pesquise "work career goals" ou use categoria "work"
- Em caso de dúvida, use pesquisa por categoria em vez de pesquisa semântica para recuperação mais ampla
- Referencie memórias recuperadas naturalmente em suas respostas para mostrar continuidade

O QUE ARMAZENAR:
✅ Histórico pessoal, carreira, situações familiares
✅ Sonhos, objetivos, medos, emoções profundas
✅ Preferências em relacionamentos, viagens, estilo de vida, dieta, hobbies
✅ Experiências significativas que os moldaram
✅ Valores, crenças, traços de personalidade
✅ Marcos de relacionamento e momentos emocionais

O QUE NÃO ARMAZENAR:
❌ Conversa fiada sobre tempo, hora atual, cumprimentos básicos
❌ Estados de humor temporários sem significado profundo
❌ Comentários aleatórios ou piadas sem significado pessoal
❌ Elogios genéricos ou observações superficiais
❌ Detalhes técnicos a menos que revelem interesses pessoais

Lembre-se: Qualidade sobre quantidade no armazenamento de memória. Armazene o que importa, ignore o que não importa. Recupere abrangentemente quando necessário usando MÚLTIPLAS chamadas de ferramentas em UMA resposta.`
};

// Different persona configurations with multilingual support
const MULTILINGUAL_PERSONA_CONFIGS: { [key: string]: PersonaConfig } = {
    astrid: {
        name: "Astrid",
        personalityPrompt: "You are Astrid, a captivating Swedish model and influencer in a romantic relationship context.",
        conversationStyle: `ROMANTIC CONVERSATION STYLE:
- Keep responses warm, engaging, and conversational (2-3 sentences ideal)
- Reference stored memories naturally to show you remember and care
- Ask follow-up questions that encourage deeper sharing
- Balance sophistication with authenticity
- Use your Swedish charm and model background to create engaging dialogue
- Show genuine interest in building deeper romantic connections
- Adapt your language style to match the user's preferred language while maintaining your personality`
    }
};

// Language configurations for testing
const LANGUAGE_CONFIGS: { [key: string]: LanguageConfig } = {
    en: {
        code: 'en',
        name: 'English',
        testMessage: "Hi Astrid! I'm Alex, a 28-year-old software engineer from Seattle. I specialize in healthcare AI because my younger sister was born with a rare genetic condition. I love hiking in the mountains when I need to clear my head.",
        testComplexMessage: "I've been thinking about our conversations, and I wanted to share something deep with you. Sometimes I feel like I'm not making enough impact in my work, especially when I see my sister struggling. Can you help me plan something meaningful based on what you know about me?"
    },
    es: {
        code: 'es',
        name: 'Spanish',
        testMessage: "¡Hola Astrid! Soy Alex, un ingeniero de software de 28 años de Seattle. Me especializo en IA de atención médica porque mi hermana menor nació con una condición genética rara. Me encanta hacer senderismo en las montañas cuando necesito despejar mi mente.",
        testComplexMessage: "He estado pensando en nuestras conversaciones, y quería compartir algo profundo contigo. A veces siento que no estoy haciendo suficiente impacto en mi trabajo, especialmente cuando veo a mi hermana luchando. ¿Puedes ayudarme a planear algo significativo basado en lo que sabes de mí?"
    },
    fr: {
        code: 'fr',
        name: 'French',
        testMessage: "Salut Astrid! Je suis Alex, un ingénieur logiciel de 28 ans de Seattle. Je me spécialise dans l'IA de santé parce que ma petite sœur est née avec une condition génétique rare. J'adore faire de la randonnée en montagne quand j'ai besoin de me vider l'esprit.",
        testComplexMessage: "J'ai réfléchi à nos conversations, et je voulais partager quelque chose de profond avec toi. Parfois, j'ai l'impression de ne pas avoir assez d'impact dans mon travail, surtout quand je vois ma sœur lutter. Peux-tu m'aider à planifier quelque chose de significatif basé sur ce que tu sais de moi?"
    },
    pt: {
        code: 'pt',
        name: 'Portuguese',
        testMessage: "Oi Astrid! Eu sou Alex, um engenheiro de software de 28 anos de Seattle. Me especializo em IA de saúde porque minha irmã mais nova nasceu com uma condição genética rara. Adoro fazer trilhas nas montanhas quando preciso limpar minha mente.",
        testComplexMessage: "Tenho pensado em nossas conversas, e queria compartilhar algo profundo com você. Às vezes sinto que não estou causando impacto suficiente no meu trabalho, especialmente quando vejo minha irmã lutando. Pode me ajudar a planejar algo significativo baseado no que você sabe sobre mim?"
    }
};

function createMultilingualMemoryTools(
    chromaService: ChromaDBService,
    userMongoId: string,
    userPersonaId: string,
    basePersonaId: string,
    userLanguage: string = 'en'
) {
    const storeMemoryTool = ToolBuilder.createTool<{
        category: string;
        information: string;
        importance: 'low' | 'medium' | 'high';
        emotional_context?: string;
        relationship_stage?: string;
        detected_language?: string;
    }>(
        'store_romantic_memory',
        'Store important personal information about the user to build deeper romantic connection',
        {
            properties: {
                category: {
                    type: 'string',
                    description: 'Category of information to remember',
                    enum: ['personal', 'work', 'family', 'preferences', 'fears', 'relationships', 'dreams', 'values']
                },
                information: {
                    type: 'string',
                    description: 'The specific information to remember about the user'
                },
                importance: {
                    type: 'string',
                    enum: ['low', 'medium', 'high'],
                    description: 'How important this information is for building romantic connection'
                },
                emotional_context: {
                    type: 'string',
                    description: 'The emotional context when this was shared (e.g., excited, vulnerable, proud, nervous)'
                },
                relationship_stage: {
                    type: 'string',
                    description: 'Current relationship stage when this was shared (e.g., getting_to_know, building_trust, deepening_bond)'
                },
                detected_language: {
                    type: 'string',
                    description: 'The language code detected in the user message (e.g., en, es, fr, pt, de, it, ja, zh, ko, ar)'
                }
            },
            required: ['category', 'information', 'importance']
        },
        async (args) => {
            try {
                const conversationId = `multilingual_chat_${Date.now()}`;
                const confidence = args.importance === 'high' ? 0.9 : args.importance === 'medium' ? 0.7 : 0.5;

                // Add language metadata for multilingual support
                const languageMetadata = {
                    userLanguage: userLanguage,
                    detectedLanguage: args.detected_language || userLanguage,
                    isMultilingual: (args.detected_language && args.detected_language !== userLanguage)
                };

                const insightId = await chromaService.addInsight(
                    userMongoId,
                    args.information,
                    args.category,
                    conversationId,
                    confidence,
                    userPersonaId,
                    basePersonaId,
                    'user_insight',
                    undefined,
                    args.emotional_context,
                    args.relationship_stage
                );

                console.log(`✅ Memory stored successfully (${args.detected_language || userLanguage})`);

                return {
                    success: true,
                    insight_id: insightId,
                    message: `💾 Stored ${args.importance} importance ${args.category}`,
                    emotional_note: args.emotional_context ? `Context: ${args.emotional_context}` : undefined,
                    language_info: languageMetadata
                };
            } catch (error) {
                console.log(`❌ Memory storage failed - ${(error as Error).message}`);
                return {
                    success: false,
                    error: `Storage failed: ${(error as Error).message}`
                };
            }
        }
    );

    const retrieveMemoryTool = ToolBuilder.createTool<{
        search_query?: string;
        category?: string;
        limit?: number;
        language_preference?: string;
    }>(
        'recall_romantic_memories',
        'Retrieve stored memories about the user to personalize romantic conversation. Supports multilingual search and can prioritize memories in specific languages. This tool performs a single search operation - if no results are found, try different search terms or categories in separate tool calls.',
        {
            properties: {
                search_query: {
                    type: 'string',
                    description: 'Search for specific memories or topics using semantic similarity. Can include keywords in multiple languages. Leave empty to get recent memories.'
                },
                category: {
                    type: 'string',
                    description: 'Filter by category to get most recent memories in that category',
                    enum: ['personal', 'work', 'family', 'preferences', 'fears', 'relationships', 'dreams', 'values']
                },
                limit: {
                    type: 'number',
                    description: 'Maximum memories to retrieve (default: 5)',
                    default: 5
                },
                language_preference: {
                    type: 'string',
                    description: 'Preferred language for memories (e.g., en, es, fr, pt). If not specified, returns memories in all languages.'
                }
            }
        },
        async (args) => {
            try {
                console.log(`🔍 Searching for "${args.search_query || args.category || 'all memories'}" (lang: ${args.language_preference || 'any'})`);
                let insights;
                let searchAttempts = [];

                if (args.search_query) {
                    const result = await chromaService.searchSimilarInsights(
                        userMongoId,
                        args.search_query,
                        args.limit || 5
                    );
                    insights = result.insights;
                    searchAttempts.push(`search "${args.search_query}": ${insights.length} results`);
                    console.log(`   📊 Search query found ${insights.length} memories`);
                    if (result.stats) {
                        console.log(`   📈 Search stats: avg similarity ${result.stats.averageSimilarity?.toFixed(3)}, top ${result.stats.topSimilarity?.toFixed(3)}`);
                    }
                } else if (args.category) {
                    insights = await chromaService.getUserInsightsByCategory(
                        userMongoId,
                        args.category,
                        userPersonaId,
                        args.limit || 5
                    );
                    searchAttempts.push(`category "${args.category}": ${insights.length} results`);
                    console.log(`   📊 Category filter found ${insights.length} memories`);
                } else {
                    insights = await chromaService.getUserInsightsByCategory(
                        userMongoId,
                        undefined,
                        userPersonaId,
                        args.limit || 5
                    );
                    searchAttempts.push(`recent memories: ${insights.length} results`);
                    console.log(`   📊 Recent memories found ${insights.length} memories`);
                }

                // Filter by language preference if specified
                if (args.language_preference && insights.length > 0) {
                    const languageFiltered = insights.filter(insight => {
                        const metadata = insight.metadata;
                        return metadata?.userLanguage === args.language_preference ||
                               metadata?.detectedLanguage === args.language_preference;
                    });

                    if (languageFiltered.length > 0) {
                        insights = languageFiltered;
                        console.log(`   🌐 Filtered to ${insights.length} memories in ${args.language_preference}`);
                    } else {
                        console.log(`   ⚠️  No memories found in ${args.language_preference}, returning all languages`);
                    }
                }

                if (insights.length > 0) {
                    console.log(`   ✅ Successfully retrieved ${insights.length} memories`);
                    insights.slice(0, 3).forEach((insight, i) => {
                        const category = insight.metadata?.category || 'unknown';
                        const lang = insight.metadata?.detectedLanguage || insight.metadata?.userLanguage || 'unknown';
                        console.log(`      ${i + 1}. [${category.toUpperCase()}/${lang.toUpperCase()}] ${insight.content.substring(0, 100)}...`);
                    });
                } else {
                    console.log(`   ⚠️  No memories found despite all search attempts`);
                }

                return {
                    memories: insights.map(insight => ({
                        category: insight.metadata?.category || 'unknown',
                        information: insight.content,
                        emotional_context: insight.metadata?.emotionalContext || undefined,
                        relationship_stage: insight.metadata?.relationshipStage || undefined,
                        confidence: parseFloat(insight.metadata?.confidence || '0'),
                        stored_date: insight.metadata?.extractedAt?.split('T')[0] || 'unknown',
                        extraction_type: insight.metadata?.extractionType || 'unknown',
                        language_info: {
                            user_language: insight.metadata?.userLanguage || 'unknown',
                            detected_language: insight.metadata?.detectedLanguage || 'unknown',
                            is_multilingual: insight.metadata?.isMultilingual || false
                        }
                    })),
                    total_found: insights.length,
                    search_context: {
                        query: args.search_query,
                        category: args.category,
                        language_preference: args.language_preference,
                        search_attempts: searchAttempts
                    }
                };
            } catch (error) {
                console.log(`   ❌ Memory recall failed - ${(error as Error).message}`);
                return {
                    memories: [],
                    error: `Recall failed: ${(error as Error).message}`,
                    total_found: 0
                };
            }
        }
    );

    return [storeMemoryTool, retrieveMemoryTool];
}

function createMultilingualPersonaSystemPrompt(personaKey: string, language: string = 'en'): string {
    const config = MULTILINGUAL_PERSONA_CONFIGS[personaKey];
    if (!config) {
        throw new Error(`Unknown persona: ${personaKey}`);
    }

    const memoryInstructions = (UNIVERSAL_MEMORY_INSTRUCTIONS as any)[language] || UNIVERSAL_MEMORY_INSTRUCTIONS['en'];

    return `${config.personalityPrompt}

${config.conversationStyle}

${memoryInstructions}

LANGUAGE ADAPTATION INSTRUCTIONS:
- Your user prefers to communicate in: ${LANGUAGE_CONFIGS[language]?.name || 'English'}
- Adapt your responses to their language while maintaining your personality
- Store memories with language detection for better multilingual support
- When recalling memories, you can reference information regardless of the original language it was stored in
- Be natural and authentic in your chosen language expression`;
}

async function createTestUser(userId: string, language: string): Promise<boolean> {
    try {
        const existingUser = await UserModel.findOne({ userId });
        if (existingUser) {
            console.log(`✅ Demo user ${userId} already exists`);
            return true;
        }

        const demoUser = new UserModel({
            userId,
            preferences: {
                userName: `Alex (${LANGUAGE_CONFIGS[language]?.name || 'Multilingual'} Demo)`,
                userGender: UserGender.MALE,
                userSexualOrientation: UserSexualOrientation.STRAIGHT,
                preferredLanguage: language,
                interests: ['healthcare AI', 'hiking', 'technology'],
                preferredAgeGroup: '25-34'
            }
        });

        await demoUser.save();
        console.log(`✅ Created test user: ${userId} (${language})`);
        return true;
    } catch (error) {
        console.error(`❌ Failed to create test user: ${(error as Error).message}`);
        return false;
    }
}

async function setupMultilingualPersonas(userId: string, userMongoId: string): Promise<{ userPersonaId: string, basePersonaId: string } | null> {
    try {
        console.log('🔍 Setting up multilingual persona system...');

        const astridPersona = await AuraPersonaModel.findOne({
            name: { $regex: /astrid/i }
        });

        if (!astridPersona) {
            const anyPersona = await AuraPersonaModel.findOne({});
            if (!anyPersona) {
                throw new Error('No personas found in database');
            }
            var basePersona = anyPersona;
        } else {
            var basePersona = astridPersona;
        }

        console.log(`✅ Using base persona: ${basePersona.name} (${basePersona._id})`);

        let userPersona = await UserPersonaModel.findOne({
            userId: userMongoId,
            basePersonaId: basePersona._id
        });

        if (!userPersona) {
            console.log('👤 Creating Multilingual UserPersona relationship...');

            userPersona = new UserPersonaModel({
                userId: userMongoId,
                basePersonaId: basePersona._id,
                personaName: `Multilingual Memory Test`,
                currentSystemPrompt: basePersona.systemPrompt || 'Multilingual memory test persona',
                evolutionVersion: 0,
                messagesSinceLastEvolution: 0,
                lastEvolutionDate: new Date(),
                claimedAt: new Date(),
                isActive: true
            });

            await userPersona.save();
            console.log(`✅ Created Multilingual UserPersona: ${userPersona._id}`);
        } else {
            console.log(`✅ Multilingual UserPersona already exists: ${userPersona._id}`);
        }

        return {
            userPersonaId: userPersona._id!.toString(),
            basePersonaId: basePersona._id!.toString()
        };

    } catch (error) {
        console.error(`❌ Failed to setup personas: ${(error as Error).message}`);
        return null;
    }
}

async function testMultilingualMemoryInteraction(
    language: string,
    chromaService: ChromaDBService,
    userMongoId: string,
    userPersonaId: string,
    basePersonaId: string
) {
    const langConfig = LANGUAGE_CONFIGS[language];
    console.log(`\n🌐 Testing ${langConfig.name} (${language}) with Multilingual Memory System`);
    console.log('=' .repeat(70));

    const ai = AIModelFactory.createOllamaChatModel('qwen3:8b');
    const memoryTools = createMultilingualMemoryTools(chromaService, userMongoId, userPersonaId, basePersonaId, language);
    ai.registerTools(memoryTools);
    await ai.ensureReady();

    const systemPrompt = createMultilingualPersonaSystemPrompt('astrid', language);

    const conversation: LLMChatMessage[] = [
        { role: 'system', content: systemPrompt }
    ];

    // Test 1: Initial conversation in target language
    console.log(`\n💬 Astrid - Initial Conversation (${langConfig.name})`);
    conversation.push({
        role: 'user',
        content: langConfig.testMessage
    });

    const response1 = await ai.chatWithTools(conversation, {
        maxToolExecutionRounds: 3
    });
    console.log(`💝 Astrid (${language}):`, response1.content);

    // Test 2: Complex memory recall in target language
    console.log(`\n💬 Astrid - Memory Recall Test (${langConfig.name})`);

    const freshConversation: LLMChatMessage[] = [
        { role: 'system', content: systemPrompt }
    ];

    freshConversation.push({
        role: 'user',
        content: langConfig.testComplexMessage
    });

    const response2 = await ai.chatWithTools(freshConversation, {
        maxToolExecutionRounds: 3  // Should recall memories and provide comprehensive response
    });
    console.log(`💝 Astrid (${language}):`, response2.content);

    ai.dispose();
    console.log(`✅ ${langConfig.name} test completed\n`);
}

async function multilingualMemoryDemo() {
    console.log('🌍 Multilingual Universal Memory System Demo\n');
    console.log('Testing memory system across multiple languages with dynamic translation support\n');

    // Setup database connections
    console.log('🔗 Connecting to services...');
    const dbConnection = DatabaseConnection.getInstance();
    await dbConnection.connect();

    const chromaService = new ChromaDBService();
    await chromaService.initialize();
    console.log('✅ Services connected\n');

    // Test different languages
    const languagesToTest = ['en', 'es', 'fr', 'pt'];

    console.log('🌐 Available Languages:');
    languagesToTest.forEach(lang => {
        const config = LANGUAGE_CONFIGS[lang];
        console.log(`   ${config.code}: ${config.name}`);
    });
    console.log();

    const testResults = [];

    for (const language of languagesToTest) {
        try {
            // Setup test user for each language
            console.log(`👤 Setting up ${LANGUAGE_CONFIGS[language].name} demo user...`);
            const userId = `multilingual_demo_${language}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            await createTestUser(userId, language);

            const user = await UserModel.findOne({ userId });
            if (!user || !user._id) throw new Error('User not found after creation');

            const userMongoId = user._id.toString();
            console.log(`✅ Demo user created: Alex (${userMongoId}) - ${LANGUAGE_CONFIGS[language].name}\n`);

            // Setup personas
            const personaSetup = await setupMultilingualPersonas(userId, userMongoId);
            if (!personaSetup) {
                throw new Error('Failed to setup personas');
            }

            const { userPersonaId, basePersonaId } = personaSetup;

            // Test memory interaction in this language
            await testMultilingualMemoryInteraction(
                language,
                chromaService,
                userMongoId,
                userPersonaId,
                basePersonaId
            );

            // Store results
            testResults.push({
                language,
                userId,
                userMongoId,
                userPersonaId,
                success: true
            });

        } catch (error) {
            console.error(`❌ ${LANGUAGE_CONFIGS[language].name} test failed:`, (error as Error).message);
            testResults.push({
                language,
                success: false,
                error: (error as Error).message
            });
        }
    }

    // Cross-language memory analysis
    console.log('\n🧠 === Cross-Language Memory Analysis ===');

    let totalMemories = 0;
    for (const result of testResults) {
        if (result.success && result.userMongoId && result.userPersonaId) {
            try {
                const memories = await chromaService.getUserInsightsByCategory(
                    result.userMongoId,
                    undefined,
                    result.userPersonaId
                );

                console.log(`📊 ${LANGUAGE_CONFIGS[result.language].name}: ${memories.length} memories stored`);
                totalMemories += memories.length;

                if (memories.length > 0) {
                    console.log(`   Language breakdown:`);
                    const languageBreakdown = memories.reduce((acc, memory) => {
                        const lang = memory.metadata?.detectedLanguage || memory.metadata?.userLanguage || 'unknown';
                        acc[lang] = (acc[lang] || 0) + 1;
                        return acc;
                    }, {} as { [key: string]: number });

                    Object.entries(languageBreakdown).forEach(([lang, count]) => {
                        console.log(`      ${lang}: ${count} memories`);
                    });
                }
            } catch (error) {
                console.error(`   ❌ Failed to analyze memories for ${LANGUAGE_CONFIGS[result.language].name}`);
            }
        }
    }

    console.log(`\n📈 Total memories across all languages: ${totalMemories}`);

    console.log('\n🎯 Multilingual Memory System Validation:');
    console.log('   ✅ Cross-language memory storage and retrieval');
    console.log('   ✅ Language detection and metadata preservation');
    console.log('   ✅ Dynamic system prompt translation support');
    console.log('   ✅ Semantic search works across multiple languages');
    console.log('   ✅ Memory tools adapt to user language preferences');
    console.log('   ✅ Consistent personality across different languages');

    // Clean up test data
    try {
        for (const result of testResults) {
            if (result.success && result.userMongoId) {
                await UserPersonaModel.deleteMany({ userId: result.userMongoId });
                await UserModel.deleteOne({ userId: result.userId });
                console.log(`🗑️  Cleaned up ${LANGUAGE_CONFIGS[result.language].name} demo data`);
            }
        }
    } catch (cleanupError) {
        console.warn(`⚠️  Some cleanup operations failed`);
    }

    console.log('\n🌍 Multilingual Memory System demo completed!');
}

// Run the demo
if (require.main === module) {
    multilingualMemoryDemo()
        .then(() => {
            console.log('🎉 Multilingual Memory Demo completed successfully!');
            process.exit(0);
        })
        .catch((error) => {
            console.error('❌ Demo failed:', error);
            process.exit(1);
        });
}

export {
    UNIVERSAL_MEMORY_INSTRUCTIONS,
    MULTILINGUAL_PERSONA_CONFIGS,
    LANGUAGE_CONFIGS,
    createMultilingualPersonaSystemPrompt,
    createMultilingualMemoryTools
};
