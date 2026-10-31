import Anthropic from '@anthropic-ai/sdk';
import { ResponseType } from '../constants.js';
import type { Command, InterpreterInterface } from './types.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
// A single submission above this is ignored entirely (no reply, nothing saved).
const MAX_SALAWAT_PER_SUBMISSION = parseInt(process.env.MAX_SALAWAT_PER_SUBMISSION || '10000', 10);

// Quick local check before calling the API at all, to save cost/latency
// on messages that are obviously unrelated (e.g. "good morning everyone").
const MAX_GOAL_CONTEXT_LENGTH = 100;
const QUICK_REGEX = /(\d{1,6})\s*(x\s*)?(salawat|solawat|salavat)?/i;

// Nothing in the message even hints at one of the three intents we care
// about (a number, a slash command, or stats/me/submission wording, in
// either English or Arabic) — skip the API call entirely.
const QUICK_SKIP_REGEX =
  /\d|\/(stats|me|help|awlia|subscribe|unsubscribe)\b|\bstat(s|istics)?\b|\bsubmissions?\b|\bmine\b|\bhelp\b|\bcommands?\b|\bawlia\b|\bparticipants?\b|\bunsubscribe\b|\bsubscribe\b|salawat|solawat|salavat|صلوات|صلاة|صل(?:ي|و)?\s|اللهم\s*صل|إحصائيات|احصائيات|حسابي|مشاركاتي|مساعدة|أوامر|اوامر|أولياء|اولياء|إلغاء\s*الاشتراك|الغاء\s*الاشتراك|الاشتراك/i;

const INTENT_SYSTEM_PROMPT = `You classify WhatsApp group messages for a salawat (Islamic prayer) counting bot. Messages may be in English or Arabic. Every message is exactly one of eight things:

1. "salawat" - the sender (or their group, speaking as "we") is REPORTING a specific salawat count as something just completed or being submitted right now - not describing a habit, rule, plan, or general fact. Look for a completion marker tied directly to the number: past tense ("did", "sent", "recited", "صليت", "قمنا", "أنجزنا"), or an immediacy word ("just", "today", "الآن", "اليوم"). Examples: "did 50 today", "+30", "sent 100 salawat, alhamdulillah", "صليت ٥٠ صلوات", "اللهم صل على محمد ٣٠ مرة", "قمنا اليوم بـ ٥٠٠٠ صلاة كمجموعة". Extract the integer count exactly as stated (Arabic-Indic digits count too, e.g. ٥٠ = 50) - never multiply or estimate a total from a group size and a per-person rate.

   Do NOT classify as "salawat" - use "none" instead - when the message merely DESCRIBES a routine, rule, plan, or general fact involving numbers, even if it mentions salawat and a count. Signs of this: habitual/generic verb forms ("each person recites 500 daily", "كل واحد يذكر ٥٠٠ صلاة يومياً"), describing the group itself ("we are a group of ten people..."), suggestions or future plans ("let's each aim for 100 a day"), or general reminders/information with no claim that a submission happened just now. Example that is "none", not "salawat": "الحمدلله نحن مجموعة من عشرة أشخاص كل واحد يذكر 500 صلاة على النبي يومياً" (Alhamdulillah, we are a group of ten people, each one recites 500 salawat on the Prophet daily) - this explains the group's practice, it does not report today's submission.
2. "stats" - the sender is asking to see the group's overall statistics, such as an all-time distribution/graph/breakdown of totals by day of week. Triggered by the literal command "/stats" or natural phrasing like "show stats", "what's our progress", "graph of all salawat", "الإحصائيات", "الإحصائيات الكلية".
3. "me" - the sender is asking to be sent (privately) a list/history of their own submissions. Triggered by the literal command "/me" or natural phrasing like "show my submissions", "what have I submitted", "send me my total", "مشاركاتي", "حسابي".
4. "help" - the sender is asking what the bot can do, what commands exist, or how the salawat counting works. Triggered by the literal command "/help" or natural phrasing like "what can you do", "how does this work", "what are the commands", "مساعدة", "ما هي الأوامر", "كيف يعمل هذا البوت".
5. "awlia" - the sender wants to see the full list of everyone who has submitted salawat so far, in random order (explicitly NOT ranked or sorted by count). Triggered by the literal command "/awlia" or natural phrasing like "who has participated", "list everyone who submitted", "show me the awlia", "من شارك؟", "قائمة الأولياء".
6. "subscribe" - the sender wants to opt IN to the weekly salawat digest DM (a private weekly summary of their own count). Triggered by the literal command "/subscribe" or natural phrasing like "subscribe me", "send me the weekly digest", "أريد الاشتراك", "اشتراك".
7. "unsubscribe" - the sender wants to opt OUT of the weekly salawat digest DM. Triggered by the literal command "/unsubscribe" or natural phrasing like "unsubscribe me", "stop the weekly messages", "إلغاء الاشتراك", "لا أريد الرسالة الأسبوعية".
8. "none" - anything else: greetings, unrelated chat, a number that isn't a salawat count (a date, a time, a phone number), a message describing a routine/rule/plan (see above), or any other message that doesn't clearly match one of the above.

Reply with ONLY a JSON object, no other text: {"intent": "salawat" | "stats" | "me" | "help" | "awlia" | "subscribe" | "unsubscribe" | "none", "count": <integer or null>}
Rules:
- "count" is only meaningful when intent is "salawat"; it must be null for every other intent.
- A message can both describe context (e.g. group size, routine) AND report a real completion (e.g. "today we did X") - if it contains a genuine completion/immediacy marker for a specific number, classify it as "salawat" with that number, even alongside descriptive text.
- If a message is ambiguous between two intents, or doesn't clearly match any, return "none".`;

