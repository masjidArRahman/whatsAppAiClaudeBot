import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageSender } from '../messenger/types.js';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    submission: {
      create: vi.fn(),
      aggregate: vi.fn(),
      findMany: vi.fn(),
    },
    setting: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock('../db.js', () => ({ default: mockPrisma }));

import dispatcher from './index.js';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

const sender: MessageSender = { id: '123@s.whatsapp.net', name: 'Amina', phoneNumber: '123' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('salawat submissions', () => {
  it('creates a new user if none exists, records the submission, and returns the running total', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.user.create.mockResolvedValue({ id: 1, name: 'Amina', phoneNumber: '123' });
    mockPrisma.submission.aggregate.mockResolvedValue({ _sum: { count: 150 } });

    const response = await dispatcher.processCommand({ type: 'salawat', count: 50 }, sender);

    expect(mockPrisma.user.create).toHaveBeenCalledWith({
      data: { phoneNumber: '123', name: 'Amina', chatId: sender.id },
    });
    expect(mockPrisma.submission.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ count: 50, authorId: 1 }),
    });
    expect(response).toEqual({
      type: 'salawat',
      user: { id: 1, name: 'Amina', phoneNumber: '123' },
      count: 50,
      total: 150,
      goal: expect.any(Number),
      goalReached: false,
    });
    expect(mockPrisma.setting.updateMany).not.toHaveBeenCalled();
  });

  it('reuses an existing user instead of creating a new one', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 7, name: 'Amina', phoneNumber: '123' });
    mockPrisma.submission.aggregate.mockResolvedValue({ _sum: { count: 20 } });

    await dispatcher.processCommand({ type: 'salawat', count: 20 }, sender);

    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });

  it("self-heals a stale chatId on an existing user to the sender's current JID", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 7,
      name: 'Amina',
      phoneNumber: '123',
      chatId: 'old-jid@s.whatsapp.net',
    });
    mockPrisma.submission.aggregate.mockResolvedValue({ _sum: { count: 20 } });

    await dispatcher.processCommand({ type: 'salawat', count: 20 }, sender);

    expect(mockPrisma.user.update).toHaveBeenCalledWith({ where: { id: 7 }, data: { chatId: sender.id } });
  });

  it('does not write to the DB when the stored chatId already matches the sender', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 7, name: 'Amina', phoneNumber: '123', chatId: sender.id });
    mockPrisma.submission.aggregate.mockResolvedValue({ _sum: { count: 20 } });

    await dispatcher.processCommand({ type: 'salawat', count: 20 }, sender);

    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('derives the phone number from the JID when the sender has none directly (e.g. group messages)', async () => {
    const groupSender: MessageSender = { id: '999888777@s.whatsapp.net', name: 'X', phoneNumber: null };
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.user.create.mockResolvedValue({ id: 2, name: 'X', phoneNumber: '999888777' });
    mockPrisma.submission.aggregate.mockResolvedValue({ _sum: { count: 5 } });

    await dispatcher.processCommand({ type: 'salawat', count: 5 }, groupSender);

    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({ where: { phoneNumber: '999888777' } });
  });

  it('falls back to the submitted count as total when the DB has no aggregate sum yet', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 7, name: 'Amina', phoneNumber: '123' });
    mockPrisma.submission.aggregate.mockResolvedValue({ _sum: { count: null } });

    const response = await dispatcher.processCommand({ type: 'salawat', count: 20 }, sender);

    expect(response).toMatchObject({ total: 20 });
  });
});

describe('/me', () => {
  it('returns the sender submission history and total', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 7, name: 'Amina', phoneNumber: '123' });
    const submissions = [
      { count: 10, submittedAt: new Date(2026, 0, 1) },
      { count: 5, submittedAt: new Date(2026, 0, 2) },
    ];
    mockPrisma.submission.findMany.mockResolvedValue(submissions);

    const response = await dispatcher.processCommand({ type: 'me' }, sender);

    expect(response).toEqual({
      type: 'me',
      user: { id: 7, name: 'Amina', phoneNumber: '123' },
      submissions,
      total: 15,
    });
  });
});

