// Outgoing email behind an interface (DESIGN.md, "Overdue reminders"). Tally ships no real email provider: the
// worker's default writes each message to stdout as one JSON line, and tests use MemoryMailer. A real provider (one
// that accepts an idempotency key, so a resend after a crash is dropped) would implement the same interface.

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** Stable per logical message (the reminder's id): a provider that honours it sends a retried message once. */
  idempotencyKey: string;
}

export interface Mailer {
  /** Resolves once the provider accepted the message; rejects if it didn't (the caller retries later). */
  send(message: MailMessage): Promise<void>;
}

/** Keeps every message; `failWith` makes the next sends reject, for failure tests. */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  failWith: ((message: MailMessage) => Error | null) | null = null;
  /** Called before a send resolves, so tests can hold a send open. */
  beforeAccept: ((message: MailMessage) => Promise<void>) | null = null;

  async send(message: MailMessage): Promise<void> {
    const error = this.failWith?.(message);
    if (error) throw error;
    await this.beforeAccept?.(message);
    this.sent.push(message);
  }
}

/** The worker's default: one JSON line per message on stdout, nothing sent anywhere. */
export class ConsoleMailer implements Mailer {
  async send(message: MailMessage): Promise<void> {
    process.stdout.write(`${JSON.stringify({ mail: message })}\n`);
  }
}
