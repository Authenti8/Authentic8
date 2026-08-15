import { BadGatewayException, BadRequestException, Inject, Injectable } from "@nestjs/common";
import { loadConfig } from "../config.js";
import { SupabaseService } from "../supabase/supabase.service.js";
import { assertDodoInvoiceUrl } from "./dodo-urls.js";

@Injectable()
export class BillingInvoiceService {
  private readonly config = loadConfig();
  constructor(@Inject(SupabaseService) private readonly supabase: SupabaseService) {}

  async invoice(userId: string, paymentId: string) {
    const owned = await this.supabase.rpc<{ paymentId?: string } | null>(
      "authenti8_billing_payment_context", { userId, paymentId },
    );
    if (!owned?.paymentId) throw new BadRequestException("Payment is unavailable.");
    if (!this.config.dodo.apiKey) throw new BadRequestException("Dodo billing is not configured yet.");
    let response: Response;
    try {
      response = await fetch(new URL(`/payments/${encodeURIComponent(owned.paymentId)}`,
        this.config.dodo.baseUrl), { headers: {
        authorization: `Bearer ${this.config.dodo.apiKey}`,
      }, signal: AbortSignal.timeout(15_000) });
    } catch { throw new BadGatewayException("The invoice provider is unavailable."); }
    if (!response.ok) throw new BadGatewayException("The invoice provider is unavailable.");
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    const invoiceUrl = body?.invoice_url;
    if (typeof invoiceUrl !== "string" || !invoiceUrl) {
      throw new BadRequestException("The invoice is not ready yet.");
    }
    try { assertDodoInvoiceUrl(invoiceUrl); }
    catch { throw new BadGatewayException("The invoice provider returned an invalid URL."); }
    return { invoiceUrl };
  }
}
