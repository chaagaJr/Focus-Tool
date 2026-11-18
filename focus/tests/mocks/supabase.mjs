// A tiny in-memory stand-in for supabase-js, covering only the calls the edge function makes.
export const tables = { items: [], push_subs: [], app_config: [] };
const PK = { items: 'id', push_subs: 'endpoint', app_config: 'key' };
const ITEM_DEFAULTS = () => ({
  body: '', tags: [], pinned: false, priority: false, remind_at: null, repeat: null, nag_minutes: null,
  snoozed_until: null, last_nagged_at: null, nag_count: 0, done_at: null,
  due_at: null, ends_at: null, busy: true, lead_minutes: null, star_date: null, effort_minutes: null,
  parent_id: null, birthday: null, checkin_days: null, last_contact: null, source: null, source_uid: null, meta: {},
});

export function reset() { for (const k of Object.keys(tables)) tables[k] = []; }

class Query {
  constructor(table) { this.table = table; this.filters = []; this.op = 'select'; this.cols = '*'; this.mode = 'many'; this.wantRows = true; }
  select(cols = '*') { this.cols = cols; if (this.op === 'select') this.op = 'select'; this.wantRows = true; return this; }
  eq(k, v) { this.filters.push((r) => r[k] === v); return this; }
  is(k, v) { this.filters.push((r) => (r[k] ?? null) === v); return this; }
  order(k, { ascending = true } = {}) { this.orderBy = [k, ascending]; return this; }
  single() { this.mode = 'single'; return this; }
  maybeSingle() { this.mode = 'maybe'; return this; }
  insert(rows) { this.op = 'insert'; this.rows = [].concat(rows); this.wantRows = false; return this; }
  upsert(rows, opts = {}) { this.op = 'upsert'; this.rows = [].concat(rows); this.opts = opts; this.wantRows = false; return this; }
  update(patch) { this.op = 'update'; this.patch = patch; this.wantRows = false; return this; }
  delete() { this.op = 'delete'; return this; }
  then(resolve, reject) { try { resolve(this.run()); } catch (e) { reject(e); } }

  run() {
    const t = tables[this.table];
    const pk = PK[this.table];
    const now = new Date().toISOString();
    let out = [];
    if (this.op === 'select') out = t.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === 'insert' || this.op === 'upsert') {
      for (const row of this.rows) {
        const r = structuredClone(row);
        if (this.table === 'items') {
          r.id ??= crypto.randomUUID();
          if (!r.title) return { data: null, error: { message: 'null value in column "title"' } };
        }
        const i = t.findIndex((x) => x[pk] === r[pk]);
        if (i >= 0) {
          if (this.op === 'insert') return { data: null, error: { message: 'duplicate key' } };
          if (this.opts?.ignoreDuplicates) { continue; }
          t[i] = { ...t[i], ...r, updated_at: now };
          out.push(t[i]);
        } else {
          const full = this.table === 'items' ? { ...ITEM_DEFAULTS(), created_at: now, updated_at: now, ...r } : { created_at: now, ...r };
          t.push(full);
          out.push(full);
        }
      }
    }
    if (this.op === 'update') {
      for (const r of t) if (this.filters.every((f) => f(r))) { Object.assign(r, structuredClone(this.patch), { updated_at: now }); out.push(r); }
    }
    if (this.op === 'delete') {
      tables[this.table] = t.filter((r) => !this.filters.every((f) => f(r)));
      return { data: null, error: null };
    }
    if (this.orderBy) {
      const [k, asc] = this.orderBy;
      out = [...out].sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (asc ? 1 : -1));
    }
    if (this.cols !== '*') {
      const cols = this.cols.split(',').map((c) => c.trim());
      out = out.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
    }
    out = structuredClone(out);
    if (this.mode === 'single') return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned' } };
    if (this.mode === 'maybe') return out.length <= 1 ? { data: out[0] ?? null, error: null } : { data: null, error: { message: 'multiple rows' } };
    return { data: out, error: null };
  }
}

export function createClient() {
  return { from: (table) => new Query(table) };
}
