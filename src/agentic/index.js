// Agentic commerce: any business on this app becomes bookable by any AI assistant.
//   POST /mcp and /mcp/:bizId        MCP server per business (the assistant's side of the conversation)
//   GET  /.well-known/ucp, /.well-known/agent-card.json, /llms.txt   how agents find and read a business
//   POST /api/assistant              the customer's own assistant for the demo page (a real MCP client)
import * as B from '../bookings.js';
import { mountMcp, baseFor, cors } from './mcp.js';
import { mountDiscovery } from './discovery.js';
import { assistantTurn, getSession, agentName } from './assistant.js';
import { getModel } from '../agent/model.js';
import { makeRateLimiter } from '../client-ip.js';

// Keyed on the visitor, not the host's proxy (see client-ip.js).
const rateLimit = makeRateLimiter();

export function mountAgentic(app) {
  mountMcp(app);
  mountDiscovery(app, { baseFor, cors });

  // The demo page: which business, which assistant, where the endpoint is.
  app.get('/api/assistant/info', (req, res) => {
    const business = B.businessById(String(req.query.biz || '')) || B.businessById('cleaning') || B.currentBusiness();
    const base = baseFor(req);
    res.json({
      business: { id: business.id, name: business.name, trade: business.trade, city: business.city },
      businesses: B.listAllBusinesses().map((b) => ({ id: b.id, name: b.name, trade: b.trade })),
      endpoint: `${base}/mcp/${business.id}`,
      assistant: agentName(),
      mode: getModel() ? 'model' : 'scripted',
      discovery: { ucp: `${base}/.well-known/ucp?biz=${business.id}`, agentCard: `${base}/.well-known/agent-card.json?biz=${business.id}`, llms: `${base}/llms.txt?biz=${business.id}` },
    });
  });

  // A reload keeps the thread.
  app.get('/api/assistant/:sessionId', (req, res) => {
    const s = getSession(String(req.params.sessionId));
    if (!s) return res.status(404).json({ error: 'No such session' });
    res.json({ bizId: s.bizId, history: s.history, trace: s.trace });
  });

  app.post('/api/assistant', rateLimit(40, 10 * 60 * 1000), async (req, res) => {
    const sessionId = String(req.body?.sessionId || '').slice(0, 80);
    const text = String(req.body?.text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    if (!sessionId || !text) return res.status(400).json({ error: 'sessionId and text are required.' });
    const bizId = req.body?.bizId && B.businessById(String(req.body.bizId)) ? String(req.body.bizId) : undefined;
    try {
      res.json(await assistantTurn({ sessionId, text, bizId, base: baseFor(req) }));
    } catch (err) {
      console.error('assistant', err);
      res.status(500).json({ error: err.message });
    }
  });
}
