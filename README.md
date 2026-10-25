# First Answer Deposits

**AI can buy products. Now it can book your cleaner, and PayPal handles the money.**

Any small service business (cleaners, detailers, HVAC, lawn care, salons, anyone who lives on leads) becomes bookable three ways: by text, by phone call, and **by any AI assistant**. The AI quotes from the real price list, offers real open times, books the job and sends one PayPal link for the deposit. The customer approves the money in PayPal, so no AI ever spends it alone. Everything that happens after (moving the time, extra work, the final bill, tips, refunds, splitting the bill, no-shows) follows rules the customer agreed to, in the same thread. The owner runs it by texting an AI office manager, and gets paid out to their PayPal when a job is paid in full.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/). Runs on the PayPal **sandbox** only. No real money moves.

## Try it in two minutes

| What | Where |
|---|---|
| Your customer's AI assistant books it (agent-to-agent, human approves in PayPal) | `/agent` |
| A customer just texts or calls the business | `/text` |
| The owner's phone (AI office manager, bookings, money, connections) | `/owner` |
| Set up a brand-new business by texting a few answers (name, hours, prices, deposit, logo and color, PayPal email) | `/setup` |
| Landing page | `/` |

Suggested walk-through:

1. Open `/agent`, tap the first chip ("Book a deep clean for my 3-bedroom this Friday morning, keep it under $300. I'm Sarah."). Watch the protocol trace on the right: the assistant calls the business over MCP, gets a quote, checks real availability and books. It cannot pay. Tap **Approve the deposit in PayPal** and pay with a sandbox account or test card.
2. Open `/text`, text "Can we do Saturday instead?" The time moves and the deposit moves with it. Try "Split it with my roommate" or "Is this refundable?" on the payment page.
3. Open `/owner`, text "done at Sarah's". She gets the final bill with a tip option. Text "who owes me?", "refund Sarah", "how did we do this week?".
4. Open `/setup` and set up your own business by texting. Give it a logo link and a color: every page your customers see (texts, booking record, payment page) carries your brand, with a small "Powered by First Answer" line. Each demo business has its own color too.

### Sandbox test payments

Use any PayPal sandbox **personal** account (Developer Dashboard > Testing Tools > Sandbox Accounts), or pay as a guest with a test card from PayPal's [card testing page](https://developer.paypal.com/tools/sandbox/card-testing/). Venmo and Pay Later show in the sandbox with `buyer-country=US`, which the page sets.

If the host has no PayPal keys, the page shows a **demo checkout** button instead, so the full flow still works.

## What's inside

```
src/
  bookings.js      the single booking + money engine every path goes through (holds, deposits, changes,
                   final bill, tips, refunds, splits, no-shows, waitlist, rebooking, payouts, disputes)
  paypal.js        PayPal REST: Orders v2 (create/capture), Payments (refunds), Invoicing v2, Payouts, webhook verification
  agent/customer.js the customer-facing AI (texts, calls, the payment page) with tools over bookings.js
  agent/owner.js   the owner's AI office manager
  agent/scripted.js scripted fallback so the whole app runs with no AI key
  agent/model.js   Claude, Groq or Gemini through the Vercel AI SDK
  agentic/         MCP server per business + UCP/A2A-style discovery files + the customer's assistant demo
  setup.js         "set up by text": a few answers become a working, branded business profile
  connect.js       leads in from any app, calendar feed out, busy-time import, signed updates out to a CRM
  slots.js         open times from hours, bookings and the owner's busy calendar
  store.js         JSON file store with live events (SSE)
public/            the pages: landing, customer phone, payment page, booking record, owner, setup, agent demo
test/              node:test end-to-end tests in demo mode
```

### PayPal features used

- **Orders v2** with the **JavaScript SDK** buttons: PayPal, **Venmo**, **Pay Later** (with Pay Later messaging), debit/credit card, no account needed. Deposits, final balances and tips are separate orders with `custom_id = booking:payment` so webhooks map back.
- **Payments v2 refunds** (full and partial, newest capture first), with the reference number texted to the customer.
- **Payouts** to the business owner's PayPal email when a job is paid in full.
- **Invoicing v2** (create, send, remind, cancel) for customers who want a deposit invoice by email.
- **Webhooks** with signature verification (`CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `CUSTOMER.DISPUTE.CREATED`).
- **Dispute-ready records**: every booking keeps the terms shown, PayPal IDs, approvals and the whole conversation in one printable file.
- The payment page also registers **WebMCP** tools (`navigator.modelContext`) so browser assistants can read the bill and ask the business questions, the same proposed standard PayPal is adopting for Agent Ready.

### AI used

Any model through the Vercel AI SDK: **Claude** (`ANTHROPIC_API_KEY`), **Groq** (`GROQ_API_KEY`, free tier) or **Gemini** (`GOOGLE_GENERATIVE_AI_API_KEY`). The customer agent, the owner agent and the customer's own assistant all use tool calling over the same booking engine, so the AI can never invent a price or a time. With no key set, a scripted bot runs the same flows so the app can be tried anywhere.

### Agentic commerce

Every business gets:

- an **MCP endpoint** (`POST /mcp/<business>`, Streamable HTTP) with tools to get the price sheet, check availability, quote, book, check status, reschedule and cancel;
- discovery files at `/.well-known/ucp`, `/.well-known/agent-card.json` and `/llms.txt`;
- a **human-approval step**: `book_appointment` holds the time and returns a PayPal approval link. Only the person can pay. The hold expires on its own if they don't.

Point Claude, ChatGPT or any MCP client at the endpoint and say "book me a deep clean Friday morning, under $300."

### White label

Each business sets a logo link and a brand color (during setup by text, or later on the owner page under **Your look**). The text thread, the booking record and the payment page then carry that business's look, with one small "Powered by First Answer" line. The owner page keeps the First Answer look; customers only ever see the business.

## Run it locally

```bash
npm install
cp .env.example .env      # optional: add PayPal sandbox keys and an AI key
npm start                 # http://localhost:3000
npm test
```

With no `.env` at all, the app runs in demo mode (demo checkout, scripted AI).

## Deploy (Render)

`render.yaml` is included. Create a Web Service from this repo, then set `PUBLIC_URL`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID` (after adding `https://<your-app>/api/webhooks/paypal` as a webhook in the PayPal app) and one AI key in the Render dashboard. The free tier sleeps after 15 minutes; the first request wakes it.

## License

MIT. See `LICENSE`.
