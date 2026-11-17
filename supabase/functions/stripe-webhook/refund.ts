// RavMizAI — the refund rule, used by stripe-webhook.
//
// The client's rule (Nov 2026): when a subscription payment is refunded, the
// member keeps access until the end of the period that payment covered, and
// the subscription does not renew. So a full refund only switches renewal off
// (cancel_at_period_end). Stripe then sends customer.subscription.updated, and
// customer.subscription.deleted at the period end, which the webhook already
// turns into "access until the period end" and then "access ended". The Billing
// page shows "Cancelled. Your access continues until <date>".
//
// A partial refund counts as a goodwill credit and changes nothing. To end the
// membership as well, cancel the subscription in Stripe.

// Every call here asks for this Stripe API version, so the response shapes
// below do not depend on the account's default version.
const STRIPE_VERSION = '2025-03-31.basil';

// Subscriptions that can still renew. Any other status has nothing to switch off.
const RENEWABLE = ['trialing', 'active', 'past_due', 'unpaid'];

const idOf = (v: any): string | null => (typeof v === 'string' ? v : v?.id ?? null);

// GET, or POST when params are given. Throws with Stripe's own message, so the
// webhook answers 500 and Stripe retries the event.
async function stripe(key: string, path: string, params?: Record<string, string>) {
  const res = await fetch('https://api.stripe.com/v1/' + path, {
    method: params ? 'POST' : 'GET',
    headers: {
      'Authorization': 'Bearer ' + key,
      'Stripe-Version': STRIPE_VERSION,
      ...(params ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: params ? new URLSearchParams(params).toString() : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || `Stripe ${path.split('?')[0]} failed`);
  return body;
}

// The subscription a charge paid for, or null when it paid for anything else.
// Events in API versions before 2025-03-31 name the invoice on the charge.
// Later versions dropped charge.invoice, and the invoice is found through the
// Invoice Payments API instead.
export async function subscriptionForCharge(key: string, charge: any): Promise<string | null> {
  let invoiceId = idOf(charge?.invoice);
  const pi = idOf(charge?.payment_intent);
  if (!invoiceId && !('invoice' in (charge ?? {})) && pi) {
    const list = await stripe(key,
      `invoice_payments?payment[type]=payment_intent&payment[payment_intent]=${encodeURIComponent(pi)}&limit=1`);
    invoiceId = idOf(list?.data?.[0]?.invoice);
  }
  if (!invoiceId) return null;
  const inv = await stripe(key, 'invoices/' + encodeURIComponent(invoiceId));
  return idOf(inv?.parent?.subscription_details?.subscription) ?? idOf(inv?.subscription);
}

// Applies the rule to the charge in a charge.refunded event. Returns what it
// did, for the function log.
export async function applyRefund(key: string, charge: any): Promise<string> {
  if (!charge?.refunded) return 'partial refund, membership unchanged';
  const subId = await subscriptionForCharge(key, charge);
  if (!subId) return 'not a subscription payment, membership unchanged';
  const path = 'subscriptions/' + encodeURIComponent(subId);
  const sub = await stripe(key, path);
  if (!RENEWABLE.includes(sub?.status)) return `${subId} is ${sub?.status}, nothing to stop`;
  if (sub.cancel_at_period_end) return `${subId} already ends at the period end`;
  await stripe(key, path, { cancel_at_period_end: 'true' });
  return `${subId} will not renew; access continues to the period end`;
}
