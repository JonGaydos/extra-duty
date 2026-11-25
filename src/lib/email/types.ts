export type OutgoingEmail = {
  to: string[];
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
  attachments?: Array<{ filename: string; content: Buffer; contentType: string }>;
  /** A sign-in email (code, invite or password reset). Only these may leave staging, to STAGING_EMAIL_ALLOWLIST. */
  auth?: true;
};

export interface EmailSender {
  send(msg: OutgoingEmail): Promise<void>;
}

export type MemorySender = EmailSender & { readonly sent: OutgoingEmail[]; clear(): void };

/** Keeps every message in memory. For tests. */
export function createMemorySender(): MemorySender {
  const sent: OutgoingEmail[] = [];
  return {
    sent,
    async send(msg) {
      sent.push(msg);
    },
    clear() {
      sent.length = 0;
    },
  };
}
