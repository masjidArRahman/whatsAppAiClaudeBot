/**
 * Public contract for the Interpreter module.
 */

/** A submission of a salawat count, extracted from free-form text. */
export type SalawatCommand = { type: 'salawat'; count: number };

/** Request for the group's weekly distribution stats (ascii graph). */
export type StatsCommand = { type: 'stats' };

/** Request for a private message listing the sender's own submissions. */
export type MeCommand = { type: 'me' };

export type Command = SalawatCommand | StatsCommand | MeCommand;

export interface InterpreterInterface {
  /** Extract a salawat count from a message, if present. */
  extractSalawatCount(text: string): Promise<number | null>;
  /** Detect the sender's intent (salawat submission, /stats, /me) from an incoming message. */
  processMessage(message: string): Promise<Command | null>;
}
