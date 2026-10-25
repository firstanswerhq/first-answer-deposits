import { generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGroq } from '@ai-sdk/groq';
import { config } from '../config.js';

// Which AI runs the front desk. Set one key (or several plus AI_PROVIDER to pick):
//   ANTHROPIC_API_KEY  -> Claude (best quality)
//   GROQ_API_KEY       -> Groq free tier (fast, generous free limits)
//   GOOGLE_GENERATIVE_AI_API_KEY -> Gemini free tier
// With no key the app runs a scripted demo bot, so anyone can try the full flow.
const builders = {
  anthropic: () => config.ai.anthropicKey && { model: createAnthropic({ apiKey: config.ai.anthropicKey })(config.ai.anthropicModel), name: `Claude (${config.ai.anthropicModel})` },
  groq: () => config.ai.groqKey && { model: createGroq({ apiKey: config.ai.groqKey })(config.ai.groqModel), name: `Groq (${config.ai.groqModel})` },
  google: () => config.ai.googleKey && { model: createGoogleGenerativeAI({ apiKey: config.ai.googleKey })(config.ai.googleModel), name: `Gemini (${config.ai.googleModel})` },
};

let cached;
export function getModel() {
  if (cached !== undefined) return cached;
  const order = config.ai.provider && builders[config.ai.provider] ? [config.ai.provider] : ['anthropic', 'groq', 'google'];
  cached = null;
  for (const id of order) {
    const m = builders[id]();
    if (m) {
      cached = { ...m, provider: id };
      break;
    }
  }
  return cached;
}

// Tests swap in a mock model to exercise the AI path without a key.
export function _setModelForTests(m) {
  cached = m;
}

export function modelLabel() {
  return getModel()?.name || 'Scripted demo mode (no AI key set)';
}

// One tiny call at startup so a wrong key or model name shows up in the logs and on /api/health right away.
export const aiStatus = { checked: false, ok: null, error: null };
export async function checkModel() {
  const m = getModel();
  if (!m) return aiStatus;
  try {
    const r = await generateText({ model: m.model, prompt: 'Reply with the single word OK.', maxOutputTokens: 20 });
    Object.assign(aiStatus, { checked: true, ok: true, error: null, sample: (r.text || '').slice(0, 20) });
  } catch (err) {
    Object.assign(aiStatus, { checked: true, ok: false, error: String(err.message || err).slice(0, 300) });
    console.error(`AI check failed for ${m.name}: ${aiStatus.error}`);
  }
  return aiStatus;
}
