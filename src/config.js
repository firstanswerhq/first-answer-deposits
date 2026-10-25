import 'dotenv/config';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PORT || 3000);

export const config = {
  port,
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  paypal: {
    clientId: process.env.PAYPAL_CLIENT_ID || '',
    clientSecret: process.env.PAYPAL_CLIENT_SECRET || '',
    // This project only ever talks to the PayPal sandbox unless PAYPAL_ENV is set to "live" on purpose.
    env: (process.env.PAYPAL_ENV || 'sandbox').toLowerCase() === 'live' ? 'live' : 'sandbox',
    webhookId: process.env.PAYPAL_WEBHOOK_ID || '',
  },
  ai: {
    googleKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY || '',
    anthropicKey: process.env.ANTHROPIC_API_KEY || '',
    googleModel: process.env.GOOGLE_MODEL || 'gemini-2.5-flash',
    anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
  },
  ownerPasscode: process.env.OWNER_PASSCODE || '',
  dataFile: process.env.DATA_FILE || fileURLToPath(new URL('../data/db.json', import.meta.url)),
};

export const paypalApiBase =
  config.paypal.env === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

export const paypalReady = Boolean(config.paypal.clientId && config.paypal.clientSecret);
export const aiReady = Boolean(config.ai.googleKey || config.ai.anthropicKey);
