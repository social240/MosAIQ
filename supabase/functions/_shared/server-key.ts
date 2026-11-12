// RavMizAI — is this caller our own backend?
//
// The project has two kinds of server key: the legacy service_role JWT and the
// newer sb_secret_ key, and the one in a function's environment is not always
// the one a caller holds. So rather than compare strings, ask Auth: only a
// server key may list users. Member and anonymous tokens are refused there.
export async function isServerKey(url: string, key: string): Promise<boolean> {
  if (!key) return false;
  const own = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (own && key === own) return true;
  const headers: Record<string, string> = { apikey: key };
  if (key.startsWith('eyJ')) headers['Authorization'] = 'Bearer ' + key;   // JWTs only
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/auth/v1/admin/users?page=1&per_page=1`, { headers });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

export const bearer = (req: Request) => {
  const h = req.headers.get('Authorization') ?? '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
};
