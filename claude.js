import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

// Quick local check before calling the API at all, to save cost/latency
// on messages that are obviously unrelated (e.g. "good morning everyone").
const QUICK_REGEX = /(\d{1,6})\s*(x\s*)?(salawat|solawat|salavat)?/i;

/**
 * Try to extract a salawat count from a free-form WhatsApp message.
 * Returns a positive integer, or null if the message isn't a submission.
 */
export async function extractSalawatCount(text) {
  if (!text || text.trim().length === 0) return null;

  // Fast path: simple "+50" or "50 salawat" style messages, no API call needed.
  const simpleMatch = text.trim().match(/^\+?(\d{1,6})$/);
  if (simpleMatch) return parseInt(simpleMatch[1], 10);

  // Skip an API call entirely if there's no digit anywhere in the message.
  if (!/\d/.test(text)) return null;

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 50,
      system: `You extract salawat (Islamic prayer) submission counts from WhatsApp group messages for a counting campaign.
Reply with ONLY a JSON object, no other text: {"count": <integer or null>}
Rules:
- If the message clearly reports a number of salawat the person just sent/recited (e.g. "did 50 today", "+30", "sent 100 salawat, alhamdulillah"), return that integer.
- If the message contains a number that is NOT a salawat count (e.g. a time, a date, an unrelated number), return null.
- If there's no clear salawat submission, return null.`,
      messages: [{ role: 'user', content: text }],
    });

    const raw = response.content.find((b) => b.type === 'text')?.text?.trim() || '{}';
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    const count = parsed.count;
    return Number.isInteger(count) && count > 0 ? count : null;
  } catch (err) {
    console.error('extractSalawatCount error:', err.message);
    // Fallback to the quick regex if the API call fails
    const fallback = text.match(QUICK_REGEX);
    if (fallback && fallback[1]) return parseInt(fallback[1], 10);
    return null;
  }
}

// Languages the bot replies in, in display order, each with a flag shown above its text.
const LANGUAGES = [
  { code: 'en', flag: '🇬🇧', name: 'English' },
  { code: 'ar', flag: '🇸🇦', name: 'Arabic' },
  { code: 'ro', flag: '🇷🇴', name: 'Romanian' },
  { code: 'ur', flag: '🇵🇰', name: 'Urdu' },
  { code: 'bn', flag: '🇧🇩', name: 'Bengali' },
];

function formatMultilingual(byLangCode) {
  return LANGUAGES.map(({ code, flag }) => `${flag} ${byLangCode[code]}`).join('\n\n');
}

/**
 * Generate a short, warm group message announcing the updated total,
 * in English, Arabic, Romanian, Urdu, and Bengali.
 */
export async function generateUpdateMessage({ total, goal, submittedBy, amount }) {
  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 500,
      system: `You write short, warm WhatsApp messages for an Islamic salawat-counting group campaign.
Reply with ONLY a JSON object, no other text: {"en": "...", "ar": "...", "ro": "...", "ur": "...", "bn": "..."}
Each value is the SAME message translated into that language (en=English, ar=Arabic, ro=Romanian, ur=Urdu, bn=Bengali).
Keep each version to 1-3 sentences. Include the running total and the goal (as digits, not spelled out). Vary the wording each time.
Tone: encouraging, warm, respectful. You may use one relevant emoji per version. Do not use markdown formatting.`,
      messages: [
        {
          role: 'user',
          content: `${submittedBy ? submittedBy + ' just' : 'Someone just'} submitted ${amount} salawat. New group total: ${total} out of ${goal}. Write the announcement message.`,
        },
      ],
    });

    const raw = response.content.find((b) => b.type === 'text')?.text?.trim() || '{}';
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    if (LANGUAGES.every(({ code }) => typeof parsed[code] === 'string' && parsed[code])) {
      return formatMultilingual(parsed);
    }
    throw new Error('Incomplete translation response');
  } catch (err) {
    console.error('generateUpdateMessage error:', err.message);
    return formatMultilingual({
      en: `JazakAllah khair! Group total: ${total}/${goal} salawat.`,
      ar: `جزاكم الله خيرًا! إجمالي المجموعة: ${total}/${goal} صلاة.`,
      ro: `Jazak Allah khair! Total grup: ${total}/${goal} salawat.`,
      ur: `جزاک اللہ خیر! گروپ کا مجموعہ: ${total}/${goal} صلاۃ۔`,
      bn: `জাযাকাল্লাহু খইর! দলের মোট: ${total}/${goal} সালাওয়াত।`,
    });
  }
}

/**
 * Static multi-language announcement sent once the campaign goal is reached.
 */
export function GOAL_REACHED_MESSAGE(goal) {
  return formatMultilingual({
    en: `🎉 Alhamdulillah! We've reached our goal of ${goal} salawat as a group! JazakAllah khair to everyone who took part.`,
    ar: `🎉 الحمد لله! لقد وصلنا إلى هدفنا وهو ${goal} صلاة كمجموعة! جزاكم الله خيرًا لكل من شارك.`,
    ro: `🎉 Alhamdulillah! Am atins obiectivul nostru de ${goal} salawat ca grup! Jazak Allah khair tuturor celor care au participat.`,
    ur: `🎉 الحمد للہ! ہم نے بطور گروپ اپنا ہدف ${goal} صلاۃ مکمل کر لیا! شریک ہونے والے سب کا جزاک اللہ خیر۔`,
    bn: `🎉 আলহামদুলিল্লাহ! আমরা দল হিসেবে আমাদের ${goal} সালাওয়াতের লক্ষ্য পূরণ করেছি! অংশগ্রহণকারী সবাইকে জাযাকাল্লাহু খইর।`,
  });
}
