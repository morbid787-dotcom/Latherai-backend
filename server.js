const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const APP_SECRET    = process.env.APP_SECRET;
const PORT          = process.env.PORT || 3000;
const API_URL       = 'https://api.anthropic.com/v1/messages';
const MODEL         = 'claude-haiku-4-5-20251001';
const FREE_SCANS    = 10; // scans per device per month

// ---------- Scan tracker (in-memory, resets monthly) ----------
const tracker = new Map(); // deviceId -> { count, resetAt }

function getRecord(deviceId) {
  const now = Date.now();
  const rec = tracker.get(deviceId);
  if (!rec || now >= rec.resetAt) {
    const reset = new Date();
    reset.setUTCMonth(reset.getUTCMonth() + 1, 1);
    reset.setUTCHours(0, 0, 0, 0);
    const fresh = { count: 0, resetAt: reset.getTime() };
    tracker.set(deviceId, fresh);
    return fresh;
  }
  return rec;
}

function consumeScan(deviceId) {
  const rec = getRecord(deviceId);
  if (rec.count >= FREE_SCANS) return false;
  rec.count++;
  return true;
}

// ---------- Auth middleware ----------
function auth(req, res, next) {
  if (APP_SECRET && req.headers['x-app-secret'] !== APP_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// ---------- Anthropic helper ----------
async function callAnthropic(messages, maxTokens = 2048) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error('invalid_key');
    if (res.status === 429) throw new Error('rate_limit');
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }

  const data = await res.json();
  return data.content?.[0]?.text || '';
}

function extractJson(text, isArray = false) {
  const pattern = isArray ? /\[[\s\S]*\]/ : /\{[\s\S]*\}/;
  const match = text.match(pattern);
  if (!match) throw new Error('bad_response');
  return JSON.parse(match[0]);
}

// ---------- Profile text builder ----------
function buildProfileText(profile) {
  if (!profile) return '';
  const lines = [];
  const skinTypes = Array.isArray(profile.skinType) ? profile.skinType : profile.skinType ? [profile.skinType] : [];
  const valid = skinTypes.filter(t => t !== 'unknown');
  if (valid.length) lines.push(`Skin type: ${valid.join(', ')}`);
  const concerns = Array.isArray(profile.concern) ? profile.concern : profile.concern ? [profile.concern] : [];
  const validC = concerns.filter(c => c !== 'maintain');
  if (validC.length) lines.push(`Main concerns: ${validC.join(', ')}`);
  const avoids = (profile.avoid || []).filter(a => a !== 'none');
  if (avoids.length) lines.push(`Specifically avoids: ${avoids.join(', ')}`);
  return lines.length ? `\nUser skin profile:\n${lines.join('\n')}\n` : '';
}

// ---------- POST /api/analyze-image ----------
app.post('/api/analyze-image', auth, async (req, res) => {
  const { base64Image, profile, deviceId } = req.body;
  if (!base64Image || !deviceId) return res.status(400).json({ error: 'missing_fields' });
  if (!consumeScan(deviceId)) return res.status(429).json({ error: 'limit_exceeded', limit: FREE_SCANS });

  const profileText = buildProfileText(profile);
  const prompt = `You are an expert cosmetic chemist. Look at this photo of a product's ingredient label and analyze it.

First, read all the ingredients from the image.${profileText ? `\n${profileText}` : ''}

Return ONLY valid JSON — no explanation, no markdown, just the JSON object:
{
  "name": <product name if visible in image, else "Unknown Product">,
  "brand": <brand name if visible, else "Unknown Brand">,
  "rawIngredients": <full ingredients text as you read it from the image>,
  "score": <integer 0-100>,
  "grade": <"A" | "B+" | "B" | "C+" | "C" | "D" | "F">,
  "tone": <"good" if score>=74, "mid" if score>=58, else "bad">,
  "verdict": <short punchy phrase, max 6 words>,
  "summary": <2-3 honest sentences about the formula. Be specific. Mention standout good or bad ingredients by name.>,
  "category": <"cleanser" | "serum" | "moisturizer" | "sunscreen" | "toner" | "mask" | "eye_cream" | "treatment" | "other">,
  "confidence": <0.0-1.0, how clearly you could read the label>,
  "personalNote": <1-2 sentences tailored to the user's specific skin profile and concerns, or null if no profile>,
  "ingredients": [
    {
      "name": <ingredient name>,
      "tone": <"good" | "ok" | "mid" | "watch">,
      "note": <one clear sentence: what it is and what it does>,
      "flagged": <true if problematic for this user's profile>,
      "flagReason": <why flagged for this user, or null>
    }
  ],
  "cannotRead": <true if the image is too blurry or ingredient list is not visible>
}

Rules:
- Limit to the 12 most impactful ingredients
- "watch" = fragrance/parfum, harsh alcohols (SD Alcohol, Alcohol Denat, Isopropyl Alcohol), SLS, parabens, methylisothiazolinone, essential oils in face products
- "good" = ceramides, hyaluronic acid, niacinamide, squalane, peptides, retinol, vitamin C (ascorbic acid), quality humectants
- "ok" = safe but unremarkable fillers, mild surfactants, gentle preservatives
- "mid" = weak actives, questionable ingredients, overhyped marketing ingredients
- If you cannot read the ingredient list clearly, set cannotRead to true`;

  try {
    const text = await callAnthropic([
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } },
          { type: 'text', text: prompt },
        ],
      },
    ]);
    res.json(extractJson(text));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- POST /api/analyze-text ----------
