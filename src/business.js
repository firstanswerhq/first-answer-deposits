// Demo business profiles. Each one is a different kind of business that lives on leads,
// to show the same AI front desk works for any trade. All names here are fictional.

export const presets = {
  cleaning: {
    id: 'cleaning',
    name: 'Sparkle & Shine Home Cleaning',
    brand: { color: '#0e9f8f', logoUrl: '' },
    trade: 'home cleaning',
    city: 'Nashville, TN',
    timezone: 'America/Chicago',
    openDays: [1, 2, 3, 4, 5, 6], // Mon to Sat (0 = Sunday)
    slotTimes: ['09:00', '12:00', '15:00'],
    slotMinutes: 180,
    deposit: { type: 'flat', amount: 50 },
    cancellation: 'The deposit is fully refundable up to 24 hours before the appointment.',
    services: [
      { id: 'standard', name: 'Standard clean', sizes: { '1-2 bedrooms': 120, '3 bedrooms': 150, '4+ bedrooms': 180 } },
      { id: 'deep', name: 'Deep clean', sizes: { '1-2 bedrooms': 220, '3 bedrooms': 260, '4+ bedrooms': 320 } },
      { id: 'moveout', name: 'Move-out clean', sizes: { '1-2 bedrooms': 300, '3 bedrooms': 360, '4+ bedrooms': 440 } },
    ],
    sizeQuestion: 'How many bedrooms is the home?',
    rebookDays: 14,
    plan: { name: 'every-other-week plan', priceLabel: '10% off every visit' },
    descriptor: 'SPARKLE SHINE CLEAN',
  },
  detailing: {
    id: 'detailing',
    name: 'Gloss Boss Mobile Detailing',
    brand: { color: '#f26b1d', logoUrl: '' },
    trade: 'mobile auto detailing',
    city: 'Nashville, TN',
    timezone: 'America/Chicago',
    openDays: [2, 3, 4, 5, 6, 0],
    slotTimes: ['08:00', '11:00', '14:00'],
    slotMinutes: 150,
    deposit: { type: 'percent', percent: 25, minimum: 25 },
    cancellation: 'The deposit is fully refundable up to 24 hours before the appointment.',
    services: [
      { id: 'exterior', name: 'Exterior wash and wax', sizes: { 'car': 89, 'SUV or truck': 109 } },
      { id: 'full', name: 'Full detail, inside and out', sizes: { 'car': 189, 'SUV or truck': 229 } },
      { id: 'ceramic', name: 'Ceramic coating', sizes: { 'car': 599, 'SUV or truck': 699 } },
    ],
    sizeQuestion: 'Is it a car, or an SUV or truck?',
    rebookDays: 90,
    plan: null,
    descriptor: 'GLOSS BOSS DETAIL',
  },
  hvac: {
    id: 'hvac',
    name: 'Cool Breeze Heating & Air',
    brand: { color: '#1d7bf2', logoUrl: '' },
    trade: 'heating and air conditioning',
    city: 'Nashville, TN',
    timezone: 'America/Chicago',
    openDays: [1, 2, 3, 4, 5],
    slotTimes: ['08:00', '10:30', '13:00', '15:30'],
    slotMinutes: 120,
    deposit: { type: 'flat', amount: 49 },
    cancellation: 'The deposit is fully refundable up to 24 hours before the appointment and is credited to the bill.',
    services: [
      { id: 'tuneup', name: 'Furnace or AC tune-up', sizes: { 'one system': 129, 'two systems': 219 } },
      { id: 'repair', name: 'Repair visit (diagnosis)', sizes: { 'one system': 99, 'two systems': 99 } },
      { id: 'estimate', name: 'New system estimate', sizes: { 'one system': 0, 'two systems': 0 } },
    ],
    sizeQuestion: 'Is this for one heating or cooling system, or two?',
    rebookDays: 180,
    plan: { name: 'Comfort Club maintenance plan', priceLabel: '$15 a month, two tune-ups a year' },
    descriptor: 'COOL BREEZE HVAC',
  },
};

export const defaultPresetId = 'cleaning';

// Deposit for a quoted price, in dollars with two decimals.
export function depositFor(business, price) {
  if (!(price > 0)) return 0; // free visits (like an estimate) are booked without a deposit
  const rule = business.deposit;
  let amount;
  if (rule.type === 'percent') {
    amount = Math.max(rule.minimum || 0, (price * rule.percent) / 100);
  } else {
    amount = rule.amount;
  }
  if (price > 0) amount = Math.min(amount, price);
  return Math.round(amount * 100) / 100;
}

export function findService(business, serviceIdOrName) {
  const key = String(serviceIdOrName || '').toLowerCase().trim();
  return (
    business.services.find((s) => s.id === key) ||
    business.services.find((s) => s.name.toLowerCase() === key) ||
    business.services.find((s) => s.name.toLowerCase().includes(key) || key.includes(s.id))
  );
}

export function priceFor(business, serviceIdOrName, size) {
  const service = findService(business, serviceIdOrName);
  if (!service) return null;
  const sizeKey =
    Object.keys(service.sizes).find((k) => k.toLowerCase() === String(size || '').toLowerCase()) ||
    Object.keys(service.sizes).find((k) => String(size || '').toLowerCase().includes(k.split(' ')[0].toLowerCase()));
  if (!sizeKey) return null;
  return { service, size: sizeKey, price: service.sizes[sizeKey] };
}

// Plain-text price sheet the AI reads.
export function priceSheet(business) {
  const lines = business.services.map((s) => {
    const sizes = Object.entries(s.sizes)
      .map(([k, v]) => `${k}: ${v === 0 ? 'free' : '$' + v}`)
      .join(', ');
    return `- ${s.name} (id "${s.id}"): ${sizes}`;
  });
  const dep =
    business.deposit.type === 'percent'
      ? `${business.deposit.percent}% of the price (at least $${business.deposit.minimum})`
      : `$${business.deposit.amount}`;
  return `${lines.join('\n')}\nDeposit to hold a booking: ${dep}, applied to the final bill. ${business.cancellation}`;
}
