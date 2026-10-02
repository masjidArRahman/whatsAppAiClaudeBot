import prisma from '../db.js';
import { ResponseType } from '../constants.js';
import type { Command } from '../interpreter/types.js';
import type { MessageSender } from '../messenger/types.js';
import type {
  DayCount,
  DispatcherInterface,
  DispatchResponse,
  GoalReachedResponse,
  WeeklyDigestResponse,
} from './types.js';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const; // index = Date#getDay()
const DAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const; // Monday-first display order
const DEFAULT_GOAL = parseInt(process.env.SALAWAT_GOAL || '100000', 10);
const SETTINGS_ID = 1; // singleton settings row
const WEEK_MS = 7 * 24 * 60 * 60 * 1000; // rolling window, not calendar-week

function resolvePhoneNumber(sender: MessageSender): string {
  return sender.phoneNumber ?? sender.id.split('@')[0] ?? sender.id;
}

/** Reads the shared goal from the DB, falling back to SALAWAT_GOAL until /update-goal is ever used. */
async function getGoal(): Promise<number> {
  const setting = await prisma.setting.findUnique({ where: { id: SETTINGS_ID } });
  return setting?.goal ?? DEFAULT_GOAL;
}

/** Group-wide running total, summed across every submission ever recorded. */
async function getTotal(): Promise<number> {
  const { _sum } = await prisma.submission.aggregate({ _sum: { count: true } });
  return _sum.count ?? 0;
}

/** Fisher-Yates shuffle - returns a new array, doesn't mutate the input. */
function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j] as T, result[i] as T];
  }
  return result;
}

/** Buckets every submission ever recorded by day of week (Mon-Sun), summed across all history. */
function buildDistribution(submissions: { count: number; submittedAt: Date }[]): DayCount[] {
  const days: DayCount[] = DAY_ORDER.map((day) => ({ day, count: 0 }));

  for (const submission of submissions) {
    const label = DAY_LABELS[submission.submittedAt.getDay()];
    const bucket = days.find((d) => d.day === label);
    if (bucket) bucket.count += submission.count;
  }

  return days;
}

class Dispatcher implements DispatcherInterface {
  async processCommand(command: Command, sender: MessageSender): Promise<DispatchResponse> {
    switch (command.type) {
      case ResponseType.SALAWAT:
        return this.handleSalawat(command.count, sender);
      case ResponseType.ME:
        return this.handleMe(sender);
      case ResponseType.STATS:
        return this.handleStats();
      case ResponseType.HELP:
        return this.handleHelp();
      case ResponseType.AWLIA:
        return this.handleAwlia();
      case ResponseType.UPDATE_GOAL:
        return this.handleUpdateGoal(command.goal);
      case ResponseType.SUBSCRIBE:
        return this.handleSubscribe(sender);
      case ResponseType.UNSUBSCRIBE:
        return this.handleUnsubscribe(sender);
    }
  }

  private async findOrCreateUser(sender: MessageSender) {
    const phoneNumber = resolvePhoneNumber(sender);
    const existing = await prisma.user.findUnique({ where: { phoneNumber } });
    if (existing) {
      // Self-heal chatId as people message in - covers both users created
      // before this field existed, and a JID that legitimately changes.
      // Cheap no-op write skip on the (very common) unchanged case.
      if (existing.chatId !== sender.id) {
        await prisma.user.update({ where: { id: existing.id }, data: { chatId: sender.id } });
      }
      return { ...existing, chatId: sender.id };
    }
    return prisma.user.create({ data: { phoneNumber, name: sender.name, chatId: sender.id } });
  }

  private async handleSalawat(count: number, sender: MessageSender): Promise<DispatchResponse> {
    const user = await this.findOrCreateUser(sender);
    await prisma.submission.create({
      data: { count, submittedAt: new Date(), authorId: user.id },
    });

    const { _sum } = await prisma.submission.aggregate({ _sum: { count: true } });
    const total = _sum.count ?? count;
    const goal = await getGoal();

    return {
      type: ResponseType.SALAWAT,
      user: { id: user.id, name: user.name, phoneNumber: user.phoneNumber },
      count,
      total,
      goal,
      goalReached: total >= goal && (await this.claimGoalCelebration(goal)),
    };
  }

  /**
   * Atomically marks `goal` as celebrated, returning true only for the one
   * caller that actually flipped it - so two submissions landing at the same
   * moment can't both trigger a congratulations message. Keyed on the goal
   * value rather than a plain flag, so raising the goal via /update-goal
   * re-arms the celebration for the new target.
   */
  private async claimGoalCelebration(goal: number): Promise<boolean> {
    // The settings row may not exist yet if /update-goal was never used.
    await prisma.setting.upsert({
      where: { id: SETTINGS_ID },
      update: {},
      create: { id: SETTINGS_ID, goal },
    });
    const { count } = await prisma.setting.updateMany({
      // `not` alone doesn't match NULL in SQL, hence the explicit OR.
      where: { id: SETTINGS_ID, OR: [{ celebratedGoal: null }, { celebratedGoal: { not: goal } }] },
      data: { celebratedGoal: goal },
    });
    return count > 0;
  }

