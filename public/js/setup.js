import { api, money, $, escapeHtml, toast } from './common.js';

const state = { steps: [], i: 0, profile: {}, done: false, live: null };
const EXAMPLES = {
  name: ['Franklin Lawn Care', 'Bright Smile Dental Hygiene', 'Pawfect Dog Grooming'],
  trade: ['lawn care', 'dog grooming', 'wedding photography'],
  city: ['Franklin, TN'],
  hours: ['Mon-Fri, 8am, 11am and 2pm', 'Tue-Sat 9, 12 and 3'],
  services: ['Mowing: small yard $45, large yard $65\nAeration: $120', 'Bath and brush: small dog $45, large dog $75\nFull groom: small dog $75, large dog $110'],
  deposit: ['$25', '25%', 'no deposit'],
  payout: [],
};

function bubble(role, text) {
  const div = document.createElement('div');
  div.className = `bubble ${role}`;
  div.textContent = text;
  $('#thread').appendChild(div);
  $('#thread').scrollTop = $('#thread').scrollHeight;
}

function chips() {
  const step = state.steps[state.i];
  const list = step ? EXAMPLES[step.id] || [] : [];
  const extra = step?.id === 'services' && state.profile.services?.length ? ['done'] : [];
  $('#chips').innerHTML = [...extra, ...list].map((x) => `<button type="button" class="chip" data-v="${escapeHtml(x)}">${escapeHtml(x.split('\n')[0])}${x.includes('\n') ? '…' : ''}</button>`).join('');
}

function askNext() {
  const step = state.steps[state.i];
  if (!step) return finish();
  bubble('them', step.ask);
  chips();
}

function finish() {
  state.done = true;
  $('#chips').innerHTML = '';
  bubble('them', `That's everything. Check the card on the left, then tap Go live.`);
  $('#go-live').classList.remove('hidden');
}

function preview() {
  const p = state.profile;
  $('#pv-name').textContent = p.name || 'Your business';
  $('#pv-sub').textContent = [p.trade, p.city].filter(Boolean).join(' · ') || 'The profile fills in as you answer.';
  const rows = [];
  if (p.openDays) rows.push(['Books on', `${p.openDays.map((d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(', ')} at ${p.slotTimes.map(pretty).join(', ')}`]);
  for (const s of p.services || []) {
    rows.push([s.name, Object.entries(s.sizes).map(([k, v]) => (k === 'standard' ? money(v) : `${k} ${money(v)}`)).join(' · ')]);
  }
  if (p.payoutEmail) rows.push(['Paid to', p.payoutEmail]);
  $('#pv-rows').innerHTML = rows.map(([a, b]) => `<div class="row"><span class="muted">${escapeHtml(a)}</span><strong style="text-align:right">${escapeHtml(b)}</strong></div>`).join('');
  if (p.deposit) {
    $('#pv-deposit').classList.remove('hidden');
    $('#pv-deposit').textContent = p.deposit.amount === 0 ? 'No deposit: customers book free and pay after the job.' : p.deposit.type === 'percent' ? `${p.deposit.percent}% deposit holds the time. Free to cancel until 24 hours before.` : `${money(p.deposit.amount)} deposit holds the time. Free to cancel until 24 hours before.`;
  }
}

function pretty(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''}${h >= 12 ? 'pm' : 'am'}`;
}

async function answer(text) {
  text = text.trim();
  if (!text || state.done) return;
  bubble('me', text);
  const step = state.steps[state.i];
  if (step.id === 'services' && /^done\.?$/i.test(text) && state.profile.services?.length) {
    state.i++;
    return askNext();
  }
  const r = await api('/api/setup/answer', { method: 'POST', body: { stepId: step.id, text, profile: state.profile } });
  if (r.say) bubble('them', r.say);
  if (!r.ok) return chips();
  Object.assign(state.profile, r.patch);
  preview();
  if (step.id === 'services') return chips(); // stay here until they say "done"
  state.i++;
  askNext();
}

async function goLive() {
  $('#go-live').disabled = true;
  try {
    const r = await api('/api/setup/create', { method: 'POST', body: { profile: state.profile } });
    state.live = r;
    $('#links').classList.remove('hidden');
    $('#l-text').href = r.links.text;
    $('#l-owner').href = r.links.owner;
    $('#l-agent').href = r.links.agent;
    $('#l-mcp').textContent = r.links.mcp;
    $('#l-pay').textContent = r.business.payoutEmail
      ? `Customers pay through PayPal. When a job is paid in full, the money is sent to ${r.business.payoutEmail} with PayPal Payouts.`
      : 'Customers pay through PayPal. Add a PayPal email later to get automatic payouts.';
    bubble('them', `${r.business.name} is live. Try the customer link on the left, or text here like a customer would.`);
    $('#go-live').textContent = 'Live ✓';
    $('#go-live').classList.replace('primary', 'secondary');
    toast(`${r.business.name} is live.`);
  } catch (err) {
    $('#go-live').disabled = false;
    toast(err.message, 'bad');
  }
}

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#msg').value;
  $('#msg').value = '';
  $('#msg').style.height = '';
  answer(v);
});
$('#msg').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});
$('#msg').addEventListener('input', (e) => {
  e.target.style.height = '';
  e.target.style.height = Math.min(110, e.target.scrollHeight) + 'px';
});
$('#chips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-v]');
  if (b) answer(b.dataset.v);
});
$('#go-live').addEventListener('click', goLive);
$('#quick-go').addEventListener('click', async () => {
  const text = $('#quick-text').value.trim();
  if (!text) return;
  $('#quick-go').disabled = true;
  try {
    const { profile } = await api('/api/setup/text', { method: 'POST', body: { text } });
    if (!profile) throw new Error("I couldn't read that. Try the questions on the right instead.");
    state.profile = profile;
    preview();
    bubble('them', `I read your description and filled in the card. Check it, then tap Go live.`);
    finish();
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    $('#quick-go').disabled = false;
  }
});

const { steps, ai } = await api('/api/setup/steps');
state.steps = steps;
if (ai) $('#quick').classList.remove('hidden');
bubble('them', "Hi! I'm the First Answer setup assistant. Seven quick questions and you're taking bookings with PayPal deposits.");
askNext();
