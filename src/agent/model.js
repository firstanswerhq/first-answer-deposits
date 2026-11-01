import { generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { config } from '../config.js';

// Which AI runs the front desk. Set one key (or several plus AI_PROVIDER to pick):
//   ANTHROPIC_API_KEY  -> Claude (best quality)
//   GROQ_API_KEY       -> Groq free tier (fast, generous free limits)
//   GOOGLE_GENERATIVE_AI_API_KEY -> Gemini free tier
//   META_API_KEY       -> Meta's Llama API (OpenAI-compatible endpoint; META_MODEL / META_API_BASE to change)
// With no key the app runs a scripted demo bot, so anyone can try the full flow.
const builders = {
  anthropic: () => config.ai.anthropicKey && { model: createAnthropic({ apiKey: config.ai.anthropicKey })(config.ai.anthropicModel), name: `Claude (${config.ai.anthropicModel})` },
  groq: () => config.ai.groqKey && { model: createGroq({ apiKey: config.ai.groqKey })(config.ai.groqModel), name: `Groq (${config.ai.groqModel})` },
  google: () => config.ai.googleKey && { model: createGoogleGenerativeAI({ apiKey: config.ai.googleKey })(config.ai.googleModel), name: `Gemini (${config.ai.googleModel})` },
  meta: () =>
    config.ai.metaKey && {
      model: createOpenAICompatible({ name: 'meta', baseURL: config.ai.metaBase, apiKey: config.ai.metaKey })(config.ai.metaModel),
      name: `Meta Llama (${config.ai.metaModel})`,
    },
};

// If the first AI fails mid-turn (rate limit, outage, bad key), the same call retries on the next configured one,
// so a second free-tier key is a real backup. Every configured key is tried in order; the last error is thrown.
function withFailover(models) {
  if (models.length < 2) return models[0];
  const [primary, ...backups] = models;
  const attempt = async (method, options) => {
    let lastErr;
    for (const m of models) {
      try {
        return await m.model[method](options);
      } catch (err) {
        lastErr = err;
        if (options?.abortSignal?.aborted) throw err; // the turn timed out: no point retrying elsewhere
        const next = models[models.indexOf(m) + 1];
        if (next) console.error(`${m.name} failed: ${String(err.message || err).slice(0, 200)}. Retrying on ${next.name}.`);
      }
    }
    throw lastErr;
  };
  return {
    ...primary,
    backups: backups.map((b) => b.name),
    providers: models,
    model: {
      specificationVersion: primary.model.specificationVersion,
      provider: primary.model.provider,
      modelId: primary.model.modelId,
      supportedUrls: primary.model.supportedUrls,
      doGenerate: (options) => attempt('doGenerate', options),
      doStream: (options) => attempt('doStream', options),
    },
  };
}

let cached;
export function getModel() {
  if (cached !== undefined) return cached;
  const ORDER = ['anthropic', 'meta', 'groq', 'google'];
  const order = builders[config.ai.provider] ? [config.ai.provider, ...ORDER.filter((k) => k !== config.ai.provider)] : ORDER;
  const models = order.map((id) => {
    const m = builders[id]();
    return m ? { ...m, provider: id } : null;
  }).filter(Boolean);
  cached = models.length ? withFailover(models) : null;
  return cached;
}

export const _withFailoverForTests = withFailover;

// Tests swap in a mock model to exercise the AI path without a key.
export function _setModelForTests(m) {
  cached = m;
}

export function modelLabel() {
  const m = getModel();
  if (!m) return 'Scripted demo mode (no AI key set)';
  return m.backups?.length ? `${m.name}; backup: ${m.backups.join(', ')}` : m.name;
}

// One tiny call per configured AI at startup so a wrong key or model name shows up in the logs and on /api/health
// right away, even when a backup would have covered for it mid-turn.
export const aiStatus = { checked: false, ok: null, error: null };
export async function checkModel() {
  const m = getModel();
  if (!m) return aiStatus;
  const providers = m.providers || [m];
  const results = [];
  for (const p of providers) {
    try {
      const r = await generateText({ model: p.model, prompt: 'Reply with the single word OK.', maxOutputTokens: 20, maxRetries: 1 });
      results.push({ name: p.name, ok: true, error: null, sample: (r.text || '').slice(0, 20) });
    } catch (err) {
      results.push({ name: p.name, ok: false, error: String(err.message || err).slice(0, 300) });
      console.error(`AI check failed for ${p.name}: ${results.at(-1).error}`);
    }
  }
  const first = results[0];
  Object.assign(aiStatus, {
    checked: true,
    ok: results.some((r) => r.ok),
    error: first.ok ? null : first.error,
    sample: results.find((r) => r.ok)?.sample || '',
    ...(results.length > 1 ? { providers: results, runningOn: first.ok ? first.name : results.find((r) => r.ok)?.name || null } : {}),
  });
  return aiStatus;
}
