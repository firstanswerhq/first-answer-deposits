// Reading a person's name out of a message, shared by the scripted front desk and the customer's assistant.
// "I'm Sarah Kim", "my name is Dana Cole", "under Sarah": yes. "Can we do Saturday?", "OK", "Friday": no.
export const NOT_NAMES = new Set(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'today', 'tomorrow', 'tonight', 'morning', 'afternoon', 'evening', 'ac', 'suv', 'paypal', 'venmo', 'ok', 'okay', 'not', 'looking', 'sorry', 'good', 'fine', 'sure', 'done', 'booking', 'hoping', 'trying', 'thinking', 'ready', 'free', 'here', 'back', 'new', 'all', 'just', 'also', 'still', 'going', 'in', 'at', 'interested', 'available', 'calling', 'texting', 'wondering', 'a', 'the', 'an', 'so', 'very', 'really']);

// Words that start ordinary sentences, never a name on their own ("Can", "What", "Yes", "Thanks").
const SENTENCE_WORDS = new Set(['can', 'could', 'would', 'will', 'should', 'how', 'what', 'when', 'where', 'why', 'who', 'which', 'is', 'are', 'am', 'do', 'does', 'did', 'yes', 'yeah', 'yep', 'no', 'nope', 'nah', 'ok', 'okay', 'sure', 'thanks', 'thank', 'please', 'hi', 'hello', 'hey', 'i', 'im', "i'm", 'my', 'we', 'me', 'you', 'it', 'that', 'this', 'the', 'a', 'an', 'and', 'or', 'but', 'maybe', 'actually', 'never', 'cancel', 'move', 'book', 'change', 'switch', 'refund', 'help', 'stop', 'nevermind', 'any', 'anything', 'another', 'other', 'different', 'next', 'first', 'second', 'third', 'one', 'two', 'three', 'deep', 'standard', 'move-out', 'bedroom', 'bedrooms', 'clean', 'cleaning', 'car', 'truck', 'system', 'systems', 'split', 'tip', 'pay', 'paid']);

const cap = (w) => w[0].toUpperCase() + w.slice(1);

export function parseName(text) {
  const t = String(text || '');
  const pats = [
    // "I'm Sarah Kim", "my name is Sarah", "under Sarah Kim": one or two capitalized words.
    /\b(?:[Ii]'?m|[Ii] am|[Mm]y name is|[Mm]y name'?s|[Tt]his is|name is|[Cc]all me|it'?s|its|under(?: the name)?|for)\s+([A-Z][a-zA-Z'-]{1,30}(?:\s+[A-Z][a-zA-Z'-]{1,30})?)\b/,
    /\b(?:my name is|my name'?s|call me|name is|i am|i'?m)\s+([a-z][a-z'-]{1,30}(?:\s+[a-z][a-z'-]{1,30})?)\b(?=\s*[.!,]?\s*$)/i,
  ];
  for (const p of pats) {
    const m = t.match(p);
    if (!m) continue;
    const words = m[1].split(/\s+/).filter((w) => !NOT_NAMES.has(w.toLowerCase()));
    if (!words.length || NOT_NAMES.has(words[0].toLowerCase()) || SENTENCE_WORDS.has(words[0].toLowerCase())) continue;
    return words.map(cap).join(' ');
  }
  return null;
}

// A reply that is only a name ("Dana", "dana cole"), given when we just asked for one. Questions, numbers
// and sentence starters ("Can we do Saturday instead?") are not names.
export function bareName(text) {
  const t = String(text || '').trim().replace(/[.!]+$/, '');
  if (!t || /[?\d@$]/.test(t)) return null;
  const words = t.split(/\s+/);
  if (words.length > 3 || !words.every((w) => /^[A-Za-z][A-Za-z'-]{0,30}$/.test(w))) return null;
  if (words.some((w) => SENTENCE_WORDS.has(w.toLowerCase()) || NOT_NAMES.has(w.toLowerCase()))) return null;
  return words.slice(0, 2).map(cap).join(' ');
}
