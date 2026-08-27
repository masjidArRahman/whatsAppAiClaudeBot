import 'dotenv/config';
import messenger from './messenger/index.js';
import interpreter from './interpreter/index.js';
import dispatcher from './dispatcher/index.js';
import presenter from './presenter/index.js';

const GROUP_ID = process.env.GROUP_ID || null; // e.g. "1234567890-1234567890@g.us"
const GOAL = parseInt(process.env.SALAWAT_GOAL || '100000', 10);
const SEND_DELAY_MS = parseInt(process.env.SEND_DELAY_MS || '1500', 10);


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
    const target = response.type === 'me' ? sender.id : chatId;

    messenger.sendMessage({
      text: reply,
      chatId: target
    })
  })
}


start().catch((err) => {
  console.error('Fatal error starting bot:', err);
  process.exit(1);
});
