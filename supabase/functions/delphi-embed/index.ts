// RavMizAI — delphi-embed
//
// Hands the Delphi call or chat embed to a signed-in member, and only to one.
// The embeds' channel ids used to sit in app/call.html and app/chat.html,
// where any visitor could read them, and the membership check ran only in the
// browser. They now live in this function's secrets, and are given out after
// the database says the caller is subscribed: is_subscribed(), the same rule
// the app uses.
//
// It also keeps the optional daily cap (sql/012). Opening the page starts a
// session, and the page checks in about once a minute while it stays open.
// The cap counts time with the call or chat open, not talk time (Delphi does
// not report call length). It is off unless public.daily_limits sets one.
//
//   POST /functions/v1/delphi-embed
//   Authorization: Bearer <member JWT>
//
//   { "action": "open", "kind": "call" | "chat" }
//     -> 200 { ok, kind, channel, session_id, limit_seconds, used_seconds, ping_seconds }
//     -> 403 { error: "membership_required" }
//     -> 429 { error: "daily_limit", limit_seconds, used_seconds }
//
//   { "action": "ping", "session_id": "<uuid>" }
//     -> 200 { ok, limit_seconds, used_seconds, stop }
//
// limit_seconds is null while there is no cap.
//
// Secrets (never commit them; the old ids are in git history):
//   DELPHI_CALL_CHANNEL   data-channel of the Voice embed
//   DELPHI_CHAT_CHANNEL   data-channel of the Chat embed
//
// Deploy:
//   npx supabase functions deploy delphi-embed

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PING_SECONDS = 60;
const first = (data: unknown) => (Array.isArray(data) ? data[0] : data) as any;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anonKey || !serviceKey) {
    console.error('missing env: SUPABASE_*');
    return json({ error: 'The conversation is not available right now.' }, 500);
  }

  // 1. Who is asking?
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'Not signed in.' }, 401);
  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: who, error: whoErr } = await asCaller.auth.getUser();
  const user = who?.user;
  if (whoErr || !user) return json({ error: 'Your session has expired. Please sign in again.' }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* checked below */ }
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // 2a. A check-in from an open page.
  if (body?.action === 'ping') {
    const sid = typeof body.session_id === 'string' && UUID.test(body.session_id) ? body.session_id : '';
    if (!sid) return json({ error: 'Unknown session.' }, 400);
    const { data, error } = await admin.rpc('embed_ping', { p_user: user.id, p_session: sid });
    if (error) {
      console.error('embed_ping failed:', error.message);
      return json({ error: 'Could not record the session.' }, 500);
    }
    const r = first(data);
    if (!r) return json({ error: 'Unknown session.' }, 404);
    const limit = r.out_limit_seconds ?? null;
    const used = r.out_used_seconds ?? 0;
    return json({ ok: true, limit_seconds: limit, used_seconds: used, stop: limit !== null && used >= limit });
  }

  // 2b. Opening the call or chat page.
  if (body?.action !== 'open') return json({ error: 'Unknown action.' }, 400);
  const kind = body.kind === 'call' || body.kind === 'chat' ? body.kind : '';
  if (!kind) return json({ error: 'Unknown kind.' }, 400);
  const channel = (Deno.env.get(kind === 'call' ? 'DELPHI_CALL_CHANNEL' : 'DELPHI_CHAT_CHANNEL') ?? '').trim();
  if (!UUID.test(channel)) {
    console.error(`missing or malformed secret DELPHI_${kind.toUpperCase()}_CHANNEL`);
    return json({ error: 'The conversation is not available right now.' }, 500);
  }

  // 3. Membership, by the database's own rule. Asked as the caller, so
  //    auth.uid() inside is_subscribed() is theirs.
  const { data: subscribed, error: subErr } = await asCaller.rpc('is_subscribed');
  if (subErr) {
    console.error('is_subscribed failed:', subErr.message);
    return json({ error: 'Could not check your membership. Please refresh the page.' }, 502);
  }
  if (subscribed !== true) return json({ error: 'membership_required' }, 403);

  // 4. The daily cap, then the session.
  const { data, error } = await admin.rpc('embed_open', { p_user: user.id, p_kind: kind });
  if (error) {
    console.error('embed_open failed:', error.message);
    return json({ error: 'The conversation is not available right now.' }, 500);
  }
  const r = first(data);
  if (!r?.out_session) {
    return json({ error: 'daily_limit', limit_seconds: r?.out_limit_seconds ?? null, used_seconds: r?.out_used_seconds ?? null }, 429);
  }
  return json({
    ok: true,
    kind,
    channel,
    session_id: r.out_session,
    limit_seconds: r.out_limit_seconds ?? null,
    used_seconds: r.out_used_seconds ?? 0,
    ping_seconds: PING_SECONDS,
  });
});