class Interpreter implements InterpreterInterface {
  async extractSalawatCount(text: string): Promise<number | null> {
    const command = await this.processMessage(text);
    return command?.type === ResponseType.SALAWAT ? command.count : null;
  }

  async processMessage(message: string): Promise<Command | null> {
    const command = await this.classifyMessage(message);
    if (command?.type === ResponseType.SALAWAT && command.count > MAX_SALAWAT_PER_SUBMISSION) return null;
    return command;
  }

  private async classifyMessage(message: string): Promise<Command | null> {
    const text = message?.trim();
    if (!text) return null;

    // Fast paths: obvious cases handled locally, no API call needed.
    const normalized = text.toLowerCase();
    if (normalized === '/stats') return { type: ResponseType.STATS };
    if (normalized === '/me') return { type: ResponseType.ME };
    if (normalized === '/help') return { type: ResponseType.HELP };
    if (normalized === '/awlia') return { type: ResponseType.AWLIA };
    if (normalized === '/subscribe') return { type: ResponseType.SUBSCRIBE };
    if (normalized === '/unsubscribe') return { type: ResponseType.UNSUBSCRIBE };

    // Hidden command: intentionally not in QUICK_SKIP_REGEX or the classifier
    // prompt below, so it's undiscoverable via /help or natural language.
    // Optional second argument is free-text goal context (e.g. "end of Ramadan"), kept in its original casing.
    const updateGoalMatch = text.match(/^\/update-goal\s+(\d{1,9})(?:\s+(.+))?$/is);
    if (updateGoalMatch?.[1]) {
      const goal = parseInt(updateGoalMatch[1], 10);
      const goalContext = updateGoalMatch[2]?.trim().replace(/^["“”']+|["“”']+$/g, '').trim().slice(0, MAX_GOAL_CONTEXT_LENGTH) || null;
      if (goal > 0) return { type: ResponseType.UPDATE_GOAL, goal, goalContext };
    }

    const simpleMatch = text.match(/^\+?(\d{1,6})$/);
    if (simpleMatch?.[1]) return { type: ResponseType.SALAWAT, count: parseInt(simpleMatch[1], 10) };

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

      if (parsed.intent === ResponseType.STATS) return { type: ResponseType.STATS };
      if (parsed.intent === ResponseType.ME) return { type: ResponseType.ME };
      if (parsed.intent === ResponseType.HELP) return { type: ResponseType.HELP };
      if (parsed.intent === ResponseType.AWLIA) return { type: ResponseType.AWLIA };
      if (parsed.intent === ResponseType.SUBSCRIBE) return { type: ResponseType.SUBSCRIBE };
      if (parsed.intent === ResponseType.UNSUBSCRIBE) return { type: ResponseType.UNSUBSCRIBE };
      if (parsed.intent === ResponseType.SALAWAT && Number.isInteger(parsed.count) && parsed.count > 0) {
        return { type: ResponseType.SALAWAT, count: parsed.count };
      }
      return null;
    } catch (err) {
      console.error('processMessage error:', err instanceof Error ? err.message : err);
      // Fallback to the quick regex if the API call fails; /stats, /me, /help
      // and /awlia are already handled above, so only salawat counts can be recovered.
      const fallback = text.match(QUICK_REGEX);
      if (fallback?.[1]) return { type: ResponseType.SALAWAT, count: parseInt(fallback[1], 10) };
      return null;
    }
  }
}

const interpreter = new Interpreter();
export default interpreter;
