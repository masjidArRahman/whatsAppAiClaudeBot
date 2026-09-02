import prisma from '../db.js';
import type { Command } from '../interpreter/types.js';
import type { MessageSender } from '../messenger/types.js';
import type { DayCount, DispatcherInterface, DispatchResponse } from './types.js';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const GOAL = parseInt(process.env.SALAWAT_GOAL || '100000', 10);

function resolvePhoneNumber(sender: MessageSender): string {
  return sender.phoneNumber ?? sender.id.split('@')[0] ?? sender.id;
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

/** Monday 00:00 of the week containing `date`. */
function startOfWeek(date: Date): Date {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const dayOffset = (start.getDay() + 6) % 7; // Mon=0 ... Sun=6
  start.setDate(start.getDate() - dayOffset);
  return start;
}

function buildDistribution(weekStart: Date, submissions: { count: number; submittedAt: Date }[]): DayCount[] {
  const days: DayCount[] = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(weekStart, i);
    return { day: DAY_LABELS[date.getDay()] as DayCount['day'], date, count: 0 };
  });

  for (const submission of submissions) {
    const day = days.find((d) => isSameDay(d.date, submission.submittedAt));
    if (day) day.count += submission.count;
  }

  return days;
}

class Dispatcher implements DispatcherInterface {
  async processCommand(command: Command, sender: MessageSender): Promise<DispatchResponse> {
    switch (command.type) {
      case 'salawat':
        return this.handleSalawat(command.count, sender);
      case 'me':
        return this.handleMe(sender);
      case 'stats':
        return this.handleStats();
    }
  }

  private async findOrCreateUser(sender: MessageSender) {
    const phoneNumber = resolvePhoneNumber(sender);
    const existing = await prisma.user.findUnique({ where: { phoneNumber } });
    if (existing) return existing;
    return prisma.user.create({ data: { phoneNumber, name: sender.name } });
  }

  private async handleSalawat(count: number, sender: MessageSender): Promise<DispatchResponse> {
    const user = await this.findOrCreateUser(sender);
    await prisma.submission.create({
      data: { count, submittedAt: new Date(), authorId: user.id },
    });

    const { _sum } = await prisma.submission.aggregate({ _sum: { count: true } });

    return {
      type: 'salawat',
      user: { id: user.id, name: user.name, phoneNumber: user.phoneNumber },
      count,
      total: _sum.count ?? count,
      goal: GOAL,
    };
  }

  private async handleMe(sender: MessageSender): Promise<DispatchResponse> {
    const user = await this.findOrCreateUser(sender);
    const submissions = await prisma.submission.findMany({
      where: { authorId: user.id },
      orderBy: { submittedAt: 'desc' },
      select: { count: true, submittedAt: true },
    });

    return {
      type: 'me',
      user: { id: user.id, name: user.name, phoneNumber: user.phoneNumber },
      submissions,
      total: submissions.reduce((sum, s) => sum + s.count, 0),
    };
  }

  private async handleStats(): Promise<DispatchResponse> {
    const currentWeekStart = startOfWeek(new Date());
    const pastWeekStart = addDays(currentWeekStart, -7);

    const pastWeekSubmissions = await prisma.submission.findMany({
      where: { submittedAt: { gte: pastWeekStart, lt: currentWeekStart } },
      select: { count: true, submittedAt: true },
    });

    const isCurrentWeek = pastWeekSubmissions.length === 0;
    const weekStart = isCurrentWeek ? currentWeekStart : pastWeekStart;
    const weekEnd = isCurrentWeek ? addDays(currentWeekStart, 7) : currentWeekStart;

    const submissions = isCurrentWeek
      ? await prisma.submission.findMany({
          where: { submittedAt: { gte: currentWeekStart, lt: weekEnd } },
          select: { count: true, submittedAt: true },
        })
      : pastWeekSubmissions;

    return {
      type: 'stats',
      weekStart,
      weekEnd,
      isCurrentWeek,
      distribution: buildDistribution(weekStart, submissions),
      total: submissions.reduce((sum, s) => sum + s.count, 0),
    };
  }
}

const dispatcher = new Dispatcher();
export default dispatcher;
