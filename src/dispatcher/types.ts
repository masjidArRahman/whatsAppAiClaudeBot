import type { Command } from '../interpreter/types.js';
import type { MessageSender } from '../messenger/types.js';

/** Minimal user info the Presenter needs to address/attribute a response. */
export type DispatchedUser = {
  id: number;
  name: string | null;
  phoneNumber: string;
};

/** One day's aggregated count within a weekly distribution. */
export type DayCount = {
  day: 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';
  date: Date;
  count: number;
};

/** A salawat count was recorded for the sender. */
export type SalawatResponse = {
  type: 'salawat';
  user: DispatchedUser;
  count: number;
  /** Group-wide running total, summed from all submissions in the DB. */
  total: number;
  goal: number;
};

/** The sender's own submission history. */
export type MeResponse = {
  type: 'me';
  user: DispatchedUser;
  submissions: { count: number; submittedAt: Date }[];
  total: number;
};

/** The group's weekly submission distribution. */
export type StatsResponse = {
  type: 'stats';
  weekStart: Date;
  weekEnd: Date;
  /** False if the past (completed) week had no submissions and we fell back to the current, in-progress week. */
  isCurrentWeek: boolean;
  distribution: DayCount[];
  total: number;
};

/** Uniform response shape the Presenter switches on to pick a message format. */
export type DispatchResponse = SalawatResponse | MeResponse | StatsResponse;

/**
 * Public contract for the Dispatcher module.
 */
export interface DispatcherInterface {
  /** Execute an interpreted command on behalf of a sender, producing a uniform response for the Presenter. */
  processCommand(command: Command, sender: MessageSender): Promise<DispatchResponse>;
}
