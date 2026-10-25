// The real AI path (tool calling through the Vercel AI SDK) exercised with a mock model, so the tool
// schemas, the message assembly and the booking tools are checked without an API key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { MockLanguageModelV4 } from 'ai/test';

process.env.DATA_FILE = path.join(os.tmpdir(), `fad-ai-${process.pid}.json`);
process.env.PAYPAL_CLIENT_ID = '';
process.env.PAYPAL_CLIENT_SECRET = '';
process.env.GOOGLE_GENERATIVE_AI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.GROQ_API_KEY = '';

const store = await import('../src/store.js');
const B = await import('../src/bookings.js');
const { _setModelForTests } = await import('../src/agent/model.js');
const { replyToCustomer } = await import('../src/agent/customer.js');
const { ownerCommand } = await import('../src/agent/owner.js');

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 }, raw: {} };
const text = (t) => ({ content: [{ type: 'text', text: t }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] });
const call = (name, input) => ({ content: [{ type: 'tool-call', toolCallId: `c_${name}`, toolName: name, input: JSON.stringify(input) }], finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage, warnings: [] });

// Reads tool results back out of the prompt the SDK sends on later steps.
function toolResults(prompt) {
  const out = [];
  for (const m of prompt) {
    if (m.role !== 'tool') continue;
    for (const part of m.content) if (part.type === 'tool-result') out.push({ name: part.toolName, value: part.output?.value ?? part.output });
  }
  return out;
}

test('customer AI books through its tools and the pay link reaches the customer', async () => {
  store.resetAll();
  store.setPreset('cleaning');
  const seen = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      seen.push(options);
      const results = toolResults(options.prompt);
      const toolNames = (options.tools || []).map((t) => t.name);
      assert.ok(toolNames.includes('book_and_send_deposit') && toolNames.includes('get_open_slots'), 'tools are offered to the model');
      if (!results.length) return call('get_open_slots', { day: undefined, count: 3 });
      if (results.length === 1) {
        const slots = results[0].value.slots;
        assert.ok(slots.length >= 1);
        return call('book_and_send_deposit', { serviceId: 'deep', size: '3 bedrooms', slotStart: slots[0].start, customerName: 'Sarah' });
      }
      const booked = results[1].value;
      return text(`You're held for ${booked.appointment}, Sarah! $${booked.depositDueNow} deposit counts toward the $${booked.total} total.`);
    },
  });
  _setModelForTests({ model, name: 'mock' });
  const lead = store.createLead({ presetId: 'cleaning' });
  store.addMessage(lead.id, 'customer', 'Hi, I need a deep clean for 3 bedrooms, first open time, name is Sarah');
  const reply = await replyToCustomer(lead.id);
  assert.match(reply, /You're held for/);
  assert.match(reply, /\/p\/pay_/); // the link is appended when the model leaves it out
  const b = B.activeBookingForLead(lead.id);
  assert.equal(b.status, 'held');
  assert.equal(b.customerName, 'Sarah');
  assert.equal(seen.length, 3);
  const sys = seen[0].prompt.find((m) => m.role === 'system').content;
  assert.match(sys, /PRICE SHEET/);
  assert.match(sys, /Deep clean/);
  _setModelForTests(null);
});

test('owner AI answers "who owes" through its tools', async () => {
  store.resetAll();
  const lead = store.createLead({ presetId: 'cleaning' });
  const s = B.availableSlots(B.currentBusiness(), { limit: 1 })[0];
  await B.bookAndRequestDeposit({ leadId: lead.id, serviceId: 'standard', size: '3 bedrooms', slotStart: s.start, customerName: 'Mike' });
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      const results = toolResults(options.prompt);
      if (!results.length) return call('list_bookings', { filter: 'owes' });
      const list = results[0].value;
      const names = (Array.isArray(list) ? list : list.bookings || []).map((x) => x.customer || x.customerName).join(', ');
      return text(`Still owed: ${names}.`);
    },
  });
  _setModelForTests({ model, name: 'mock' });
  const reply = await ownerCommand('who owes me?');
  assert.match(reply, /Mike/);
  _setModelForTests(null);
});
