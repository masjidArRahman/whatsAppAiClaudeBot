import Anthropic from '@anthropic-ai/sdk';
import { ResponseType } from '../constants.js';
import type {
  AwliaResponse,
  HelpResponse,
  MeResponse,
  SalawatResponse,
  StatsResponse,
  DispatchResponse,
  GoalReachedResponse,
  UpdateGoalResponse,
  WelcomeResponse,
  WeeklyDigestResponse,
} from '../dispatcher/types.js';
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

// A few varied fallback acknowledgements (used only if the AI call fails or
// returns something malformed) so even the fallback path doesn't always say
// the exact same thing. Written without the name; presentSalawat prepends a
// simple vocative ("Name, ...") when one is available.
const SALAWAT_FALLBACKS: MultilingualText[] = [
  {
    en: 'JazakAllah khair, keep going! 🌙',
    ar: 'جزاك الله خيرًا، واصل الجهد! 🌙',
    ro: 'Jazak Allah khair, continuă! 🌙',
    ur: 'جزاک اللہ خیر، جاری رکھیں! 🌙',
    bn: 'জাযাকাল্লাহু খইর, চালিয়ে যান! 🌙',
  },
  {
    en: 'That one just landed, alhamdulillah 🌙',
    ar: 'وصلت هذه، الحمد لله 🌙',
    ro: 'Asta tocmai s-a adăugat, alhamdulillah 🌙',
    ur: 'یہ ابھی شامل ہوگئی، الحمدللہ 🌙',
    bn: 'এইটা যোগ হয়ে গেল, আলহামদুলিল্লাহ 🌙',
  },
  {
    en: 'May it be accepted, ameen 🤲',
    ar: 'تقبل الله منك، آمين 🤲',
    ro: 'Fie primită, amin 🤲',
    ur: 'اللہ قبول فرمائے، آمین 🤲',
    bn: 'আল্লাহ কবুল করুন, আমিন 🤲',
  },
];