  async buildGoalReached(total: number, goal: number): Promise<GoalReachedResponse> {
    const participants = await prisma.user.count({ where: { submissions: { some: {} } } });
    return { type: ResponseType.GOAL_REACHED, total, goal, participants };
  }

  private async handleMe(sender: MessageSender): Promise<DispatchResponse> {
    const user = await this.findOrCreateUser(sender);
    const submissions = await prisma.submission.findMany({
      where: { authorId: user.id },
      orderBy: { submittedAt: 'desc' },
      select: { count: true, submittedAt: true },
    });

    return {
      type: ResponseType.ME,
      user: { id: user.id, name: user.name, phoneNumber: user.phoneNumber },
      submissions,
      total: submissions.reduce((sum, s) => sum + s.count, 0),
    };
  }

  private async handleStats(): Promise<DispatchResponse> {
    const submissions = await prisma.submission.findMany({
      select: { count: true, submittedAt: true },
    });

    return {
      type: ResponseType.STATS,
      distribution: buildDistribution(submissions),
      total: submissions.reduce((sum, s) => sum + s.count, 0),
    };
  }

  private async handleHelp(): Promise<DispatchResponse> {
    return { type: ResponseType.HELP, goal: await getGoal() };
  }

  private async handleAwlia(): Promise<DispatchResponse> {
    const users = await prisma.user.findMany({
      where: { submissions: { some: {} } },
      select: { name: true, phoneNumber: true },
    });

    return { type: ResponseType.AWLIA, users: shuffle(users) };
  }

  private async handleUpdateGoal(goal: number): Promise<DispatchResponse> {
    await prisma.setting.upsert({
      where: { id: SETTINGS_ID },
      update: { goal },
      create: { id: SETTINGS_ID, goal },
    });

    return { type: ResponseType.UPDATE_GOAL, goal };
  }

  private async handleSubscribe(sender: MessageSender): Promise<DispatchResponse> {
    const user = await this.findOrCreateUser(sender);
    await prisma.user.update({ where: { id: user.id }, data: { subscribed: true } });
    return { type: ResponseType.SUBSCRIBE };
  }

  private async handleUnsubscribe(sender: MessageSender): Promise<DispatchResponse> {
    const user = await this.findOrCreateUser(sender);
    await prisma.user.update({ where: { id: user.id }, data: { subscribed: false } });
    return { type: ResponseType.UNSUBSCRIBE };
  }

  async buildWeeklyDigests(): Promise<WeeklyDigestResponse[]> {
    const sevenDaysAgo = new Date(Date.now() - WEEK_MS);

    const users = await prisma.user.findMany({
      where: {
        subscribed: true,
        // Without a real chatId there's no valid JID to DM - phoneNumber
        // alone isn't reliably reconstructible into one (see schema.prisma).
        chatId: { not: null },
        OR: [{ lastDigestSentAt: null }, { lastDigestSentAt: { lt: sevenDaysAgo } }],
        submissions: { some: { submittedAt: { gte: sevenDaysAgo } } },
      },
      include: {
        submissions: { where: { submittedAt: { gte: sevenDaysAgo } }, select: { count: true, submittedAt: true } },
      },
    });

    return users.map((user) => ({
      type: ResponseType.WEEKLY_DIGEST,
      user: { id: user.id, name: user.name, phoneNumber: user.phoneNumber },
      chatId: user.chatId as string, // filtered to non-null above
      total: user.submissions.reduce((sum, s) => sum + s.count, 0),
      distribution: buildDistribution(user.submissions),
    }));
  }

  async markWeeklyDigestSent(userId: number): Promise<void> {
    await prisma.user.update({ where: { id: userId }, data: { lastDigestSentAt: new Date() } });
  }

  async handleGroupJoin(sender: MessageSender): Promise<DispatchResponse> {
    // Look up only - never create a User here. A bare join carries no pushName
    // (Baileys' group-participants.update gives JIDs, not display names), so
    // this can only recover a name from someone who has interacted before;
    // otherwise the Presenter falls back to a generic greeting.
    const phoneNumber = resolvePhoneNumber(sender);
    const existing = await prisma.user.findUnique({ where: { phoneNumber } });

    return {
      type: ResponseType.WELCOME,
      name: existing?.name ?? sender.name,
      total: await getTotal(),
      goal: await getGoal(),
    };
  }
}

const dispatcher = new Dispatcher();
export default dispatcher;
