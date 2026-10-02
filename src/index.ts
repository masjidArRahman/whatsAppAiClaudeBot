import 'dotenv/config';
import { ResponseType } from './constants.js';
import messenger from './messenger/index.js';
import interpreter from './interpreter/index.js';
import dispatcher from './dispatcher/index.js';
import presenter from './presenter/index.js';
import internalListener from './internalListener/index.js';

const GROUP_ID = process.env.GROUP_ID || null; // e.g. "1234567890-1234567890@g.us"
const SEND_DELAY_MS = parseInt(process.env.SEND_DELAY_MS || '1500', 10);
// Much longer than SEND_DELAY_MS deliberately: these are individual DMs to
// many different people in a row, which reads as spammy/bot-like to
// WhatsApp's abuse detection at a fast pace. A tight loop here is what
// preceded the account getting logged out on 2026-09-18.
const DIGEST_SEND_DELAY_MS = parseInt(process.env.DIGEST_SEND_DELAY_MS || '60000', 10);
const INTERNAL_PORT = parseInt(process.env.INTERNAL_PORT || '8080', 10);
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || null;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function start() {
  await messenger.connect(GROUP_ID);
  messenger.addMessageHandler(async (incoming) => {
    const { text, chatId, sender } = incoming;
    
    const command = await interpreter.processMessage(text);
    if (!command) return;
    const response = await dispatcher.processCommand(command, sender);
    const reply = await presenter.processResponse(response);

    // /me is personal submission history - send it to the sender privately
    // instead of posting it in the group.
    const target = response.type === ResponseType.ME ? sender.id : chatId;

    await messenger.sendMessage({
      text: reply,
      chatId: target
    })

    // The submission that first reaches the goal also triggers a one-off
    // congratulations message to the whole group, right after its own reply.
    if (response.type === ResponseType.SALAWAT && response.goalReached) {
      await sleep(SEND_DELAY_MS);
      const celebration = await dispatcher.buildGoalReached(response.total, response.goal);
      await messenger.sendMessage({ text: await presenter.processResponse(celebration), chatId });
    }
  })

  // Greet each new member with a personal welcome (name + current progress),
  // then send the /help message once for the whole batch of joiners.
  messenger.addGroupJoinHandler(async (groupId, participantIds) => {
    if (participantIds.length === 0) return;

    for (const participantId of participantIds) {
      const sender = { id: participantId, name: null, phoneNumber: participantId.split('@')[0] ?? participantId };

      const welcomeResponse = await dispatcher.handleGroupJoin(sender);
      const welcomeText = await presenter.processResponse(welcomeResponse);
      await messenger.sendMessage({ text: welcomeText, chatId: groupId });

      await sleep(SEND_DELAY_MS);
    }

    // handleHelp() ignores the sender entirely, so any placeholder works here.
    const helpResponse = await dispatcher.processCommand(
      { type: ResponseType.HELP },
      { id: groupId, name: null, phoneNumber: null }
    );
    const helpText = await presenter.processResponse(helpResponse);
    await messenger.sendMessage({ text: helpText, chatId: groupId });
  })

  // Only started when INTERNAL_API_SECRET is set, so the endpoint fails
  // closed rather than accidentally running unauthenticated.
  internalListener.addWeeklyDigestHandler(sendWeeklyDigests);
  if (INTERNAL_API_SECRET) {
    await internalListener.listen(INTERNAL_PORT, INTERNAL_API_SECRET);
  } else {
    console.warn('INTERNAL_API_SECRET not set - the internal /weekly-digest endpoint is disabled.');
  }
}

/**
 * DMs every subscribed user with salawat in the last rolling 7 days their
 * personal count + distribution, then marks them sent so a re-trigger within
 * the week is a no-op for them. Triggered by the internal /weekly-digest
 * endpoint, which an external cron job calls on whatever schedule is set.
 */
async function sendWeeklyDigests(): Promise<{ sent: number }> {
  const digests = await dispatcher.buildWeeklyDigests();
  let sent = 0;

  for (const digest of digests) {
    const text = await presenter.processResponse(digest);
    await messenger.sendMessage({ text, chatId: digest.chatId });
    await dispatcher.markWeeklyDigestSent(digest.user.id);
    sent++;
    await sleep(DIGEST_SEND_DELAY_MS);
  }

  console.log(`Weekly digest: sent to ${sent} user(s).`);
  return { sent };
}


start().catch((err) => {
  console.error('Fatal error starting bot:', err);
  process.exit(1);
});
