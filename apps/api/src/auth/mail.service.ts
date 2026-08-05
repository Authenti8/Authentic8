import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
  ServiceUnavailableException,
} from "@nestjs/common";
import nodemailer from "nodemailer";
import { loadConfig } from "../config.js";
import { SupabaseService } from "../supabase/supabase.service.js";
import { decryptMailToken, encryptMailToken } from "./mail-crypto.js";

export type MailKind = "verify" | "reset";
export type OutboxPayload = {
  recipient: string; kind: MailKind; encryptedToken: string;
  initializationVector: string; authenticationTag: string;
};
type OutboxRow = OutboxPayload & { id: string; attempts: number };
const smtpTimeouts = {
  connectionTimeout: 5_000, greetingTimeout: 5_000,
  socketTimeout: 25_000, dnsTimeout: 5_000,
} as const;

@Injectable()
export class MailService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly config = loadConfig();
  private timer?: ReturnType<typeof setInterval>;
  private drainInFlight?: Promise<void>;
  private lastCleanupAt = 0;

  constructor(@Inject(SupabaseService) private readonly supabase: SupabaseService) {}

  onApplicationBootstrap() {
    if (!this.config.isProduction || this.isServerless) return;
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

  prepareOutbox(to: string, kind: MailKind, token: string): OutboxPayload {
    const encrypted = encryptMailToken(this.encryptionKey(), token, mailContext(kind, to));
    return {
      recipient: to, kind, encryptedToken: encrypted.ciphertext,
      initializationVector: encrypted.initializationVector,
      authenticationTag: encrypted.authenticationTag,
    };
  }

  async dispatchLink(to: string, kind: MailKind, token: string) {
    if (!this.config.isProduction) return this.sendLink(to, kind, token);
    await this.supabase.rpc("authenti8_enqueue_email", this.prepareOutbox(to, kind, token));
    return undefined;
  }

  async drainPending(limit = 10) {
    return this.drainOutbox(limit);
  }

  private scheduleDrain() {
    if (this.drainInFlight) return;
    this.drainInFlight = this.drainOutbox()
      .then(() => undefined)
      .catch((error: unknown) => this.logFailure("outbox", error))
      .finally(() => { this.drainInFlight = undefined; });
  }

  private async drainOutbox(limit = 10) {
    let processed = 0;
    for (let delivered = 0; delivered < limit; delivered += 1) {
      const message = await this.supabase.rpc<OutboxRow | null>("authenti8_claim_email");
      if (!message) break;
      await this.deliverClaimedMessage(message);
      processed += 1;
    }
    await this.cleanupTerminalMessages();
    return processed;
  }

  private async deliverClaimedMessage(message: OutboxRow) {
    const stopLeaseRenewal = this.startLeaseRenewal(message);
    try {
      const token = decryptMailToken(this.encryptionKey(), {
        ciphertext: message.encryptedToken,
        initializationVector: message.initializationVector,
        authenticationTag: message.authenticationTag,
      }, mailContext(message.kind, message.recipient));
      await this.sendLink(message.recipient, message.kind, token);
      await this.supabase.rpc("authenti8_complete_email", claimInput(message));
    } catch (error) {
      await this.recordFailure(message, error);
    } finally {
      stopLeaseRenewal();
    }
  }

  private startLeaseRenewal(message: OutboxRow) {
    const timer = setInterval(() => {
      void this.supabase.rpc("authenti8_renew_email", claimInput(message))
        .catch((error: unknown) => this.logFailure("lease", error));
    }, 60_000);
    timer.unref();
    return () => clearInterval(timer);
  }

  private async recordFailure(message: OutboxRow, error: unknown) {
    const reason = error instanceof Error ? error.message : "Unknown delivery failure";
    await this.supabase.rpc("authenti8_fail_email", {
      ...claimInput(message), error: reason.slice(0, 500),
    });
    this.logFailure(message.kind, error);
  }

  private async cleanupTerminalMessages() {
    if (Date.now() - this.lastCleanupAt < 60 * 60 * 1000) return;
    await this.supabase.rpc("authenti8_cleanup_email");
    this.lastCleanupAt = Date.now();
  }

  private async sendLink(to: string, kind: MailKind, token: string) {
    const url = this.linkUrl(kind, token);
    if (!this.config.smtp.host) {
      if (this.config.isProduction) throw new ServiceUnavailableException("Email delivery is not configured.");
      return url;
    }
    const transport = nodemailer.createTransport({
      host: this.config.smtp.host, port: this.config.smtp.port,
      secure: this.config.smtp.secure, ...smtpTimeouts,
      auth: this.config.smtp.user
        ? { user: this.config.smtp.user, pass: this.config.smtp.password }
        : undefined,
    });
    const label = kind === "verify" ? "Verify your email" : "Reset your password";
    await transport.sendMail({
      from: this.config.smtp.from, to, subject: `${label} · Authenti8`,
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

  private get isServerless() {
    return process.env.VERCEL === "1";
  }

  private logFailure(kind: string, error: unknown) {
    const reason = error instanceof Error ? error.message : "Unknown delivery failure";
    console.error(`[mail] ${kind} delivery failed: ${reason}`);
  }
}

function mailContext(kind: MailKind, recipient: string) {
  return `${kind}:${recipient}`;
}

function claimInput(message: OutboxRow) {
  return { id: message.id, attempts: message.attempts };
}
