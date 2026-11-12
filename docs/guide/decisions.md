# Decisions

A decision model answers typed questions about a state in one forward pass. It generates no text: each answer is a probability or a distribution, read from the model's next-token probabilities. Use it where a chat call would be asked to classify, route, score or check something and its reply parsed.

`decide()` speaks the System One protocol, `POST /v1/systemone`.

```typescript
import { AIModel } from 'universal-llm-client';

const model = new AIModel({
  model: 'model-id',
  providers: [{ type: 'ollama' }],
});

const { answers } = await model.decide(
  { ticket: 'I was charged twice. Please refund the extra payment.' },
  {
    team: {
      type: 'choice',
      instructions: 'Which team should handle this ticket?',
      criteria: {
        billing: 'Payments and refunds',
        technical: 'Bugs and integrations',
        other: 'None of the above',
      },
    },
    refund: {
      type: 'noul',
      instructions: 'Does the customer explicitly ask for a refund?',
    },
    urgency: {
      type: 'score',
      instructions: 'How urgent is this ticket?',
      criteria: ['Routine', 'Soon', 'Urgent'],
    },
  },
);

answers.team.choice;          // 'billing' | 'technical' | 'other'
answers.team.probabilities;   // { billing: 0.99, technical: 0.004, other: 0.006 }
answers.refund;               // 0.99, the probability of yes
answers.urgency.score;        // 1.55, between level 0 and level 2
```

The state is a string, or a JSON object or array. Every question in the request is asked about the same state, and each keeps its own id in `answers`.

## Question types

| Type | `criteria` | Answer |
|---|---|---|
| `noul` | Optional `{ true, false }` describing what yes and no look like | `number`: the probability of yes |
| `choice` | An object of option id to description; `null` lets the id describe itself. 1 to 255 options | `{ choice, probabilities, confidence }` with one probability per option |
| `score` | An array of level descriptions, lowest first. 1 to 10 levels | `{ score, probabilities, confidence }`; `score` is the expected level index, `probabilities` is ordered by level |

A request carries 1 to 64 questions. A request outside these bounds is rejected before anything is sent. A server may set lower limits of its own; the number of options a choice accepts depends on the model.

The answer types follow the questions you pass: `answers.team.choice` is typed as the union of the option ids you declared.

## Reading the answers

Probabilities are relative to the options supplied. A state with no evidence at all still produces a winner, so the library returns the distribution and leaves the decision to you: pick a threshold, and decide what happens below it.

- A `choice` whose top two options are tied is returned as sent. The `choice` field then follows the order the options were declared in.
- `confidence` says how concentrated the distribution is, from 0 to 1. Servers compute it differently, and it is not the chance that the answer is right. Compare probabilities, not confidences, across servers.
- Independent properties that can hold together belong in separate `noul` questions, not in one `choice`.

A response is validated against the questions asked: every question must have an answer of its type, every declared option must have a probability, and a distribution must sum to one. One malformed answer rejects the whole response with `DecisionResponseError`.

## Options

```typescript
await model.decide(state, questions, {
  images: [base64Png],          // shared by every question; vision decision models only
  model: 'another-model-id',    // for this call
  timeout: 20_000,
  signal: controller.signal,
  sessionKey: conversationId,   // keep hitting the same node of a pool
  extraBody: { temperature: 1.5 },
});
```

`images` are raw base64, not data URLs. `extraBody` carries request fields that a server defines beyond the protocol; it is merged into the request on the OpenAI-compatible protocol and is not sent on the Ollama protocol. The protocol's own fields always win over it.

## Protocols

| `type` | Endpoint | Notes |
|---|---|---|
| `ollama` | `<url>/v1/systemone` | The context and batch size come from the model, not from the request. Probabilities rounded to four decimals are accepted and renormalised. `keep_alive` from `defaultParameters` is sent. |
| `openai`, `llamacpp` | `<url>/v1/systemone`, beside the server's other routes (`apiBasePath` applies) | For servers that add the endpoint to an OpenAI-compatible API. A distribution must sum to one within `1e-6`. |
| `anthropic`, `google`, `vertex` | None | `decide()` throws `DecisionUnsupportedError`. In a chain, the router passes the provider over. |

## Failover

`decide()` uses the same router as chat: providers sharing a `priority` form a pool, and a lower tier is asked only when the tiers above failed. See [Failover](/guide/failover).

```typescript
const model = new AIModel({
  model: 'model-id',
  providers: [
    { type: 'openai', url: 'http://host-a:8000', priority: 0 },
    { type: 'openai', url: 'http://host-b:8000', priority: 0 },
    { type: 'ollama', model: 'smaller-model-id', priority: 1 },
  ],
});

const result = await model.decide(state, questions);
result.url;     // base URL of the endpoint that answered
result.model;   // the model that server named
```

A fallback on another model answers on another probability scale. A threshold tuned on the primary does not carry over, so a caller that gates on a probability should read `result.url` or `result.model` before applying it.

Two failures are treated differently from an outage:

- **The request does not fit the context.** The router still tries the other providers, which may have room. When every provider that answered refused the request for size, the call rejects with `DecisionContextLimitError`. When one of them was down instead, the call rejects with that outage. A refusal for size never counts against a provider's health.
- **The server answered badly.** `DecisionResponseError` moves the call to the next provider without retrying. The provider is not cooled down.

An aborted call rejects at once. It is not retried on another provider and does not count against one.

## Errors

| Error | When |
|---|---|
| `DecisionContextLimitError` | Every provider that answered refused the request as larger than its context. Extends `LLMHttpError`. |
| `DecisionResponseError` | A server's response did not hold a valid answer to every question. |
| `DecisionUnsupportedError` | The provider's protocol has no decision endpoint. |
| `LLMHttpError` | Any other non-2xx reply, for example a model that is not a decision model. |

`DecisionResponseError` and `DecisionUnsupportedError` extend `DecisionError`.
