# Embeddings and Vision

## Embeddings

```typescript
const embedder = new AIModel({
  model: 'model-id',
  providers: [{ type: 'ollama' }],
});

const vector = await embedder.embed('Hello, world!');
// number[]

const vectors = await embedder.embedArray(['First document', 'Second document']);
// number[][]
```

Embeddings work on the OpenAI Chat Completions, Gemini and Ollama protocols. The Anthropic Messages client has no embeddings endpoint, and `embed()` on an `anthropic` provider throws. See the [support table](/guide/protocols#support-by-protocol).

Use a separate `AIModel` for embeddings. The model name and the provider chain for embeddings usually differ from those for chat, and `AIModel` holds no conversation state, so two instances cost nothing.

### Tasks, prompt formats and dimensions

`embedMany(inputs, options)` embeds a batch for a task and says what came back:

```typescript
const embedder = new AIModel({
  model: 'model-id',
  providers: [{ type: 'ollama', embeddingPromptFormat: 'embeddinggemma' }],
});

const query = await embedder.embedMany(['how do I cancel?'], { task: 'query' });
const docs = await embedder.embedMany(
  [{ text: 'Open Settings and choose Plan.', title: 'Billing' }],
  { task: 'document', dimensions: 256 },
);
// { embeddings: number[][], model, dimensions, promptFormat, task, inputTokens? }
```

| Option | Meaning |
|---|---|
| `task` | `query`, `document`, `similarity`, `classification`, `clustering` or `code`. Without a task, inputs go as plain text |
| `promptFormat` | A format for this call, by name or value. Overrides the provider's `embeddingPromptFormat` |
| `dimensions` | Output size. Sent where the protocol accepts it; a longer vector is cut to this size and re-normalized (meaningful only for Matryoshka-trained models) |
| `batchSize` | Inputs per request. Default: 32 (Ollama), 128 (OpenAI Chat Completions servers), 100 (Gemini) |
| `truncate` | Ollama only: let the server truncate long inputs. Default `true` |
| `keepAlive` | Ollama only: `keep_alive` for the embedding model |

Retrieval models embed a query and the documents it searches differently. A prompt format turns the task into the model's input, using the templates its model card publishes. The library never picks one from the model name: declare it, because the format is part of the vector space and vectors embedded with different formats do not compare. `EMBEDDING_PROMPT_FORMATS` holds the built-in formats (`none`, `embeddinggemma`, `qwen3-embedding`, `nomic`, `e5`, `mxbai`); any `{ id, templates }` object works too.

The Gemini protocol takes the task natively, as `taskType`, with the document title as `title`, so no prompt format is applied there.

Each protocol sends one request per batch: Ollama `/api/embed`, OpenAI-compatible `/embeddings` (vectors reordered by `index`), Gemini `batchEmbedContents`. A response with a different number of vectors than inputs fails the call. `embed()` and `embedArray()` keep sending plain text.

## Vision

Send images in a user message. `multimodalMessage(text, images, mimeType?)` builds one:

```typescript
import { multimodalMessage } from 'universal-llm-client';

const response = await model.chat([
  multimodalMessage('What do you see in this image?', [
    'https://example.com/photo.jpg',
  ]),
]);
```

| Argument | Meaning |
|---|---|
| `text` | The text part of the message |
| `images` | An array of image sources: an `http(s)` URL, a `data:` URL, or raw base64 |
| `mimeType` | Applied to raw base64 entries. Default `'image/jpeg'` |

The function returns a message with `role: 'user'`. For raw base64 data, pass the type:

```typescript
multimodalMessage('Describe this chart', [base64Png], 'image/png');
```

### Building content parts yourself

For a message with several text and image parts, or to set the image `detail`, compose the parts:

```typescript
import { textContent, imageContent } from 'universal-llm-client';

const response = await model.chat([
  {
    role: 'user',
    content: [
      textContent('Compare these two screenshots.'),
      imageContent('data:image/png;base64,iVBORw0KGgo...'),
      imageContent('https://example.com/other.png', 'image/png', 'high'),
    ],
  },
]);
```

`imageContent(source, mimeType = 'image/jpeg', detail?)` returns an image part. `source` may be a URL, a `data:` URL or raw base64; `mimeType` is used only for raw base64. `detail` is `'auto' | 'low' | 'high'`.

The helpers `extractTextContent(content)` and `hasImages(content)` read a message's content value.

### Support

Image input works on the OpenAI Chat Completions, Anthropic Messages, Gemini and Ollama protocols. On a self-hosted Chat Completions server, including `type: 'llamacpp'`, it depends on the server and the loaded model. Each client converts the parts to its protocol's image format.

### With structured output

```typescript
const analysis = await model.generateStructured(config, [
  multimodalMessage('Describe this image', ['https://example.com/photo.jpg']),
]);
```

`config` is a schema config; see [Structured Output](/guide/structured-output).