describe('/stats', () => {
  it('buckets submissions by weekday, summed across all history, in Monday-first order', async () => {
    const dayA = new Date(2026, 8, 7);
    const dayASameDayLater = new Date(dayA.getFullYear(), dayA.getMonth(), dayA.getDate(), 18, 0);
    const dayB = new Date(dayA.getFullYear(), dayA.getMonth(), dayA.getDate() + 2);

    mockPrisma.submission.findMany.mockResolvedValue([
      { count: 10, submittedAt: dayA },
      { count: 5, submittedAt: dayASameDayLater },
      { count: 3, submittedAt: dayB },
    ]);

    const response = await dispatcher.processCommand({ type: 'stats' }, sender);
    if (response.type !== 'stats') throw new Error('expected a stats response');

    expect(response.total).toBe(18);
    expect(response.distribution.map((d) => d.day)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);

    const dayALabel = DAY_LABELS[dayA.getDay()]!;
    const dayBLabel = DAY_LABELS[dayB.getDay()]!;
    const byDay = Object.fromEntries(response.distribution.map((d) => [d.day, d.count]));

    expect(byDay[dayALabel]).toBe(15);
    expect(byDay[dayBLabel]).toBe(3);
    const remaining = response.distribution.filter((d) => d.day !== dayALabel && d.day !== dayBLabel);
    expect(remaining.every((d) => d.count === 0)).toBe(true);
  });

  it('returns a zeroed distribution when there are no submissions', async () => {
    mockPrisma.submission.findMany.mockResolvedValue([]);

    const response = await dispatcher.processCommand({ type: 'stats' }, sender);
    if (response.type !== 'stats') throw new Error('expected a stats response');

    expect(response.total).toBe(0);
    expect(response.distribution).toHaveLength(7);
    expect(response.distribution.every((d) => d.count === 0)).toBe(true);
  });
});

describe('/help', () => {
  it('returns the configured goal without touching the DB', async () => {
    const response = await dispatcher.processCommand({ type: 'help' }, sender);

    expect(response.type).toBe('help');
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.submission.findMany).not.toHaveBeenCalled();
  });
});

describe('/awlia', () => {
  it('returns everyone who has submitted at least once', async () => {
    const users = [
      { name: 'Amina', phoneNumber: '111' },
      { name: null, phoneNumber: '222' },
      { name: 'Yusuf', phoneNumber: '333' },
    ];
    mockPrisma.user.findMany.mockResolvedValue(users);

    const response = await dispatcher.processCommand({ type: 'awlia' }, sender);
    if (response.type !== 'awlia') throw new Error('expected an awlia response');

    expect(mockPrisma.user.findMany).toHaveBeenCalledWith({
      where: { submissions: { some: {} } },
      select: { name: true, phoneNumber: true },
    });
    expect(response.users).toHaveLength(users.length);
    expect(response.users).toEqual(expect.arrayContaining(users));
  });

  it('returns an empty list when nobody has submitted yet', async () => {
    mockPrisma.user.findMany.mockResolvedValue([]);

    const response = await dispatcher.processCommand({ type: 'awlia' }, sender);
    if (response.type !== 'awlia') throw new Error('expected an awlia response');

    expect(response.users).toEqual([]);
  });

  it('shuffles the roster instead of returning it in DB order', async () => {
    const users = [
      { name: 'A', phoneNumber: '1' },
      { name: 'B', phoneNumber: '2' },
      { name: 'C', phoneNumber: '3' },
    ];
    mockPrisma.user.findMany.mockResolvedValue(users);
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

    try {
      const response = await dispatcher.processCommand({ type: 'awlia' }, sender);
      if (response.type !== 'awlia') throw new Error('expected an awlia response');

      // With Math.random pinned to 0, Fisher-Yates on [A,B,C] deterministically yields [B,C,A].
      expect(response.users).toEqual([users[1], users[2], users[0]]);
    } finally {
      randomSpy.mockRestore();
    }
  });
});

