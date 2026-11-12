// RavMizAI — record-usage
//
// Charges a member's wallet for a finished conversation. Voice is charged in
// seconds, so a 40-second call costs 40 seconds rather than a rounded minute.
//
// Server to server only. How long a call lasted must come from the system that
// ran it (Delphi, once it reports session length -- see USAGE-TRACKING.md),
// never from a member's browser, which could simply report less. So the caller
// must present a server key (service_role or a secret key; see
// _shared/server-key.ts), and a member's own token is refused.
// Balances are written only by record_usage() in the database, which is
// service-role only too.
//
//   POST /functions/v1/record-usage
//   Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
//   { "user_id": "<uuid>", "call_id": "<unique id from the call system>",
//     "seconds": 40, "chats": 0, "description": "Voice call" }
//
//   -> { ok, seconds_left, chats_left, charged_seconds, overage_seconds, duplicate }
//
// call_id makes a report count once: the same call sent twice (a retry, a
// duplicate webhook) is charged once. Charges stop at zero; anything beyond the
// balance comes back as overage_seconds and is noted on the ledger row, so the
// history still adds up to the balance.
//
// Deploy:
//   npx supabase functions deploy record-usage

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { bearer, isServerKey } from '../_shared/server-key.ts';

const json =(body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

// A single call cannot plausibly exceed this; a larger number means a bug or a
// tampered request, and silently draining a wallet would be worse than failing.
const MAX_SECONDS = 4 * 60 * 60;   // 4 hours
const MAX_CHATS = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CALL_ID = /^[A-Za-z0-9._:-]{1,100}$/;

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) {
    console.error('missing env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
    return json({ error: 'Server is not configured.' }, 500);
  }

  // 1. Only the backend may report usage.
  if (!(await isServerKey(url, bearer(req)))) {
    return json({ error: 'Usage is recorded by the server, not the browser.' }, 403);
  }

  // 2. Whose call, which call, how much.
  let body: any = {};
  try { body = await req.json(); } catch { /* validated below */ }

  const userId = String(body?.user_id ?? '');
  const callId = String(body?.call_id ?? '');
  const seconds = Math.floor(Number(body?.seconds ?? 0));
  const chats = Math.floor(Number(body?.chats ?? 0));

  if (!UUID.test(userId)) return json({ error: 'user_id must be the member\'s id.' }, 400);
  if (!CALL_ID.test(callId)) return json({ error: 'call_id is required (letters, digits, . _ : -, up to 100).' }, 400);
  if (!Number.isFinite(seconds) || !Number.isFinite(chats) || seconds < 0 || chats < 0) {
    return json({ error: 'Invalid usage amount.' }, 400);
  }
  if (seconds > MAX_SECONDS || chats > MAX_CHATS) {
    console.warn('implausible usage rejected:', userId, callId, seconds, chats);
    return json({ error: 'Usage amount out of range.' }, 400);
  }

  // A short label, for the ledger row the member sees.
  const raw = typeof body?.description === 'string' ? body.description.trim() : '';
  const description = (raw || (seconds ? 'Voice call' : 'Text messages')).slice(0, 80);

  // 3. Charge, once per call.
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data, error } = await admin.rpc('record_usage', {
    p_user_id: userId,
    p_seconds: seconds,
    p_chats: chats,
    p_description: description,
    p_ref: 'usage:' + callId,
  });

  if (error) {
    console.error('record_usage failed:', error.message);
    return json({ error: 'Could not record usage.' }, /no wallet/i.test(error.message) ? 404 : 500);
  }

  const row = Array.isArray(data) ? data[0] : data;
  return json({
    ok: true,
    seconds_left: row?.seconds_left ?? null,
    chats_left: row?.chats_left ?? null,
    charged_seconds: row?.charged_seconds ?? 0,
    overage_seconds: row?.overage_seconds ?? 0,
    duplicate: !!row?.duplicate,
  });
});
