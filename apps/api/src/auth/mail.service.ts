import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
  ServiceUnavailableException,
} from "@nestjs/common";
import nodemailer from "nodemailer";
import type { PoolClient } from "pg";
import { loadConfig } from "../config.js";
import { DatabaseService } from "../database/database.service.js";
import { decryptMailToken, encryptMailToken } from "./mail-crypto.js";

type MailKind = "verify" | "reset";
type OutboxRow = {
  id: string;
  recipient: string;
  kind: MailKind;
  encrypted_token: string;
  initialization_vector: string;
  authentication_tag: string;
  attempts: number;
};
const smtpTimeouts = {
  connectionTimeout: 30_000,
  greetingTimeout: 30_000,
  socketTimeout: 120_000,
  dnsTimeout: 30_000,
} as const;

@Injectable()
export class MailService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly config = loadConfig();
  private timer?: ReturnType<typeof setInterval>;
  private drainInFlight?: Promise<void>;
  private lastCleanupAt = 0;

  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  onApplicationBootstrap() {
    if (!this.config.isProduction) return;
    this.timer = setInterval(() => this.scheduleDrain(), 2_000);
    this.timer.unref();
    this.scheduleDrain();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.drainInFlight;
  }

  get usesDurableOutbox() {
    return this.config.isProduction;
  }

  async dispatchLink(to: string, kind: MailKind, token: string, client?: PoolClient) {
    if (!this.config.isProduction) return this.sendLink(to, kind, token);
    const encrypted = encryptMailToken(this.encryptionKey(), token, mailContext(kind, to));
    const query = `INSERT INTO auth_email_outbox(
      recipient, kind, encrypted_token, initialization_vector, authentication_tag
    ) VALUES ($1, $2, $3, $4, $5)`;
    const values = [to, kind, encrypted.ciphertext,
      encrypted.initializationVector, encrypted.authenticationTag];
    if (client) await client.query(query, values);
    else await this.db.query(
      query,
      values,
    );
    this.scheduleDrain();
    return undefined;
  }

  private scheduleDrain() {
    if (this.drainInFlight) return;
    this.drainInFlight = this.drainOutbox()
      .catch((error: unknown) => this.logFailure("outbox", error))
      .finally(() => { this.drainInFlight = undefined; });
  }

  private async drainOutbox() {
    for (let delivered = 0; delivered < 10; delivered += 1) {
      const message = await this.claimNextMessage();
      if (!message) break;
      await this.deliverClaimedMessage(message);
    }
    await this.cleanupTerminalMessages();
  }

  private async claimNextMessage() {
    const result = await this.db.query<OutboxRow>(claimNextMessageQuery);
    return result.rows[0] ?? null;
  }

  private async deliverClaimedMessage(message: OutboxRow) {
    const stopLeaseRenewal = this.startLeaseRenewal(message);
    try {
      const token = decryptMailToken(this.encryptionKey(), {
        ciphertext: message.encrypted_token,
        initializationVector: message.initialization_vector,
        authenticationTag: message.authentication_tag,
      }, mailContext(message.kind, message.recipient));
      await this.sendLink(message.recipient, message.kind, token);
      await this.db.query(
        `UPDATE auth_email_outbox SET status = 'SENT', sent_at = now(),
           lease_until = NULL, encrypted_token = NULL,
           initialization_vector = NULL, authentication_tag = NULL
         WHERE id = $1 AND status = 'PROCESSING' AND attempts = $2`,
        [message.id, message.attempts],
      );
    } catch (error) {
      await this.recordFailure(message, error);
    } finally {
      stopLeaseRenewal();
    }
  }

  private startLeaseRenewal(message: OutboxRow) {
    const timer = setInterval(() => {
      void this.renewLease(message).catch((error: unknown) => this.logFailure("lease", error));
    }, 60_000);
    timer.unref();
    return () => clearInterval(timer);
  }

  private async renewLease(message: OutboxRow) {
    await this.db.query(
      `UPDATE auth_email_outbox SET lease_until = now() + interval '5 minutes'
       WHERE id = $1 AND status = 'PROCESSING' AND attempts = $2`,
      [message.id, message.attempts],
    );
  }

  private async recordFailure(message: OutboxRow, error: unknown) {
    const reason = error instanceof Error ? error.message : "Unknown delivery failure";
    const retrySeconds = Math.min(300, 5 * (2 ** message.attempts));
    await this.db.query(
      `UPDATE auth_email_outbox SET
         status = CASE WHEN attempts >= 5 THEN 'FAILED' ELSE 'PENDING' END,
         available_at = now() + ($2 * interval '1 second'), lease_until = NULL,
         encrypted_token = CASE WHEN attempts >= 5 THEN NULL ELSE encrypted_token END,
         initialization_vector = CASE WHEN attempts >= 5 THEN NULL ELSE initialization_vector END,
         authentication_tag = CASE WHEN attempts >= 5 THEN NULL ELSE authentication_tag END,
         last_error = $3
       WHERE id = $1 AND status = 'PROCESSING' AND attempts = $4`,
      [message.id, retrySeconds, reason.slice(0, 500), message.attempts],
    );
    this.logFailure(message.kind, error);
  }

  private async cleanupTerminalMessages() {
    if (Date.now() - this.lastCleanupAt < 60 * 60 * 1000) return;
    await this.db.query(
      `DELETE FROM auth_email_outbox
       WHERE status IN ('SENT', 'FAILED')
         AND created_at < now() - interval '7 days'`,
    );
    this.lastCleanupAt = Date.now();
  }

  private async sendLink(to: string, kind: MailKind, token: string) {
    const url = this.linkUrl(kind, token);
    if (!this.config.smtp.host) {
      if (this.config.isProduction) {
        throw new ServiceUnavailableException("Email delivery is not configured.");
      }
      return url;
    }
    const transport = nodemailer.createTransport({
      host: this.config.smtp.host,
      port: this.config.smtp.port,
      secure: this.config.smtp.secure,
      ...smtpTimeouts,
      auth: this.config.smtp.user
        ? { user: this.config.smtp.user, pass: this.config.smtp.password }
        : undefined,
    });
    const label = kind === "verify" ? "Verify your email" : "Reset your password";
    await transport.sendMail({
      from: this.config.smtp.from,
      to,
      subject: `${label} · Authenti8`,
      text: `${label}: ${url}\n\nThis link expires soon. Ignore this email if you did not request it.`,
      html: `<p>${label} to continue with Authenti8.</p><p><a href="${url}">${label}</a></p><p>This link expires soon.</p>`,
    });
    return undefined;
  }

  private linkUrl(kind: MailKind, token: string) {
    const path = kind === "verify" ? "/verify-email" : "/reset-password";
    return `${this.config.appOrigin}${path}?token=${encodeURIComponent(token)}`;
  }

  private encryptionKey() {
    return Buffer.from(this.config.mailEncryptionKey, "base64");
  }

  private logFailure(kind: string, error: unknown) {
    const reason = error instanceof Error ? error.message : "Unknown delivery failure";
    console.error(`[mail] ${kind} delivery failed: ${reason}`);
  }
}

function mailContext(kind: MailKind, recipient: string) {
  return `${kind}:${recipient}`;
}

const claimNextMessageQuery = `
  WITH candidate AS (
    SELECT id FROM auth_email_outbox
    WHERE (status = 'PENDING' AND available_at <= now())
       OR (status = 'PROCESSING' AND lease_until <= now())
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE auth_email_outbox AS outbox
  SET status = 'PROCESSING', attempts = attempts + 1,
      lease_until = now() + interval '5 minutes'
  FROM candidate WHERE outbox.id = candidate.id
  RETURNING outbox.id, outbox.recipient, outbox.kind,
    outbox.encrypted_token, outbox.initialization_vector,
    outbox.authentication_tag, outbox.attempts`;