describe('/update-goal (hidden command)', () => {
  it('persists the new goal and confirms it', async () => {
    const response = await dispatcher.processCommand({ type: 'update-goal', goal: 250000 }, sender);

    expect(mockPrisma.setting.upsert).toHaveBeenCalledWith({
      where: { id: 1 },
      update: { goal: 250000 },
      create: { id: 1, goal: 250000 },
    });
    expect(response).toEqual({ type: 'update-goal', goal: 250000 });
  });
});

describe('shared goal lookup', () => {
  it('falls back to the default goal when no setting row exists yet', async () => {
    mockPrisma.setting.findUnique.mockResolvedValue(null);

    const response = await dispatcher.processCommand({ type: 'help' }, sender);
    if (response.type !== 'help') throw new Error('expected a help response');

    expect(response.goal).toBe(100000);
  });

  it('uses the persisted goal once one has been set via /update-goal', async () => {
    mockPrisma.setting.findUnique.mockResolvedValue({ id: 1, goal: 250000 });

    const response = await dispatcher.processCommand({ type: 'help' }, sender);
    if (response.type !== 'help') throw new Error('expected a help response');

    expect(response.goal).toBe(250000);
  });
});

describe('/subscribe and /unsubscribe', () => {
  it('subscribes an existing user', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 7, name: 'Amina', phoneNumber: '123' });

    const response = await dispatcher.processCommand({ type: 'subscribe' }, sender);

    expect(mockPrisma.user.update).toHaveBeenCalledWith({ where: { id: 7 }, data: { subscribed: true } });
    expect(response).toEqual({ type: 'subscribe' });
  });

  it('creates the user first if they have never submitted before subscribing', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.user.create.mockResolvedValue({ id: 8, name: 'Amina', phoneNumber: '123' });

    await dispatcher.processCommand({ type: 'subscribe' }, sender);

    expect(mockPrisma.user.create).toHaveBeenCalledWith({
      data: { phoneNumber: '123', name: 'Amina', chatId: sender.id },
    });
    expect(mockPrisma.user.update).toHaveBeenCalledWith({ where: { id: 8 }, data: { subscribed: true } });
  });

  it('unsubscribes an existing user', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 7, name: 'Amina', phoneNumber: '123' });

    const response = await dispatcher.processCommand({ type: 'unsubscribe' }, sender);

    expect(mockPrisma.user.update).toHaveBeenCalledWith({ where: { id: 7 }, data: { subscribed: false } });
    expect(response).toEqual({ type: 'unsubscribe' });
  });
});

describe('weekly digest', () => {
  it('queries only subscribed users with submissions in the last 7 days who have not just been sent one', async () => {
    mockPrisma.user.findMany.mockResolvedValue([]);

    await dispatcher.buildWeeklyDigests();

    expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          subscribed: true,
          chatId: { not: null },
          OR: [{ lastDigestSentAt: null }, { lastDigestSentAt: { lt: expect.any(Date) } }],
          submissions: { some: { submittedAt: { gte: expect.any(Date) } } },
        }),
      }),
    );
  });

  it('builds one response per user with their own total, day-of-week distribution, and chatId to DM', async () => {
    const dayA = new Date(2026, 8, 7); // Monday
    const dayB = new Date(dayA.getFullYear(), dayA.getMonth(), dayA.getDate() + 1); // Tuesday

    mockPrisma.user.findMany.mockResolvedValue([
      {
        id: 1,
        name: 'Amina',
        phoneNumber: '123',
        chatId: '123@s.whatsapp.net',
        submissions: [
          { count: 10, submittedAt: dayA },
          { count: 5, submittedAt: dayB },
        ],
      },
    ]);

    const digests = await dispatcher.buildWeeklyDigests();

    expect(digests).toHaveLength(1);
    expect(digests[0]).toMatchObject({
      type: 'weekly-digest',
      user: { id: 1, name: 'Amina', phoneNumber: '123' },
      chatId: '123@s.whatsapp.net',
      total: 15,
    });
    const byDay = Object.fromEntries(digests[0]!.distribution.map((d) => [d.day, d.count]));
    expect(byDay['Mon']).toBe(10);
    expect(byDay['Tue']).toBe(5);
  });

  it('marks a user as digested by stamping lastDigestSentAt', async () => {
    await dispatcher.markWeeklyDigestSent(3);

    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 3 },
      data: { lastDigestSentAt: expect.any(Date) },
    });
  });
});

