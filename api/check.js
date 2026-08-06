'use strict';

// Module-level state — persists across warm invocations on the same instance
const _cache = new Map();      // cacheKey → { data, ts }
const _rateLimit = new Map();  // ip → { count, reset }

const CACHE_TTL   = 86_400_000; // 24 h
const RATE_MAX    = 10;
const RATE_WINDOW = 3_600_000;  // 1 h per IP

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  // ── rate limit ────────────────────────────────────────────────
  const ip  = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'anon';
  const now = Date.now();
  const rl  = _rateLimit.get(ip) || { count: 0, reset: now + RATE_WINDOW };
  if (now > rl.reset) { rl.count = 0; rl.reset = now + RATE_WINDOW; }
  if (rl.count >= RATE_MAX) return res.status(429).json({ error: 'Rate limit hit. Try again in an hour.' });
  rl.count++;
  _rateLimit.set(ip, rl);

  // ── parse body ────────────────────────────────────────────────
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const biz   = String(body.businessName || '').trim();
  const loc   = String(body.city         || '').trim();
  const svc   = String(body.service      || '').trim();
  const email = String(body.email        || '').trim();
  if (!biz || !loc || !svc) return res.status(400).json({ error: 'businessName, city, and service are required.' });

  // ── cache lookup ──────────────────────────────────────────────
  const ck  = `${biz}|${loc}|${svc}`.toLowerCase();
  const hit = _cache.get(ck);
  if (hit && (now - hit.ts) < CACHE_TTL) {
    logLead(email, biz, loc, svc);
    return res.status(200).json({ ...hit.data, cached: true });
  }

  // ── validate keys ─────────────────────────────────────────────
  if (!process.env.OPENAI_API_KEY || !process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'API keys not configured. Contact taiga.gamell@gmail.com.' });
  }

  // ── build prompts ─────────────────────────────────────────────
  const prompts = [
    `I'm looking for a ${svc} in ${loc}. Which specific businesses or practices would you recommend? Please list them by name.`,
    `What are the best ${svc}s in ${loc}? Give me a list of real, specific businesses by name.`,
    `Top-rated ${svc} near ${loc} — which specific clinics or studios do you recommend and why?`
  ];

  // ── query both models in parallel ─────────────────────────────
  const [chatgptSettled, geminiSettled] = await Promise.allSettled([
    queryAll(prompts, 'openai'),
    queryAll(prompts, 'gemini'),
  ]);

  const data = {
    businessName: biz,
    city:         loc,
    service:      svc,
    checkedAt:    new Date().toISOString(),
    chatgpt:      analyze(chatgptSettled, biz),
    gemini:       analyze(geminiSettled,  biz),
  };

  // ── cache ─────────────────────────────────────────────────────
  _cache.set(ck, { data, ts: now });
  if (_cache.size > 500) _cache.delete(_cache.keys().next().value); // evict oldest

  logLead(email, biz, loc, svc);
  return res.status(200).json(data);
};

// ─────────────────────────────────────────────────────────────────

async function queryAll(prompts, model) {
  const parts = await Promise.all(prompts.map(p => queryOne(p, model)));
  return parts.filter(Boolean).join('\n\n');
}

async function queryOne(prompt, model) {
  try {
    if (model === 'openai') {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 450,
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(12_000),
      });
      if (!r.ok) return null;
      return (await r.json()).choices?.[0]?.message?.content || null;
    }

    if (model === 'gemini') {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 450, temperature: 0.2 },
          }),
          signal: AbortSignal.timeout(12_000),
        }
      );
      if (!r.ok) return null;
      return (await r.json()).candidates?.[0]?.content?.parts?.[0]?.text || null;
    }
  } catch { return null; }
  return null;
}

function analyze(settled, bizName) {
  if (settled.status === 'rejected' || !settled.value) return { status: 'error', excerpt: null };
  const text = settled.value;
  if (!text) return { status: 'error', excerpt: null };

  const lo  = text.toLowerCase();
  const bn  = bizName.toLowerCase();
  const idx = lo.indexOf(bn);
  const cited = idx !== -1;

  let excerpt;
  if (cited) {
    const s = Math.max(0, idx - 80);
    const e = Math.min(text.length, idx + bizName.length + 260);
    excerpt = (s > 0 ? '…' : '') + text.slice(s, e).trim() + (e < text.length ? '…' : '');
  } else {
    // Show the opening of the first response — this IS the competitor mention
    const first = text.split(/\n\n/)[0];
    const raw   = first.slice(0, 380).trim();
    excerpt = raw + (first.length > 380 ? '…' : '');
  }

  return { status: cited ? 'cited' : 'not_cited', excerpt };
}

function logLead(email, biz, loc, svc) {
  if (!email) return;
  // Vercel captures console.log in function logs — retrieve from Vercel dashboard
  // To pipe to email/sheet: add RESEND_API_KEY or BLOB_READ_WRITE_TOKEN and extend here
  console.log(JSON.stringify({ _lead: 1, email, biz, loc, svc, ts: new Date().toISOString() }));
}
