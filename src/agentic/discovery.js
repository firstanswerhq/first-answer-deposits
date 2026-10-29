// Discovery files so an outside agent can find a business and learn how to book it:
//   /.well-known/ucp            UCP-style business profile with an MCP service binding and a PayPal payment handler
//   /.well-known/agent-card.json  A2A-style agent card
//   /llms.txt                    plain text for AI assistants
// These follow the shape of those specs so agents can read them. They are not certified implementations,
// and UCP has no services or appointments capability yet, so the booking capability here is this app's own.
import * as B from '../bookings.js';
import { defaultPresetId } from '../business.js';
import { businessInfo, depositRule, mcpUrl, HOLD_MINUTES, PAYMENT_METHODS } from './mcp.js';

const VERSION = '2026-10-25';

function pickBusiness(req) {
  const id = String(req.query.biz || '');
  return (id && B.businessById(id)) || B.businessById(defaultPresetId);
}

export function ucpProfile(business, base) {
  const info = businessInfo(business, base);
  const others = B.listAllBusinesses()
    .filter((b) => b.id !== business.id)
    .map((b) => ({ id: b.id, name: b.name, trade: b.trade, profile: `${base}/.well-known/ucp?biz=${b.id}`, mcp_endpoint: mcpUrl(b, base) }));
  return {
    ucp: {
      version: '2026-01-11',
      profile_style: 'ucp-style',
      note: 'Shaped like a UCP business profile so agents can read it. Not a certified UCP implementation. UCP has no services or appointments capability yet; the booking capability below is defined by First Answer.',
      services: {
        'com.firstanswer.booking': {
          version: VERSION,
          transport: 'mcp',
          endpoint: info.mcp_endpoint,
          auth: 'none (sandbox demo)',
          spec: `${base}/llms.txt`,
          tools: ['get_business_info', 'check_availability', 'get_quote', 'book_appointment', 'get_booking_status', 'reschedule_booking', 'cancel_booking'],
        },
      },
      capabilities: [
        {
          name: 'com.firstanswer.booking.appointment',
          version: VERSION,
          spec: `${base}/llms.txt`,
          description: 'Quote a service, check real open times, hold an appointment with a deposit request, then check, move or cancel it. Money moves only when the human approves the deposit in PayPal.',
          human_in_the_loop: 'payment',
        },
      ],
    },
    payment: {
      handlers: [
        {
          id: 'paypal_checkout',
          name: 'com.paypal.checkout',
          version: VERSION,
          flow: 'human_approved_checkout',
          description: 'The agent receives approval_url from book_appointment. The human opens it and approves the deposit on a PayPal checkout page. Agents never hold payment credentials.',
          supports: ['deposits', 'balance_payments', 'tips', 'refunds', 'pay_later', 'venmo', 'cards'],
          methods: PAYMENT_METHODS,
          account_required: false,
          agent_can_pay: false,
          spec: 'https://developer.paypal.com/docs/checkout/',
        },
      ],
    },
    business: {
      id: info.id,
      name: info.name,
      trade: info.trade,
      city: info.city,
      timezone: info.timezone,
      open_days: info.open_days,
      start_times: info.start_times,
      services: info.services,
      deposit_rule: info.deposit_rule,
      cancellation_policy: info.cancellation_policy,
      hold_minutes: info.hold_minutes,
      text_the_business: `${base}/text?biz=${business.id}`,
    },
    other_businesses: others,
    provider: { name: 'First Answer', url: base },
  };
}