describe('group join (welcome)', () => {
  const joiner: MessageSender = { id: '444555666@s.whatsapp.net', name: null, phoneNumber: '444555666' };

  it("uses the joiner's name from an existing user record, without creating one", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 9, name: 'Bilal', phoneNumber: '444555666' });
    mockPrisma.submission.aggregate.mockResolvedValue({ _sum: { count: 42 } });
    mockPrisma.setting.findUnique.mockResolvedValue({ id: 1, goal: 250000 });

    const response = await dispatcher.handleGroupJoin(joiner);

    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({ where: { phoneNumber: '444555666' } });
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
    expect(response).toEqual({ type: 'welcome', name: 'Bilal', total: 42, goal: 250000 });
  });

  it('falls back to a generic (null) name when no user record exists yet', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.submission.aggregate.mockResolvedValue({ _sum: { count: 0 } });
    mockPrisma.setting.findUnique.mockResolvedValue(null);

    const response = await dispatcher.handleGroupJoin(joiner);

    expect(response).toEqual({ type: 'welcome', name: null, total: 0, goal: 100000 });
  });

  it('reports 0 as the total when no submissions have ever been recorded', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.submission.aggregate.mockResolvedValue({ _sum: { count: null } });

    const response = await dispatcher.handleGroupJoin(joiner);
    if (response.type !== 'welcome') throw new Error('expected a welcome response');

    expect(response.total).toBe(0);
  });
});

describe('goal reached', () => {
  beforeEach(() => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 7, name: 'Amina', phoneNumber: '123', chatId: sender.id });
    mockPrisma.setting.findUnique.mockResolvedValue({ id: 1, goal: 1000, celebratedGoal: null });
  });

  it('flags goalReached for the submission that reaches the goal, claiming it atomically for that goal value', async () => {
    mockPrisma.submission.aggregate.mockResolvedValue({ _sum: { count: 1020 } });
    mockPrisma.setting.updateMany.mockResolvedValue({ count: 1 });

    const response = await dispatcher.processCommand({ type: 'salawat', count: 50 }, sender);

    expect(response).toMatchObject({ type: 'salawat', total: 1020, goal: 1000, goalReached: true });
    expect(mockPrisma.setting.upsert).toHaveBeenCalledWith({
      where: { id: 1 },
      update: {},
      create: { id: 1, goal: 1000 },
    });
    expect(mockPrisma.setting.updateMany).toHaveBeenCalledWith({
      where: { id: 1, OR: [{ celebratedGoal: null }, { celebratedGoal: { not: 1000 } }] },
      data: { celebratedGoal: 1000 },
    });
  });

  it('does not flag goalReached again once this goal has already been celebrated', async () => {
    mockPrisma.submission.aggregate.mockResolvedValue({ _sum: { count: 1100 } });
    mockPrisma.setting.updateMany.mockResolvedValue({ count: 0 });

    const response = await dispatcher.processCommand({ type: 'salawat', count: 50 }, sender);

    expect(response).toMatchObject({ type: 'salawat', goalReached: false });
  });

  it('does not try to claim the celebration while still below the goal', async () => {
    mockPrisma.submission.aggregate.mockResolvedValue({ _sum: { count: 999 } });

    const response = await dispatcher.processCommand({ type: 'salawat', count: 50 }, sender);

    expect(response).toMatchObject({ type: 'salawat', goalReached: false });
    expect(mockPrisma.setting.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.setting.updateMany).not.toHaveBeenCalled();
  });

  it('builds the congratulations response with the number of distinct participants', async () => {
    mockPrisma.user.count.mockResolvedValue(37);

    const response = await dispatcher.buildGoalReached(1020, 1000);

    expect(mockPrisma.user.count).toHaveBeenCalledWith({ where: { submissions: { some: {} } } });
    expect(response).toEqual({ type: 'goal-reached', total: 1020, goal: 1000, participants: 37 });
  });
});
