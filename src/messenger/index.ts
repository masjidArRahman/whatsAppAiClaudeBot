import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';


import type { MessageUpsertType, WAMessage, WASocket } from '@whiskeysockets/baileys';
import type {
  Messenger,
  IncomingMessage,
  IncomingMessageHandler,
  OutgoingMessage,
  MessageSender,
} from './types.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });
const DATA_DIR = process.env.DATA_DIR || 'data';
const AUTH_DIR = `${DATA_DIR}/auth`;
/**
 * Concrete Messenger implementation backed by Baileys.
 * Translates Baileys' raw event/message shapes into the normalized
 * IncomingMessage / OutgoingMessage contract the rest of the app relies on.
 */
class BaileysMessenger implements Messenger {
  private socket: WASocket | null = null;
  private handlers: IncomingMessageHandler[] = [];
  private restrictedToGroupId: string | null = null;
 
  async connect(restrictedToGroupId: string | null): Promise<void> {
    this.restrictedToGroupId = restrictedToGroupId;
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    this.socket = makeWASocket({
        auth: state,
        logger,
        printQRInTerminal: false, // we handle QR display ourselves below
    });
    this.socket.ev.on('creds.update', saveCreds);

    this.socket.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
  
      if (qr) {
        console.log('\nScan this QR code with the bot\'s WhatsApp account:\n');
        qrcode.generate(qr, { small: true });
      }
  
      if (connection === 'close') {
        const error = lastDisconnect?.error as { output?: { statusCode?: number } } | undefined;
        const statusCode = error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log('Connection closed.', statusCode, 'Reconnecting:', shouldReconnect);
        if (shouldReconnect) this.connect(this.restrictedToGroupId);
      } else if (connection === 'open') {
        console.log('✅ Connected to WhatsApp.');
      }
    });
    this.socket.ev.on('messages.upsert', (upsert) => {
        // Helpful during setup: log every group message's chat ID so you can find yours.
        if (upsert.type !== 'notify') return;
        const msg = upsert.messages[0];
        if (!msg || !msg.message || msg.key.fromMe) return;
        const chatId = msg.key.remoteJid;
        if (!this.restrictedToGroupId) {
          console.log(`Message seen in group ${chatId}`);
        } else {
          this.handleUpsert(upsert);
        }
      }
    );
  }
 
  disconnect(): void {
    this.socket?.end(undefined);
  }
 
  addMessageHandler(handler: IncomingMessageHandler): void {
    this.handlers.push(handler);
  }
 
  async sendMessage(message: OutgoingMessage): Promise<void> {
    if (!this.socket) throw new Error('Messenger not connected');
    if (!this.restrictedToGroupId) throw new Error('Group Id not set');
    await this.socket.sendMessage(message.chatId, { text: message.text });
  }
 
  /** Called internally on Baileys' 'messages.upsert' event. */
  private async handleUpsert(upsert: {
    messages: WAMessage[];
    type: MessageUpsertType;
  }): Promise<void> {
    for (const raw of upsert.messages) {
      const normalized = this.normalize(raw);
      if (!normalized) continue;
      for (const handler of this.handlers) {
        await handler(normalized);
      }
    }
  }

  /** Maps a raw Baileys message into our IncomingMessage shape. */
  private normalize(raw: WAMessage): IncomingMessage | null {
    const chatId = raw.key.remoteJid;
    const messageId = raw.key.id;
    if (!chatId || !messageId) return null;

    const isGroup = chatId.endsWith('@g.us');
    if (this.restrictedToGroupId && chatId !== this.restrictedToGroupId) return null
    const senderId = isGroup ? raw.key.participant : chatId;
    if (!senderId) return null;

    const sender: MessageSender = {
      id: senderId,
      name: raw.pushName ?? null,
      phoneNumber: isGroup ? null : senderId.split('@')[0] ?? null,
    };

    const text: string =
      raw.message?.conversation ?? raw.message?.extendedTextMessage?.text ?? '';
    if (!text) return null;

    // Baileys gives Unix seconds (as a number or a Long); normalize to a Date.
    const seconds =
      typeof raw.messageTimestamp === 'number'
        ? raw.messageTimestamp
        : (raw.messageTimestamp?.toNumber() ?? 0);
    const timestamp = new Date(seconds * 1000);

    return {
      id: messageId,
      chatId,
      sender,
      text,
      timestamp,
      isGroup,
    };
  }
}

const messenger = new BaileysMessenger();
export default messenger;