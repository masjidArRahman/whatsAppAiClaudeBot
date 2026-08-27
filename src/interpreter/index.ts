import Anthropic from '@anthropic-ai/sdk';
import type { Command, InterpreterInterface } from './types.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

// Quick local check before calling the API at all, to save cost/latency
// on messages that are obviously unrelated (e.g. "good morning everyone").
const QUICK_REGEX = /(\d{1,6})\s*(x\s*)?(salawat|solawat|salavat)?/i;

// Nothing in the message even hints at one of the three intents we care
// about (a number, a slash command, or stats/me/submission wording, in
// either English or Arabic) — skip the API call entirely.
const QUICK_SKIP_REGEX =
  /\d|\/(stats|me)\b|\bstat(s|istics)?\b|\bsubmissions?\b|\bmine\b|salawat|solawat|salavat|صلوات|صلاة|صل(?:ي|و)?\s|اللهم\s*صل|إحصائيات|احصائيات|حسابي|مشاركاتي/i;

const INTENT_SYSTEM_PROMPT = `You classify WhatsApp group messages for a salawat (Islamic prayer) counting bot. Messages may be in English or Arabic. Every message is exactly one of four things:

1. "salawat" - the sender is reporting a count of salawat they just sent/recited (e.g. "did 50 today", "+30", "sent 100 salawat, alhamdulillah", "صليت ٥٠ صلوات", "اللهم صل على محمد ٣٠ مرة"). Extract the integer count (Arabic-Indic digits count too, e.g. ٥٠ = 50).
2. "stats" - the sender is asking to see the group's overall statistics, such as a weekly distribution/graph/breakdown of totals. Triggered by the literal command "/stats" or natural phrasing like "show stats", "what's our weekly progress", "graph of this week", "الإحصائيات", "احصائيات الأسبوع".
3. "me" - the sender is asking to be sent (privately) a list/history of their own submissions. Triggered by the literal command "/me" or natural phrasing like "show my submissions", "what have I submitted", "send me my total", "مشاركاتي", "حسابي".
4. "none" - anything else: greetings, unrelated chat, a number that isn't a salawat count (a date, a time, a phone number), or any other message that doesn't clearly match one of the above.

Reply with ONLY a JSON object, no other text: {"intent": "salawat" | "stats" | "me" | "none", "count": <integer or null>}
Rules:
- "count" is only meaningful when intent is "salawat"; it must be null for every other intent.
- If a message is ambiguous between two intents, or doesn't clearly match any, return "none".`;

class Interpreter implements InterpreterInterface {
  async extractSalawatCount(text: string): Promise<number | null> {
    const command = await this.processMessage(text);
    return command?.type === 'salawat' ? command.count : null;
  }

  async processMessage(message: string): Promise<Command | null> {
    const text = message?.trim();
    if (!text) return null;

    // Fast paths: obvious cases handled locally, no API call needed.
    const normalized = text.toLowerCase();
    if (normalized === '/stats') return { type: 'stats' };
    if (normalized === '/me') return { type: 'me' };

    const simpleMatch = text.match(/^\+?(\d{1,6})$/);
    if (simpleMatch?.[1]) return { type: 'salawat', count: parseInt(simpleMatch[1], 10) };

    if (!QUICK_SKIP_REGEX.test(text)) return null;

    try {
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 50,
        system: INTENT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: text }],
      });

      const raw = response.content.find((b) => b.type === 'text')?.text?.trim() || '{}';
      const cleaned = raw.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(cleaned);

      if (parsed.intent === 'stats') return { type: 'stats' };
      if (parsed.intent === 'me') return { type: 'me' };
      if (parsed.intent === 'salawat' && Number.isInteger(parsed.count) && parsed.count > 0) {
        return { type: 'salawat', count: parsed.count };
      }
      return null;
    } catch (err) {
      console.error('processMessage error:', err instanceof Error ? err.message : err);
      // Fallback to the quick regex if the API call fails; /stats and /me
      // are already handled above, so only salawat counts can be recovered.
      const fallback = text.match(QUICK_REGEX);
      if (fallback?.[1]) return { type: 'salawat', count: parseInt(fallback[1], 10) };
      return null;
    }
  }
}

const interpreter = new Interpreter();
export default interpreter;
