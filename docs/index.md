---
layout: home
markdownStyles: false
---

<!--
  Samples stay within 46 columns so they fit a phone screen without scrolling.
  The line ranges of the three providers in the first sample are mirrored in
  .vitepress/theme/home/data.ts (demoProviders[].lines).
-->

<HomePage>

<template v-slot:failover>

```ts
import { AIModel } from 'universal-llm-client'

const model = new AIModel({
  model: 'model-id',
  providers: [
    {
      type: 'google',
      apiKey: process.env.GOOGLE_API_KEY,
    },
    {
      type: 'openai',
      url: 'https://openrouter.ai/api',
      apiKey: process.env.OPENROUTER_KEY,
    },
    { type: 'ollama', model: 'local-model' },
  ],
})

const response = await model.chat([
  { role: 'user', content: 'Hello!' },
])
console.log(response.message.content)
```

</template>

<template v-slot:streaming>

```ts
const stream = model.chatStream(messages)

for await (const event of stream) {
  if (event.type === 'text') {
    process.stdout.write(event.content)
  } else if (event.type === 'thinking') {
    console.log('[thinking]', event.content)
  } else if (event.type === 'tool_call') {
    console.log('[tool]', event.calls)
  }
}
```

</template>

<template v-slot:tools>

```ts
model.registerTool(
  'get_weather',
  'Get current weather for a location',
  {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
  async (args) => {
    const { city } = args as { city: string }
    return { city, temperature: 22 }
  },
)

const response = await model.chatWithTools([
  { role: 'user', content: 'Tokyo weather?' },
])

console.log(response.toolExecutions)
```

</template>

<template v-slot:structured>

```ts
import {
  fromZod,
  z,
} from 'universal-llm-client/zod'

const User = fromZod(z.object({
  name: z.string(),
  age: z.number(),
  interests: z.array(z.string()),
}))

// Throws if the output does not validate
const user = await model.generateStructured(
  User,
  messages,
)
user.name // string

// Or take a result object instead
const result = await model.tryParseStructured(
  User,
  messages,
)
if (!result.ok) {
  console.error(result.error.message)
}
```

</template>

<template v-slot:reasoning>

```ts
const model = new AIModel({
  model: 'model-id',
  thinking: 'high', // true, false or a level
  providers: [
    {
      type: 'google',
      apiKey: process.env.GOOGLE_API_KEY,
    },
  ],
})

const res = await model.chat(messages)
res.message.content // the answer
res.reasoning // chain of thought, if exposed

// Override per call
await model.chat(messages, {
  thinking: false,
})
```

</template>

<template v-slot:observability>

```ts
import {
  AIModel,
  BufferedAuditor,
} from 'universal-llm-client'

const auditor = new BufferedAuditor({
  maxBufferSize: 100,
  onFlush: async (events) => {
    await sendToOpenTelemetry(events)
  },
})

const model = new AIModel({
  model: 'model-id',
  providers: [{ type: 'ollama' }],
  auditor,
})
```

</template>

<template v-slot:mcp>

```ts
import {
  MCPToolBridge,
} from 'universal-llm-client'

const filesystem = {
  command: 'npx',
  args: [
    '-y',
    '@modelcontextprotocol/server-filesystem',
    './',
  ],
}

const mcp = new MCPToolBridge({
  servers: {
    filesystem,
    weather: {
      url: 'https://mcp.example.com/weather',
    },
  },
})

await mcp.connect()
await mcp.registerTools(model)

await model.chatWithTools(messages)
await mcp.disconnect()
```

</template>

</HomePage>