app.post('/api/analyze-text', auth, async (req, res) => {
  const { name, brand, rawIngredients, profile, deviceId } = req.body;
  if (!rawIngredients || !deviceId) return res.status(400).json({ error: 'missing_fields' });
  if (!consumeScan(deviceId)) return res.status(429).json({ error: 'limit_exceeded', limit: FREE_SCANS });

  const profileText = buildProfileText(profile);
  const prompt = `You are an expert cosmetic chemist. Analyze this product's ingredient list and return honest, science-backed analysis.

Product: "${name}" by ${brand}
${profileText}
Ingredients (listed highest to lowest concentration):
${rawIngredients}

Return ONLY valid JSON — no explanation, no markdown, just the JSON object:
{
  "score": <integer 0-100>,
  "grade": <"A" | "B+" | "B" | "C+" | "C" | "D" | "F">,
  "tone": <"good" if score>=74, "mid" if score>=58, else "bad">,
  "verdict": <short punchy phrase, max 6 words>,
  "summary": <2-3 honest sentences about the formula. Be specific, not generic. Mention standout good or bad ingredients by name.>,
  "personalNote": <1-2 sentences tailored to the user's specific skin profile and concerns, or null if no profile>,
  "ingredients": [
    {
      "name": <ingredient name as written in the list>,
      "tone": <"good" | "ok" | "mid" | "watch">,
      "note": <one clear sentence: what it is and what it does>,
      "flagged": <true if this ingredient is problematic for the user's profile>,
      "flagReason": <why it's flagged for this specific user, or null>
    }
  ]
}

Rules:
- Limit to the 12 most impactful ingredients
- "watch" = fragrance/parfum, harsh alcohols, SLS, parabens, methylisothiazolinone, essential oils in face products
- Flag ingredients based on the user's profile`;

  try {
    const text = await callAnthropic([{ role: 'user', content: prompt }]);
    res.json(extractJson(text));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- POST /api/parse-skin ----------
app.post('/api/parse-skin', auth, async (req, res) => {
  const { description } = req.body;
  if (!description) return res.status(400).json({ error: 'missing_fields' });

  const prompt = `You are a skincare expert. A user described their skin in plain language. Extract structured profile information from it.

User's description: "${description}"

Return ONLY valid JSON with no explanation:
{
  "skinType": <array of applicable types from: ["oily", "dry", "combination", "normal", "sensitive", "acne", "dehydrated", "mature", "redness", "unknown"]>,
  "concern": <array of applicable items from: ["acne", "dryness", "aging", "darkSpots", "redness", "maintain"]>,
  "avoid": <array from: ["fragrance", "alcohol", "essentialOils", "sulfates", "none"]>,
  "summary": <one sentence describing what you extracted, to confirm back to the user>
}

Rules:
- skinType can include multiple values
- If they say "reactive" or "easily irritated" include "sensitive"
- concern can have multiple values; if no clear concern use ["maintain"]
- "maintain" is exclusive — if no concerns, return only ["maintain"]
- If no specific ingredients to avoid, return ["none"]`;

  try {
    const text = await callAnthropic([{ role: 'user', content: prompt }], 512);
    res.json(extractJson(text));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- POST /api/alternatives ----------
app.post('/api/alternatives', auth, async (req, res) => {
  const { category, scannedName, scannedBrand, scannedGrade, excludeNames, count } = req.body;
  if (!category || !count) return res.status(400).json({ error: 'missing_fields' });

  const TRUSTED_BRANDS = [
    'CeraVe', 'La Roche-Posay', 'The Ordinary', 'Cetaphil', 'Neutrogena',
    'Eucerin', 'Vanicream', "Paula's Choice", 'COSRX', 'Stratia',
    'SkinCeuticals', 'Cosmetic Skin Solutions', 'First Aid Beauty', 'Aveeno', 'Olay',
  ];

  const excludeLine = excludeNames?.length
    ? `Already have these — don't repeat: ${excludeNames.join(', ')}.`
    : '';

  const prompt = `The user scanned "${scannedBrand} ${scannedName}" (grade: ${scannedGrade}) — a poor-performing ${category}. Suggest ${count} better alternative(s).

Only recommend real products from this approved brand list:
${TRUSTED_BRANDS.join(', ')}

${excludeLine}

Return ONLY a valid JSON array (no markdown, no explanation):
[
  {
    "brand": "exact brand name from the list above",
    "name": "product name",
    "grade": "A" or "B+" or "B",
    "reason": "one sentence max 80 chars — specific benefit over the scanned product"
  }
]

Rules:
- Real, currently available products only
- Only brands from the approved list
- All suggestions must be grade B or higher
- Return at most ${count} items`;

  try {
    const text = await callAnthropic([{ role: 'user', content: prompt }], 512);
    res.json(extractJson(text, true));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- POST /api/identify-product ----------
app.post('/api/identify-product', auth, async (req, res) => {
  const { base64Image, profile, deviceId } = req.body;
  if (!base64Image || !deviceId) return res.status(400).json({ error: 'missing_fields' });
  if (!consumeScan(deviceId)) return res.status(429).json({ error: 'limit_exceeded', limit: FREE_SCANS });

  const profileText = buildProfileText(profile);
  const prompt = `You are an expert cosmetic chemist with deep knowledge of skincare products. Look at the FRONT of this product packaging and identify the product.${profileText ? `\n${profileText}` : ''}

Return ONLY valid JSON — no explanation, no markdown, just the JSON object:
{
  "cannotRead": <true if you cannot clearly identify any product from this image>,
  "brand": <brand name>,
  "name": <product name>,
  "category": <"cleanser" | "serum" | "moisturizer" | "sunscreen" | "toner" | "mask" | "eye_cream" | "treatment" | "other">,
  "confidence": <"high" | "medium" | "low">,
  "knownFormulation": <true if you know this product's exact ingredient list well enough to grade it>,
  "score": <integer 0-100, only if knownFormulation is true, else omit>,
  "grade": <"A"|"B+"|"B"|"C+"|"C"|"D"|"F", only if knownFormulation is true, else omit>,
  "tone": <"good" if score>=74, "mid" if score>=58, else "bad" — only if knownFormulation is true, else omit>,
  "verdict": <short punchy phrase max 6 words, only if knownFormulation is true, else omit>,
  "summary": <2-3 honest sentences about the formula, only if knownFormulation is true, else omit>,
  "personalNote": <1-2 sentences for this user's skin profile, or null>,
  "ingredients": <array of top 12 ingredients with name/tone/note/flagged/flagReason — only if knownFormulation is true, else omit>
}

Ingredient tone rules:
- "watch" = fragrance/parfum, harsh alcohols, SLS, parabens, methylisothiazolinone, essential oils in face products
- "good" = ceramides, hyaluronic acid, niacinamide, squalane, peptides, retinol, vitamin C
- "ok" = safe fillers, mild surfactants, gentle preservatives
- "mid" = weak actives, overhyped marketing ingredients

Only set knownFormulation to true for products whose formulation you are highly confident about (major brands, widely documented products). If unsure, set it to false — the user will scan the back instead.`;

  try {
    const text = await callAnthropic([
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Image } },
          { type: 'text', text: prompt },
        ],
      },
    ]);
    res.json(extractJson(text));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- GET /api/scan/status ----------
app.get('/api/scan/status', auth, (req, res) => {
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ error: 'missing_fields' });
  const rec = getRecord(deviceId);
  res.json({
    used: rec.count,
    remaining: Math.max(0, FREE_SCANS - rec.count),
    limit: FREE_SCANS,
    resetAt: new Date(rec.resetAt).toISOString(),
  });
});

// ---------- Health check ----------
app.get('/health', (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Lather.AI backend running on port ${PORT}`));
