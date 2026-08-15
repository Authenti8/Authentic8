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

export type MailKind = "verify" | "reset" | "candidate_verification";
export type OutboxPayload = {
  recipient: string; kind: MailKind; encryptedToken: string;
  initializationVector: string; authenticationTag: string;
  interviewId?: string;
};
type OutboxRow = OutboxPayload & { id: string; attempts: number };
type NotificationOutboxRow = { id: string; attempts: number; recipient: string;
  title: string; message: string; linkPath: string | null };
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
    const [links, notifications] = await Promise.all([
      this.drainOutbox(limit), this.drainNotificationOutbox(limit),
    ]);
    return links + notifications;
  }

  private async drainNotificationOutbox(limit: number) {
    const claims = await Promise.allSettled(Array.from({ length: limit }, () =>
      this.supabase.rpc<NotificationOutboxRow | null>("authenti8_claim_notification_email")));
    const messages = claims.flatMap((claim) => claim.status === "fulfilled" && claim.value
      ? [claim.value] : []);
    const deliveries = await Promise.allSettled(messages.map((message) =>
      this.deliverNotification(message)));
    for (const delivery of deliveries) {
      if (delivery.status === "rejected") this.logFailure("notification", delivery.reason);
    }
    return messages.length;
  }

  private async deliverNotification(message: NotificationOutboxRow) {
    const stopLeaseRenewal = this.startNotificationLeaseRenewal(message);
    try {
      await this.sendNotification(message);
      await this.supabase.rpc("authenti8_complete_notification_email", claimInput(message));
    } catch (error) {
      await this.supabase.rpc("authenti8_fail_notification_email", {
        ...claimInput(message), error: error instanceof Error ? error.message : "Delivery failed",
      });
      throw error;
    } finally { stopLeaseRenewal(); }
  }

  private startNotificationLeaseRenewal(message: NotificationOutboxRow) {
    const timer = setInterval(() => {
      void this.supabase.rpc("authenti8_renew_notification_email", claimInput(message))
        .catch((error: unknown) => this.logFailure("notification lease", error));
    }, 10_000);
    timer.unref();
    return () => clearInterval(timer);
  }

  private async sendNotification(message: NotificationOutboxRow) {
    if (!this.config.smtp.host) {
      if (this.config.isProduction) throw new ServiceUnavailableException("Email delivery is not configured.");
      return;
    }
    const transport = nodemailer.createTransport({
      host: this.config.smtp.host, port: this.config.smtp.port, secure: this.config.smtp.secure,
      ...smtpTimeouts, auth: this.config.smtp.user
        ? { user: this.config.smtp.user, pass: this.config.smtp.password } : undefined,
    });
    const url = new URL(message.linkPath ?? "/dashboard", this.config.appOrigin).toString();
    await transport.sendMail({ from: this.config.smtp.from, to: message.recipient,
      subject: `${message.title} · Authenti8`,
      text: `${message.message}\n\nOpen Authenti8: ${url}`,
      html: `<p>${escapeHtml(message.message)}</p><p><a href="${url}">Open Authenti8</a></p>` });
  }

  private scheduleDrain() {
    if (this.drainInFlight) return;
    this.drainInFlight = this.drainPending()
      .then(() => undefined)
      .catch((error: unknown) => this.logFailure("outbox", error))
      .finally(() => { this.drainInFlight = undefined; });
  }

  private async drainOutbox(limit = 10) {
    const claims = await Promise.allSettled(Array.from({ length: limit }, () =>
      this.supabase.rpc<OutboxRow | null>("authenti8_claim_email")));
    const messages: OutboxRow[] = [];
    for (const claim of claims) {
      if (claim.status === "fulfilled" && claim.value) messages.push(claim.value);
      if (claim.status === "rejected") this.logFailure("claim", claim.reason);
    }
    const deliveries = await Promise.allSettled(
      messages.map((message) => this.deliverClaimedMessage(message)),
    );
    for (const delivery of deliveries) {
      if (delivery.status === "rejected") this.logFailure("outbox", delivery.reason);
    }
    await this.cleanupTerminalMessages();
    return messages.length;
  }

  private async deliverClaimedMessage(message: OutboxRow) {
    const stopLeaseRenewal = this.startLeaseRenewal(message);
    try {
      const deliverable = await this.supabase.rpc<boolean>(
        "authenti8_email_claim_is_deliverable", claimInput(message),
      );
      if (!deliverable) return;
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
    }, 10_000);
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
    const label = mailLabel(kind);
    await transport.sendMail({
      from: this.config.smtp.from, to, subject: `${label} · Authenti8`,
      text: `${label}: ${url}\n\nThis link expires soon. Ignore this email if you did not request it.`,
      html: `<p>${label} to continue with Authenti8.</p><p><a href="${url}">${label}</a></p><p>This link expires soon.</p>`,
    });
    return undefined;
  }

  private linkUrl(kind: MailKind, token: string) {
    if (kind === "candidate_verification") {
      return `${this.config.appOrigin}/candidate/verify#token=${encodeURIComponent(token)}`;
    }
    const path = kind === "verify" ? "/verify-email"
      : "/reset-password";
    return `${this.config.authOrigin}${path}?token=${encodeURIComponent(token)}`;
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

function mailLabel(kind: MailKind) {
  if (kind === "verify") return "Verify your email";
  if (kind === "reset") return "Reset your password";
  return "Review your interview verification and consent";
}

function mailContext(kind: MailKind, recipient: string) {
  return `${kind}:${recipient}`;
}

function claimInput(message: { id: string; attempts: number }) {
  return { id: message.id, attempts: message.attempts };
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
