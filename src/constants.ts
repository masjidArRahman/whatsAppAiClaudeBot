/**
 * Discriminant values for Command and DispatchResponse `type` fields - the
 * single source of truth so these tags don't drift between the interpreter,
 * dispatcher, and presenter as string literals scattered across each.
 */
export const ResponseType = {
  SALAWAT: 'salawat',
  STATS: 'stats',
  ME: 'me',
  HELP: 'help',
  AWLIA: 'awlia',
  UPDATE_GOAL: 'update-goal',
  SUBSCRIBE: 'subscribe',
  UNSUBSCRIBE: 'unsubscribe',
  WELCOME: 'welcome',
  WEEKLY_DIGEST: 'weekly-digest',
  GOAL_REACHED: 'goal-reached',
} as const;

export type ResponseType = (typeof ResponseType)[keyof typeof ResponseType];
