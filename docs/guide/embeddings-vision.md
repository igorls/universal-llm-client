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