export function agentCard(business, base) {
  return {
    card_style: 'a2a-style',
    note: 'Shaped like an A2A agent card so agents can read it. Not a certified A2A implementation: this agent is reached over MCP, not A2A JSON-RPC.',
    name: `${business.name} booking agent`,
    description: `Books ${business.trade} appointments with ${business.name} in ${business.city}. Quotes from the real price sheet, offers real open times, holds a time and asks the human to approve a PayPal deposit. The agent cannot pay.`,
    url: mcpUrl(business, base),
    preferredTransport: 'MCP',
    additionalInterfaces: [{ url: mcpUrl(business, base), transport: 'MCP' }],
    provider: { organization: 'First Answer', url: base },
    version: VERSION,
    documentationUrl: `${base}/llms.txt`,
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [
      { id: 'availability', name: 'Check availability', description: 'Real open appointment times for a day or the next few days.', tags: ['booking', 'calendar'], examples: ['What is open Friday morning?'] },
      { id: 'quote', name: 'Get a quote', description: 'Price, deposit due now and balance after for a service and size.', tags: ['pricing'], examples: ['How much is a deep clean for 3 bedrooms?'] },
      { id: 'book', name: 'Book an appointment', description: `Hold a time for ${HOLD_MINUTES()} minutes and get a PayPal approval link for the human. Refuses to book above the budget the human set.`, tags: ['booking', 'payments', 'human-approval'], examples: ['Book it for Friday at 9, under $300, for Sarah.'] },
      { id: 'changes', name: 'Status, reschedule, cancel', description: 'Check a booking, move it for free or cancel it under the policy shown at booking. Needs the booking key.', tags: ['booking'], examples: ['Did she pay yet?', 'Move it to Saturday.'] },
    ],
    payment: { handler: 'PayPal', flow: 'human_approved_checkout', methods: PAYMENT_METHODS, agent_can_pay: false },
    discovery: { ucp: `${base}/.well-known/ucp?biz=${business.id}`, llms: `${base}/llms.txt?biz=${business.id}` },
  };
}

export function llmsText(business, base) {
  const info = businessInfo(business, base);
  const services = business.services
    .map((s) => {
      const opts = Object.entries(s.sizes).map(([k, v]) => `${k === 'standard' ? '' : `${k}: `}${v === 0 ? 'free' : B.usd(v)}`).join(', ');
      return `- ${s.name} (service id "${s.id}"): ${opts}`;
    })
    .join('\n');
  return `# ${business.name}

> ${business.trade[0].toUpperCase() + business.trade.slice(1)} in ${business.city}. Bookable by any AI assistant over MCP. A human approves every payment in PayPal.

## Who we are
${business.name} does ${business.trade} in ${business.city}. Open ${info.open_days.join(', ')}. Appointments start at ${info.start_times.join(', ')} (${business.timezone}) and run about ${info.appointment_minutes} minutes.

## Services and prices
${services}

Deposit: ${depositRule(business)}
Cancellation: ${business.cancellation}

## How to book (for AI assistants)
Connect as an MCP client (Streamable HTTP, stateless, no auth in this sandbox):
  POST ${info.mcp_endpoint}

Tools, in the order to use them:
1. get_business_info      who we are, prices, deposit rule, how payment works
2. get_quote              service + size -> price, deposit due now, balance after
3. check_availability     optional day ("friday", "2026-10-30", "today", "tomorrow") -> slots with start (ISO) and label
4. book_appointment       service, size, slot_start, customer_name, max_total (budget), agent_name -> holds the time for ${HOLD_MINUTES()} minutes
5. get_booking_status / reschedule_booking / cancel_booking   need booking_id and booking_key from step 4

## Money
You cannot pay. book_appointment returns approval_url. Give it to the human. They approve the deposit on a PayPal checkout page (PayPal, Venmo, Pay Later or a card, no account needed). The time is confirmed when they approve. If they do not approve within ${HOLD_MINUTES()} minutes the hold is released. If the price is above max_total nothing is booked and you get the quote back.

## More
- UCP-style profile: ${base}/.well-known/ucp?biz=${business.id}
- A2A-style agent card: ${base}/.well-known/agent-card.json?biz=${business.id}
- Humans can text the business instead: ${base}/text?biz=${business.id}
- Other businesses on this server: ${B.listAllBusinesses().filter((b) => b.id !== business.id).map((b) => `${b.name} (${mcpUrl(b, base)})`).join('; ') || 'none'}
`;
}

export function mountDiscovery(app, { baseFor, cors }) {
  app.get('/.well-known/ucp', cors, (req, res) => res.json(ucpProfile(pickBusiness(req), baseFor(req))));
  app.get('/.well-known/agent-card.json', cors, (req, res) => res.json(agentCard(pickBusiness(req), baseFor(req))));
  app.get('/llms.txt', cors, (req, res) => res.type('text/plain; charset=utf-8').send(llmsText(pickBusiness(req), baseFor(req))));
}
