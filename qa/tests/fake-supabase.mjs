/**
 * In-memory fake Supabase (auth + app_records REST) used by the QA harness.
 * It behaves like the real PostgREST surface the app uses:
 *   - /auth/v1/token?grant_type=password|refresh_token
 *   - /auth/v1/signup, /auth/v1/user (GET/PUT), /auth/v1/logout, /auth/v1/recover
 *   - /rest/v1/app_records  (GET paginated + count, POST upsert, DELETE)
 *   - /rest/v1/rpc/*        (generic echo/OK stubs)
 */

export class FakeSupabase {
  constructor() {
    this.rows = new Map(); // key: farm_id|entity_type|local_id -> row {farm_id, entity_type, local_id, payload, updated_at}
    this.users = new Map();
    this.sessions = new Map(); // bearer token -> user
    this.clock = Date.now();
    this.requestLog = [];
    this.nextToken = 1;
  }

  isoNow() { this.clock = Math.max(this.clock + 1, Date.now()); return new Date(this.clock).toISOString(); }

  addUser(email, password, user = {}) {
    const u = { id: 'user-' + this.nextToken++, email, password, ...user, public: () => ({ id: u?.id, email, created_at: new Date(0).toISOString() }) };
    u.public = () => ({ id: u.id, email: u.email, created_at: new Date(0).toISOString(), farm_name: u.farm_name || null });
    this.users.set(email, u);
    return u;
  }

  seedRow(farmId, entityType, localId, payload, updatedAt) {
    const key = `${farmId}|${entityType}|${localId}`;
    this.rows.set(key, { farm_id: farmId, entity_type: entityType, local_id: localId, payload: JSON.parse(JSON.stringify(payload)), updated_at: updatedAt || this.isoNow() });
  }

  rowCount(farmId) {
    return [...this.rows.values()].filter(r => r.farm_id === String(farmId)).length;
  }