// Example of the exact structure Claude must follow for /stats. Not real data -
// the model fills in a fresh caption/closer but must leave the bar lines untouched.
const STATS_TEMPLATE = `📈 All-time salawat by day
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
      case ResponseType.SALAWAT:
        return this.presentSalawat(response);
      case ResponseType.ME:
        return this.presentMe(response);
      case ResponseType.STATS:
        return this.presentStats(response);
      case ResponseType.HELP:
        return this.presentHelp(response);
      case ResponseType.AWLIA:
        return this.presentAwlia(response);
      case ResponseType.UPDATE_GOAL:
        return this.presentUpdateGoal(response);
      case ResponseType.WELCOME:
        return this.presentWelcome(response);
      case ResponseType.SUBSCRIBE:
        return this.presentSubscribe();
      case ResponseType.UNSUBSCRIBE:
        return this.presentUnsubscribe();
      case ResponseType.WEEKLY_DIGEST:
        return this.presentWeeklyDigest(response);
      case ResponseType.GOAL_REACHED:
        return this.presentGoalReached(response);
    }
  }

  private async presentSalawat({ user, count, total, goal }: SalawatResponse): Promise<string> {
    const header = `${total}/${goal}`;
    const name = user.name;

    const fallback = () => {
      const base = SALAWAT_FALLBACKS[Math.floor(Math.random() * SALAWAT_FALLBACKS.length)]!;
      const withName = name
        ? (Object.fromEntries(LANGUAGES.map(({ code }) => [code, `${name}, ${base[code]}`])) as MultilingualText)
        : base;
      return `${header}\n\n${formatMultilingual(withName)}`;
    };

    try {
      const res = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 250,
        system: `You write short WhatsApp replies acknowledging someone's salawat (Islamic prayer) submission in a group counting campaign. You'll be given their name (or told it's unknown).
Reply with ONLY a JSON object, no other text: {"en": "...", "ar": "...", "ro": "...", "ur": "...", "bn": "..."}
Each value is the SAME message, adapted (not word-for-word translated) into that language (en=English, ar=Arabic, ro=Romanian, ur=Urdu, bn=Bengali) - it should read like something a real person would actually text a friend, not a translated slogan.
Rules:
- 6-12 words per language. Do not include any numbers - the count is already shown separately.
- When a name is given, use it in most (not all) of the five versions - and vary where it lands (start, middle, end, or as a direct address) rather than always opening with it the same way.
- Lean into Islamic phrasing: duas and expressions like "JazakAllah khair", "BarakAllahu feek", "Alhamdulillah", "MashaAllah", or wishing it's accepted, fit this context well and are encouraged. Plain encouragement ("well done", "keep going", etc.) is also fine when it fits - it doesn't need to be avoided - just don't make every reply sound the same.
- In Romanian, keep common Islamic terms transliterated as Muslims actually say them (e.g. "Jazak Allah khair", "Maşa'Allah", "Alhamdulillah", "Insha'Allah") rather than translating them into Romanian words.
- Sound like a genuine person, not a hype poster - vary the tone and sentence structure across the five language versions and across calls so replies don't blur together.
- At most one relevant emoji, and only where it actually fits - not every version needs one.
- No markdown formatting.`,
        messages: [
          {
            role: 'user',
            content: name
              ? `${name} just submitted ${count} salawat. Write the short acknowledgement, using their name naturally.`
              : `Someone (name unknown) just submitted ${count} salawat. Write the short acknowledgement without inventing a name.`,
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
      return fallback();
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

  private async presentStats({ distribution, total }: StatsResponse): Promise<string> {
    const max = Math.max(...distribution.map((d) => d.count), 1);
    const barLines = distribution.map((d) => `${d.day} ${renderBar(d.count, max)} ${d.count}`);
    const label = 'All-time salawat by day';
    const fallback = () => [label, ...barLines, '─'.repeat(16), `Total: ${total}`, 'Keep it up! 🌙'].join('\n');

    try {
      const res = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 200,
        system: `You compose a short, narrow, vertically-oriented ascii bar-chart WhatsApp message reporting salawat (Islamic prayer) submission counts, summed across every submission ever recorded and broken down by day of week. It must fit on small phone screens without any line wrapping.
Follow this EXACT structure (example only, not real data):
${STATS_TEMPLATE}

Rules:
- Output ONLY the final message text - no commentary, no markdown code fences.
- Line 1: a short, varied caption based on the label given (max ~24 characters). Vary the wording every time, never reuse the example caption verbatim.
- Next: the day bar lines EXACTLY AS GIVEN below, one per line, completely unchanged (same characters, spacing, and values - do not recompute or restyle them).
- Next: a divider line of exactly 16 "─" characters.
- Next: "Total: <total>" using the exact total given.
- Last line: one short, varied, encouraging closing sentence (max ~24 characters), at most one emoji.
- No line should exceed roughly 20 characters so it stays legible and unwrapped on small phones.`,
        messages: [
          {
            role: 'user',
            content: `Label: ${label}\nBar lines:\n${barLines.join('\n')}\nTotal: ${total}\nWrite the message.`,
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

  // Hardcoded rather than AI-generated: a command listing must stay accurate,
  // not paraphrased, and only needs English + Arabic here (unlike the
  // multilingual salawat acknowledgements).
  private presentHelp({ goal }: HelpResponse): string {
    const goalStr = goal.toLocaleString('en-US');
    return [
      '📖 *Available commands*',
      '',
      '🇬🇧 English',
      '• Send a number (e.g. "50" or "+50") to log that many salawat.',
      '• /stats — all-time salawat totals, broken down by day of week.',
      '• /me — privately see your own submission history.',
      '• /awlia — see everyone who has taken part, in random order.',
      '• /help — show this message.',
      '• /unsubscribe — opt out of the weekly private digest of your own salawat (on by default).',
      '• /subscribe — opt back in to the weekly digest.',
      '',
      `We're counting together toward a shared goal of ${goalStr} salawat — every submission adds to the group total, no need to track your own.`,
      '',
      '🇸🇦 العربية',
      '• أرسل رقمًا (مثل "50" أو "+50") لتسجيل عدد الصلوات التي صليتها.',
      '• /stats — إجمالي الصلوات منذ البداية، موزعًا حسب أيام الأسبوع.',
      '• /me — لعرض سجل مشاركاتك الخاص بشكل خاص.',
      '• /awlia — لعرض كل من شارك، بترتيب عشوائي.',
      '• /help — لعرض هذه الرسالة.',
      '• /unsubscribe — لإيقاف الرسالة الأسبوعية الخاصة بصلواتك (مفعّلة افتراضيًا).',
      '• /subscribe — للاشتراك مرة أخرى في الرسالة الأسبوعية.',
      '',
      `نجمع الصلوات معًا نحو هدف مشترك قدره ${goalStr} صلاة - كل مشاركة تُضاف إلى المجموع العام، فلا حاجة لحساب صلواتك بنفسك.`,
    ].join('\n');
  }

  // Hardcoded like presentHelp: a roster of names must stay accurate, and the
  // "random order" contract would be undermined by an LLM re-ordering it.
  private presentAwlia({ users }: AwliaResponse): string {
    if (users.length === 0) {
      return ['🌙 No one has submitted any salawat yet.', '🌙 لم يشارك أحد بعد بالصلوات.'].join('\n');
    }

    const lines = users.map((u, i) => `${i + 1}. ${u.name ?? u.phoneNumber}`);

    return [
      '🌙 *Awlia so far* (random order, not ranked)',
      '🌙 *الأولياء حتى الآن* (بترتيب عشوائي، غير مرتب)',
      '',
      ...lines,
    ].join('\n');
  }

  private presentUpdateGoal({ goal }: UpdateGoalResponse): string {
    return `✅ Goal updated to ${goal.toLocaleString('en-US')} salawat.`;
  }

  private presentSubscribe(): string {
    return [
      "✅ You're subscribed to the weekly salawat digest — a private summary of your own count, once a week.",
      '✅ تم اشتراكك في الرسالة الأسبوعية لصلواتك - ملخص خاص بعدد صلواتك، مرة كل أسبوع.',
    ].join('\n');
  }

  private presentUnsubscribe(): string {
    return [
      "✅ You're unsubscribed from the weekly salawat digest. Send /subscribe anytime to opt back in.",
      '✅ تم إلغاء اشتراكك من الرسالة الأسبوعية. أرسل /subscribe في أي وقت للاشتراك مرة أخرى.',
    ].join('\n');
  }

  // Hardcoded like presentHelp/presentAwlia: sent to many recipients on a
  // fan-out schedule, so it needs to stay fast, cheap, and consistent rather
  // than costing one AI call per recipient.
  private presentWeeklyDigest({ user, total, distribution }: WeeklyDigestResponse): string {
    const max = Math.max(...distribution.map((d) => d.count), 1);
    const barLines = distribution.map((d) => `${d.day} ${renderBar(d.count, max)} ${d.count}`);
    const name = user.name;

    return [
      name ? `Salam, ${name}! 🌙` : 'Salam! 🌙',
      'Your salawat this past week:',
      ...barLines,
      '─'.repeat(16),
      `Total: ${total}`,
      '',
      "This is your automatic weekly digest. Send /unsubscribe anytime to stop it, or /subscribe to opt back in.",
      '',
      name ? `السلام عليك يا ${name}! 🌙` : 'السلام عليكم! 🌙',
      'صلواتك خلال الأسبوع الماضي كما هو موضح أعلاه.',
      `المجموع: ${total}`,
      '',
      'هذه رسالتك الأسبوعية التلقائية. أرسل /unsubscribe في أي وقت لإيقافها، أو /subscribe للاشتراك مرة أخرى.',
    ].join('\n');
  }

  // Hardcoded like presentWelcome: a once-per-goal milestone carrying exact
  // numbers, so it shouldn't risk an LLM rounding or paraphrasing them. Uses
  // all five LANGUAGES (like the salawat acknowledgement it follows) since
  // it's addressed to the whole group.
  private presentGoalReached({ total, goal, participants }: GoalReachedResponse): string {
    const totalStr = total.toLocaleString('en-US');
    const goalStr = goal.toLocaleString('en-US');

    return [
      '🎉🌙 *Goal reached!* 🌙🎉',
      `${totalStr} / ${goalStr}`,
      '',
      formatMultilingual({
        en: `Alhamdulillah! Together we've reached our goal of ${goalStr} salawat, with ${participants} of you taking part. JazakumAllahu khairan to everyone - may Allah accept it from all of us 🤲`,
        ar: `الحمد لله! بلغنا معًا هدفنا البالغ ${goalStr} صلاة بمشاركة ${participants} منكم. جزاكم الله خيرًا جميعًا، وتقبل الله منا ومنكم 🤲`,
        ro: `Alhamdulillah! Împreună am atins obiectivul de ${goalStr} salawat, cu ${participants} participanți. Jazakumullahu khairan tuturor - Allah să primească de la noi toți 🤲`,
        ur: `الحمدللہ! ہم سب نے مل کر ${goalStr} درود کا ہدف پورا کر لیا، ${participants} افراد کی شرکت سے۔ جزاکم اللہ خیراً سب کو - اللہ ہم سب سے قبول فرمائے 🤲`,
        bn: `আলহামদুলিল্লাহ! আমরা সবাই মিলে ${goalStr} দরুদের লক্ষ্যে পৌঁছেছি, ${participants} জনের অংশগ্রহণে। সবাইকে জাযাকুমুল্লাহু খইরান - আল্লাহ আমাদের সবার পক্ষ থেকে কবুল করুন 🤲`,
      }),
    ].join('\n');
  }

  // Hardcoded like presentHelp/presentAwlia: carries exact totals, so it
  // shouldn't risk an LLM rounding or paraphrasing the numbers.
  private presentWelcome({ name, total, goal }: WelcomeResponse): string {
    const totalStr = total.toLocaleString('en-US');
    const goalStr = goal.toLocaleString('en-US');
    const greetingEn = name ? `Welcome, ${name}! 🌙` : 'Welcome! 🌙';
    const greetingAr = name ? `أهلاً بك، ${name}! 🌙` : 'أهلاً بك! 🌙';

    return [
      greetingEn,
      `We've reached ${totalStr} out of our shared goal of ${goalStr} salawat so far — glad to have you counting with us.`,
      '',
      greetingAr,
      `لقد وصلنا إلى ${totalStr} من هدفنا المشترك البالغ ${goalStr} صلاة حتى الآن - يسعدنا انضمامك إلينا في العد.`,
    ].join('\n');
  }
}

const presenter = new Presenter();
export default presenter;
