/** Who sent a message, captured at receipt time. */
export interface MessageSender {
  /** WhatsApp JID, e.g. "1234567890@s.whatsapp.net" or a group JID. */
  id: string;
  /** Display name / push name, if WhatsApp provided one. Not always present. */
  name: string | null;
  /** Raw phone number extracted from the JID, when it's a direct (non-group) chat. */
  phoneNumber: string | null;
}
 
/** A normalized incoming message, decoupled from Baileys' internal shape. */
export interface IncomingMessage {
  /** Unique WhatsApp message ID, useful for dedup/idempotency. */
  id: string;
  /** The chat this arrived in (could be a group JID or a 1:1 JID). */
  chatId: string;
  /** Who sent it. */
  sender: MessageSender;
  /** Plain text content. Empty string if the message had no text (e.g. media-only). */
  text: string;
  /** When WhatsApp says the message was sent, not when we processed it. */
  timestamp: Date;
  /** True if this message came from a group chat rather than a direct message. */
  isGroup: boolean;
}
 
/** What the Messenger needs to send a reply. */
export interface OutgoingMessage {
  /** Chat to send to — normally the chatId of the IncomingMessage being replied to. */
  chatId: string;
  /** Formatted, display-ready text (already produced by the Presenter). */
  text: string;
  /** Optional: quote/reply to a specific message ID in the chat. */
  replyToMessageId?: string;
}
 
/** Handler signature the Messenger invokes for every normalized incoming message. */
export type IncomingMessageHandler = (message: IncomingMessage) => void | Promise<void>;
 
/**
 * Public contract for the Messenger module.
 * Concrete implementation (e.g. BaileysMessenger) wraps the actual WhatsApp client.
 */
export interface Messenger {
  /** Establish the WhatsApp connection (auth, socket, reconnection handling). */
  connect(restrictedToGroupId: string): Promise<void>;
 
  /** Gracefully tear down the connection. */
  disconnect(): void;
 
  /**
   * Register a callback invoked for every incoming message.
   * Only one handler is expected in practice (wired to the Interpreter),
   * but the signature allows multiple for testing/logging.
   */
  addMessageHandler(handler: IncomingMessageHandler): void;
 
  /** Send a formatted message out to WhatsApp. */
  sendMessage(message: OutgoingMessage): Promise<void>;
}