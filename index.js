import 'dotenv/config';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { extractSalawatCount, generateUpdateMessage, GOAL_REACHED_MESSAGE } from './claude.js';
import { addToTotal, loadState } from './store.js';

const DATA_DIR = process.env.DATA_DIR || './data';
const AUTH_DIR = `${DATA_DIR}/auth`;
const GROUP_ID = process.env.GROUP_ID || null; // e.g. "1234567890-1234567890@g.us"
const GOAL = parseInt(process.env.SALAWAT_GOAL || '100000', 10);
const SEND_DELAY_MS = parseInt(process.env.SEND_DELAY_MS || '1500', 10);

const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false, // we handle QR display ourselves below
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\nScan this QR code with the bot\'s WhatsApp account:\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed.', statusCode, 'Reconnecting:', shouldReconnect);
      if (shouldReconnect) start();
    } else if (connection === 'open') {
      console.log('✅ Connected to WhatsApp.');
      const current = loadState();
      console.log(`Current total: ${current.total} / ${GOAL} salawat`);
      if (!GROUP_ID) {
        console.log('⚠️  GROUP_ID is not set. Send any message in your group and watch the logs below for its ID, then set GROUP_ID and redeploy.');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const chatId = msg.key.remoteJid;
    const isGroup = chatId?.endsWith('@g.us');

    // Helpful during setup: log every group message's chat ID so you can find yours.
    if (isGroup && !GROUP_ID) {
      console.log(`Message seen in group ${chatId}`);
    }

    if (!isGroup || (GROUP_ID && chatId !== GROUP_ID)) return;

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      '';
    if (!text) return;

    const count = await extractSalawatCount(text);
    if (!count) return;

    const state = addToTotal(count);
    const senderName = msg.pushName || null;

    const replyText = await generateUpdateMessage({
      total: state.total,
      goal: GOAL,
      submittedBy: senderName,
      amount: count,
    });

    await new Promise((r) => setTimeout(r, SEND_DELAY_MS));
    await sock.sendMessage(chatId, { text: replyText });

    if (state.total >= GOAL) {
      await new Promise((r) => setTimeout(r, SEND_DELAY_MS));
      await sock.sendMessage(chatId, { text: GOAL_REACHED_MESSAGE(GOAL) });
    }
  });
}

start().catch((err) => {
  console.error('Fatal error starting bot:', err);
  process.exit(1);
});
