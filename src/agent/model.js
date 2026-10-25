import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAnthropic } from '@ai-sdk/anthropic';
import { config } from '../config.js';

let cached;

// Claude if an Anthropic key is set, otherwise Gemini (free tier), otherwise null = scripted mode.
export function getModel() {
  if (cached !== undefined) return cached;
  if (config.ai.anthropicKey) {
    cached = {
      model: createAnthropic({ apiKey: config.ai.anthropicKey })(config.ai.anthropicModel),
      name: `Claude (${config.ai.anthropicModel})`,
    };
  } else if (config.ai.googleKey) {
    cached = {
      model: createGoogleGenerativeAI({ apiKey: config.ai.googleKey })(config.ai.googleModel),
      name: `Gemini (${config.ai.googleModel})`,
    };
  } else {
    cached = null;
  }
  return cached;
}

export function modelLabel() {
  return getModel()?.name || 'Scripted demo mode (no AI key set)';
}
