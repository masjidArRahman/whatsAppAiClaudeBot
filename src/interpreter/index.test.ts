import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mockCreate };
  },
}));

import interpreter from './index.js';

function respondWith(json: object): void {
  mockCreate.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify(json) }] });
}

beforeEach(() => {
  mockCreate.mockReset();
});

describe('fast paths (no API call)', () => {
  it('detects /stats literally', async () => {
    await expect(interpreter.processMessage('/stats')).resolves.toEqual({ type: 'stats' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('detects /me literally', async () => {
    await expect(interpreter.processMessage('/me')).resolves.toEqual({ type: 'me' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('detects /help literally', async () => {
    await expect(interpreter.processMessage('/help')).resolves.toEqual({ type: 'help' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('detects /awlia literally', async () => {
    await expect(interpreter.processMessage('/awlia')).resolves.toEqual({ type: 'awlia' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('detects /subscribe literally', async () => {
    await expect(interpreter.processMessage('/subscribe')).resolves.toEqual({ type: 'subscribe' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('detects /unsubscribe literally', async () => {
    await expect(interpreter.processMessage('/unsubscribe')).resolves.toEqual({ type: 'unsubscribe' });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('detects /update-goal literally, without calling the API', async () => {
    await expect(interpreter.processMessage('/update-goal 200000')).resolves.toEqual({
      type: 'update-goal',
      goal: 200000,
      goalContext: null,
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('captures the rest of /update-goal as goal context, preserving its casing', async () => {
    await expect(interpreter.processMessage('/update-goal 200000 End of Ramadan')).resolves.toEqual({
      type: 'update-goal',
      goal: 200000,
      goalContext: 'End of Ramadan',
    });
  });

  it('strips surrounding quotes from the goal context', async () => {
    await expect(interpreter.processMessage('/update-goal 200000 "end of Ramadan"')).resolves.toEqual({
      type: 'update-goal',
      goal: 200000,
      goalContext: 'end of Ramadan',
    });
  });

  it('is case-insensitive for /update-goal', async () => {
    await expect(interpreter.processMessage('/UPDATE-GOAL 500')).resolves.toEqual({
      type: 'update-goal',
      goal: 500,
      goalContext: null,
    });
  });

  it('does not match the hidden command with a non-positive value, falling through to normal classification', async () => {
    respondWith({ intent: 'none', count: null });
    await expect(interpreter.processMessage('/update-goal 0')).resolves.toBeNull();
  });

  it('does not treat "/update-goal" as a natural-language hint for the classifier', async () => {
    // A malformed /update-goal (no number) contains no digit and no other
    // recognized keyword, so it should be skipped locally, never reaching Claude -
    // proof the hidden command isn't wired into the classifier's vocabulary.
    await expect(interpreter.processMessage('/update-goal please')).resolves.toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('is case-insensitive for slash commands', async () => {
    await expect(interpreter.processMessage('/STATS')).resolves.toEqual({ type: 'stats' });
  });

  it('extracts a bare number as a salawat count', async () => {
    await expect(interpreter.processMessage('50')).resolves.toEqual({ type: 'salawat', count: 50 });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('extracts a +prefixed number as a salawat count', async () => {
    await expect(interpreter.processMessage('+30')).resolves.toEqual({ type: 'salawat', count: 30 });
  });

  it('returns null for empty/whitespace input without calling the API', async () => {
    await expect(interpreter.processMessage('   ')).resolves.toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('skips the API call entirely for messages with no relevant hint', async () => {
    await expect(interpreter.processMessage('good morning everyone')).resolves.toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('per-submission limit', () => {
  it('accepts a bare count exactly at the limit', async () => {
    await expect(interpreter.processMessage('10000')).resolves.toEqual({ type: 'salawat', count: 10000 });
  });

  it('ignores a bare count above the limit', async () => {
    await expect(interpreter.processMessage('10001')).resolves.toBeNull();
  });

  it('ignores a Claude-extracted count above the limit', async () => {
    respondWith({ intent: 'salawat', count: 50000 });
    await expect(interpreter.processMessage('did 50000 salawat today')).resolves.toBeNull();
  });
});

describe('Claude-classified intents', () => {
  it('classifies natural-language stats requests', async () => {
    respondWith({ intent: 'stats', count: null });
    await expect(interpreter.processMessage("I'd like to see the statistics please")).resolves.toEqual({
      type: 'stats',
    });
  });

  it('classifies natural-language help requests', async () => {
    respondWith({ intent: 'help', count: null });
    await expect(interpreter.processMessage('what commands can I use here?')).resolves.toEqual({ type: 'help' });
  });

  it('classifies natural-language awlia requests', async () => {
    respondWith({ intent: 'awlia', count: null });
    await expect(interpreter.processMessage('who are all the participants so far?')).resolves.toEqual({
      type: 'awlia',
    });
  });

  it('classifies natural-language subscribe requests', async () => {
    respondWith({ intent: 'subscribe', count: null });
    await expect(interpreter.processMessage('please subscribe me to the weekly digest')).resolves.toEqual({
      type: 'subscribe',
    });
  });

  it('classifies natural-language unsubscribe requests', async () => {
    respondWith({ intent: 'unsubscribe', count: null });
    await expect(interpreter.processMessage('please unsubscribe me from the weekly messages')).resolves.toEqual({
      type: 'unsubscribe',
    });
  });

  it('classifies natural-language salawat submissions with a count', async () => {
    respondWith({ intent: 'salawat', count: 75 });
    await expect(interpreter.processMessage('sent 75 salawat today, alhamdulillah')).resolves.toEqual({
      type: 'salawat',
      count: 75,
    });
  });

  it('rejects a salawat intent with a non-positive count', async () => {
    respondWith({ intent: 'salawat', count: 0 });
    await expect(interpreter.processMessage('salawat count is zero')).resolves.toBeNull();
  });

  it('returns null for "none" intent', async () => {
    respondWith({ intent: 'none', count: null });
    await expect(interpreter.processMessage('salawat is a beautiful practice')).resolves.toBeNull();
  });

  it('strips markdown code fences from the model response', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: '```json\n{"intent":"stats","count":null}\n```' }],
    });
    await expect(interpreter.processMessage('show me the stats graph')).resolves.toEqual({ type: 'stats' });
  });

  it('falls back to regex extraction if the API call throws', async () => {
    mockCreate.mockRejectedValue(new Error('network error'));
    await expect(interpreter.processMessage('did 42 salawat today')).resolves.toEqual({
      type: 'salawat',
      count: 42,
    });
  });

  it('returns null if the API throws and the fallback regex finds nothing', async () => {
    mockCreate.mockRejectedValue(new Error('network error'));
    await expect(interpreter.processMessage('mashaAllah keep up the salawat')).resolves.toBeNull();
  });
});

describe('salawat vs. a routine/rule description (regression)', () => {
  // Real report: "Alhamdulillah, we are a group of ten people, each one
  // recites 500 salawat on the Prophet daily" was previously misread as a
  // live submission of 500. It's describing an ongoing group habit, not
  // reporting that a submission just happened - the classifier should say
  // "none", and processMessage should trust that verdict.
  it('does not treat a description of the group\'s daily habit as a submission', async () => {
    respondWith({ intent: 'none', count: null });
    const text = 'الحمدلله\nنحنُ مجموعةٌ من  عشرة أشخاص \nكلُّ واحدٍ يذكُرُ 500 صلاة على النّبي يومياً';

    await expect(interpreter.processMessage(text)).resolves.toBeNull();
  });

  it('still recognizes a genuine group completion report ("today we did X") as salawat', async () => {
    respondWith({ intent: 'salawat', count: 5000 });
    await expect(interpreter.processMessage('قمنا اليوم بـ 5000 صلاة كمجموعة، الحمدلله')).resolves.toEqual({
      type: 'salawat',
      count: 5000,
    });
  });

  it('still recognizes an explicit personal completion buried in descriptive text', async () => {
    respondWith({ intent: 'salawat', count: 500 });
    await expect(
      interpreter.processMessage('نحن مجموعة من عشرة، وأنا شخصياً صليت اليوم 500 صلاة'),
    ).resolves.toEqual({
      type: 'salawat',
      count: 500,
    });
  });
});
