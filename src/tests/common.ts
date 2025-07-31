import {MockAgent} from 'undici';
import {AIModelApiType} from '../interfaces.js';

export const testProviders = {
  openai: {
    model: 'gpt-4',
    apiType: AIModelApiType.OpenAI,
    url: 'http://localhost:1234',
    apiKey: 'test-key'
  },
  ollama: {
    model: 'llama3',
    apiType: AIModelApiType.Ollama,
    url: 'http://localhost:11434'
  },
  google: {
    model: 'gemini-pro',
    apiType: AIModelApiType.Google,
    url: 'https://generativelanguage.googleapis.com',
    apiKey: 'test-google-key'
  }
};

export function createTestAgent() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  return agent;
}