  handleFetch(urlString, options = {}) {
    const url = new URL(urlString);
    const method = (options.method || 'GET').toUpperCase();
    const headers = options.headers || {};
    const auth = headers.Authorization || '';
    const body = options.body ? JSON.parse(options.body) : null;
    this.requestLog.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });

    // ---- AUTH ----
    if (url.pathname === '/auth/v1/token' && method === 'POST') {
      const grant = url.searchParams.get('grant_type');
      if (grant === 'password') {
        const u = this.users.get(String(body.email || '').toLowerCase());
        if (!u || u.password !== body.password) return json(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
        return this.issueSession(u);
      }
      if (grant === 'refresh_token') {
        const s = this.sessions.get(body.refresh_token);
        if (!s) return json(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token: Refresh Token Not Found' });
        return this.issueSession(s.user);
      }
      return json(400, { error: 'bad_grant' });
    }
    if (url.pathname === '/auth/v1/signup' && method === 'POST') {
      const email = String(body.email || '').toLowerCase();
      if (this.users.has(email)) return json(400, { code: 400, error_code: 'user_already_exists', message: 'User already registered' });
      const u = this.addUser(email, body.password);
      u.password = body.password;
      return this.issueSession(u);
    }
    if (url.pathname === '/auth/v1/user' && method === 'GET') {
      const u = this.userFromAuth(auth);
      if (!u) return json(401, { error: 'unauthorized' });
      return json(200, u.public());
    }
    if (url.pathname === '/auth/v1/user' && method === 'PUT') {
      const u = this.userFromAuth(auth);
      if (!u) return json(401, { error: 'unauthorized' });
      if (body.password) u.password = body.password;
      return json(200, u.public());
    }
    if (url.pathname === '/auth/v1/logout' && method === 'POST') {
      const u = this.userFromAuth(auth);
      if (u) { this.sessions.delete(u.refresh ?? ''); }
      return json(200, {});
    }
    if (url.pathname === '/auth/v1/recover' && method === 'POST') return json(200, {});

    // ---- RPC stubs ----
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const rpc = url.pathname.split('/').pop();
      const user = this.userFromAuth(auth);
      if (!user) return json(401, { message: 'not authenticated' });
      if (rpc === 'is_platform_admin') return json(200, body && body.__admin ? true : false);
      if (rpc === 'onboard_my_farm') return json(200, 'farm-' + this.nextToken++);
      if (rpc === 'join_farm_with_invitation') return json(200, 'farm-join-1');
      if (rpc === 'get_farm_membership') return json(200, []);
      return json(200, rpc === 'list_platform_users' ? [] : []);
    }

    // ---- app_records ----
    if (url.pathname === '/rest/v1/app_records') {
      if (method === 'GET') return this.list(url, auth);
      if (method === 'POST') return this.upsert(body, headers);
      if (method === 'DELETE') return this.del(url, auth);
    }
    if (url.pathname.startsWith('/rest/v1/farms')) {
      const user = this.userFromAuth(auth);
      if (!user) return json(401, { message: 'not authenticated' });
      return json(200, [{ id: 'farm-1', name: 'Test Hog Farm', logo_url: null }]);
    }
    if (url.pathname.startsWith('/rest/v1/farm_memberships')) {
      const user = this.userFromAuth(auth);
      if (!user) return json(401, { message: 'not authenticated' });
      return json(200, [{ farm_id: 'farm-1', role: 'owner', plan: 'full', is_active: true, created_at: this.isoNow(), farms: { name: 'Test Hog Farm' } }]);
    }
    return json(404, { message: `No fake route: ${url.pathname}` });
  }

  issueSession(user) {
    const access = 'at-' + user.id + '-' + this.nextToken++;
    user.refresh = 'rt-' + user.id + '-' + this.nextToken++;
    const s = { access_token: access, refresh_token: user.refresh, expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer', user: user.public() };
    this.sessions.set(access, user);
    this.sessions.set(user.refresh, user);
    return json(200, s);
  }

  userFromAuth(auth) {
    const m = /^Bearer\s+(.+)$/.exec(auth || '');
    return m ? this.sessions.get(m[1]) || null : null;
  }

  list(url, auth) {
    if (!this.userFromAuth(auth)) return json(401, { message: 'not authenticated' });
    const q = url.searchParams;
    const farmId = q.get('farm_id') ? q.get('farm_id').replace('eq.', '') : null;
    let rows = [...this.rows.values()].filter(r => r.farm_id === String(farmId));
    // emulate entity_type & local_id filters
    const et = q.get('entity_type');
    if (et) { const v = et.replace('eq.', ''); rows = rows.filter(r => r.entity_type === v); }
    const lid = q.get('local_id');
    if (lid) { const v = lid.replace('eq.', ''); rows = rows.filter(r => r.local_id === v); }
    rows.sort((a, b) => (a.entity_type + a.local_id).localeCompare(b.entity_type + b.local_id));
    const limit = Number(q.get('limit') || 1000);
    const offset = Number(q.get('offset') || 0);
    const total = rows.length;
    const page = rows.slice(offset, offset + limit);
    return json(200, page, { 'content-range': `${offset}-${offset + page.length - 1}/${total}` });
  }

  upsert(bodyRows, headers) {
    if (!Array.isArray(bodyRows)) bodyRows = [bodyRows];
    for (const row of bodyRows) {
      const key = `${row.farm_id}|${row.entity_type}|${row.local_id}`;
      this.rows.set(key, {
        farm_id: row.farm_id,
        entity_type: row.entity_type,
        local_id: row.local_id,
        payload: JSON.parse(JSON.stringify(row.payload || {})),
        updated_at: row.updated_at || this.isoNow()
      });
    }
    return json(201, bodyRows, { prefer: headers.Prefer || '' });
  }

  del(url, auth) {
    if (!this.userFromAuth(auth)) return json(401, { message: 'not authenticated' });
    const q = url.searchParams;
    const farmId = q.get('farm_id') ? q.get('farm_id').replace('eq.', '') : null;
    const et = q.get('entity_type') ? q.get('entity_type').replace('eq.', '') : null;
    const lid = q.get('local_id') ? q.get('local_id').replace('eq.', '') : null;
    let hit = 0;
    for (const [key, row] of this.rows) {
      if (row.farm_id === String(farmId) && (!et || row.entity_type === et) && (!lid || row.local_id === lid)) { this.rows.delete(key); hit++; }
    }
    return json(200, null, { 'content-range': `*/*` }, { 'x-rows-deleted': String(hit) });
  }
}

function json(status, body, extraHeaders = {}, secondHeaders = {}) {
  const h = { 'content-type': 'application/json', ...extraHeaders, ...secondHeaders };
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => h[name.toLowerCase()] ?? h[name] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

/** Build a `fetch`-compatible function bound to a FakeSupabase. */
export function makeFetcher(db) {
  return async (url, options) => db.handleFetch(url, options);
}

/** Minimal storage shim. */
export function makeStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: k => m.delete(k),
    clear: () => m.clear(),
    key: i => [...m.keys()][i] ?? null,
    get length() { return m.size; }
  };
}
