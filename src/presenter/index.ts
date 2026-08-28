import Anthropic from '@anthropic-ai/sdk';
import type { MeResponse, SalawatResponse, StatsResponse, DispatchResponse } from '../dispatcher/types.js';
import type { PresenterInterface } from './types.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

const BAR_WIDTH = 10; // fixed-width bar so every line is the same length - no wrapping on narrow screens
const MAX_ME_ROWS = 20;

// Languages the bot replies in for salawat confirmations, in display order, each with a flag shown above its text.
const LANGUAGES = [
  { code: 'en', flag: '🇬🇧' },
  { code: 'ar', flag: '🇸🇦' },
  { code: 'ro', flag: '🇷🇴' },
  { code: 'ur', flag: '🇵🇰' },
  { code: 'bn', flag: '🇧🇩' },
] as const;

type MultilingualText = Record<(typeof LANGUAGES)[number]['code'], string>;

function formatMultilingual(byLangCode: MultilingualText): string {
  return LANGUAGES.map(({ code, flag }) => `${flag} ${byLangCode[code]}`).join('\n');
}

// Example of the exact structure Claude must follow for /stats. Not real data -
// the model fills in a fresh caption/closer but must leave the bar lines untouched.
const STATS_TEMPLATE = `📈 This week's salawat
Mon ████████░░ 8
Tue ██████████ 10
Wed ░░░░░░░░░░ 0
Thu ███░░░░░░░ 3
Fri █████░░░░░ 5
Sat ██████░░░░ 6
Sun ██░░░░░░░░ 2
────────────────
Total: 34
Keep it up! 🌙`;

function renderBar(count: number, max: number): string {
  const filled = max === 0 ? 0 : Math.round((count / max) * BAR_WIDTH);
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
}

function formatDateTime(date: Date): string {
  const day = date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${day} ${time}`;
}

class Presenter implements PresenterInterface {
  async processResponse(response: DispatchResponse): Promise<string> {
    switch (response.type) {
      case 'salawat':
        return this.presentSalawat(response);
      case 'me':
        return this.presentMe(response);
      case 'stats':
        return this.presentStats(response);
    }
  }

  private async presentSalawat({ user, count, total, goal }: SalawatResponse): Promise<string> {
    const header = `${total}/${goal}`;

    try {
      const res = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 200,
        system: `You write extremely short WhatsApp replies acknowledging someone's salawat (Islamic prayer) submission in a group counting campaign.
Reply with ONLY a JSON object, no other text: {"en": "...", "ar": "...", "ro": "...", "ur": "...", "bn": "..."}
Each value is the SAME short message translated into that language (en=English, ar=Arabic, ro=Romanian, ur=Urdu, bn=Bengali).
Rules:
- Around 5 words per language - do not include any numbers, the count is already shown separately.
- Warm, encouraging, and varied - never reuse the same phrasing or structure twice.
- At most one relevant emoji per version.
- No markdown formatting.`,
        messages: [
          {
            role: 'user',
            content: `${user.name ?? 'Someone'} just submitted ${count} salawat. Write the short acknowledgement.`,
          },
        ],
      });

      const raw = res.content.find((b) => b.type === 'text')?.text?.trim() || '{}';
      const cleaned = raw.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(cleaned);

      if (LANGUAGES.every(({ code }) => typeof parsed[code] === 'string' && parsed[code])) {
        return `${header}\n\n${formatMultilingual(parsed)}`;
      }
      throw new Error('Incomplete translation response');
    } catch (err) {
      console.error('presentSalawat error:', err instanceof Error ? err.message : err);
      return `${header}\n\n${formatMultilingual({
        en: 'JazakAllah khair, keep going! 🌙',
        ar: 'جزاك الله خيرًا، واصل الجهد! 🌙',
        ro: 'Jazak Allah khair, continuă! 🌙',
        ur: 'جزاک اللہ خیر، جاری رکھیں! 🌙',
        bn: 'জাযাকাল্লাহু খইর, চালিয়ে যান! 🌙',
      })}`;
    }
  }

  private presentMe({ user, submissions, total }: MeResponse): string {
    if (submissions.length === 0) {
      return `${user.name ?? 'You'} haven't submitted any salawat yet.`;
    }

    const shown = submissions.slice(0, MAX_ME_ROWS);
    const lines = shown.map((s) => `${formatDateTime(s.submittedAt)}  +${s.count}`);
    const remaining = submissions.length - shown.length;

    return [
      `Your submissions (total: ${total}):`,
      ...lines,
      remaining > 0 ? `…and ${remaining} more` : null,
    ]
      .filter((line): line is string => line !== null)
      .join('\n');
  }

  private async presentStats({ isCurrentWeek, distribution, total }: StatsResponse): Promise<string> {
    const max = Math.max(...distribution.map((d) => d.count), 1);
    const barLines = distribution.map((d) => `${d.day} ${renderBar(d.count, max)} ${d.count}`);
    const weekLabel = isCurrentWeek ? "This week's salawat so far" : "Last week's salawat";
    const fallback = () => [weekLabel, ...barLines, '─'.repeat(16), `Total: ${total}`, 'Keep it up! 🌙'].join('\n');

    try {
      const res = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 200,
        system: `You compose a short, narrow, vertically-oriented ascii bar-chart WhatsApp message reporting weekly salawat (Islamic prayer) submission counts. It must fit on small phone screens without any line wrapping.
Follow this EXACT structure (example only, not real data):
${STATS_TEMPLATE}

Rules:
- Output ONLY the final message text - no commentary, no markdown code fences.
- Line 1: a short, varied caption based on the week label given (max ~24 characters). Vary the wording every time, never reuse the example caption verbatim.
- Next: the day bar lines EXACTLY AS GIVEN below, one per line, completely unchanged (same characters, spacing, and values - do not recompute or restyle them).
- Next: a divider line of exactly 16 "─" characters.
- Next: "Total: <total>" using the exact total given.
- Last line: one short, varied, encouraging closing sentence (max ~24 characters), at most one emoji.
- No line should exceed roughly 20 characters so it stays legible and unwrapped on small phones.`,
        messages: [
          {
            role: 'user',
            content: `Week label: ${weekLabel}\nBar lines:\n${barLines.join('\n')}\nTotal: ${total}\nWrite the message.`,
          },
        ],
      });

      const text = res.content.find((b) => b.type === 'text')?.text?.trim();
      if (text && barLines.every((line) => text.includes(line))) return text;
      throw new Error('Malformed stats response');
    } catch (err) {
      console.error('presentStats error:', err instanceof Error ? err.message : err);
      return fallback();
    }
  }
}

const presenter = new Presenter();
export default presenter;
