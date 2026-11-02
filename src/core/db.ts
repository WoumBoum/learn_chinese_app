// Thin wrapper around sql.js (SQLite compiled to WASM) — no native module to rebuild.
import fs from 'node:fs';
import path from 'node:path';
import type { Database, SqlJsStatic, SqlValue } from 'sql.js';

export type Params = SqlValue[] | Record<string, SqlValue>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, face TEXT NOT NULL, ref TEXT NOT NULL,
  due INTEGER NOT NULL, stability REAL NOT NULL DEFAULT 0, difficulty REAL NOT NULL DEFAULT 0,
  elapsed_days REAL NOT NULL DEFAULT 0, scheduled_days REAL NOT NULL DEFAULT 0, learning_steps INTEGER NOT NULL DEFAULT 0,
  reps INTEGER NOT NULL DEFAULT 0, lapses INTEGER NOT NULL DEFAULT 0, state INTEGER NOT NULL DEFAULT 0,
  last_review INTEGER, created INTEGER NOT NULL, suspended INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS cards_due ON cards(due);
CREATE INDEX IF NOT EXISTS cards_ref ON cards(kind, ref);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL, ts INTEGER NOT NULL, rating INTEGER NOT NULL,
  state INTEGER NOT NULL, elapsed REAL NOT NULL, duration_ms INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS reviews_ts ON reviews(ts);
CREATE TABLE IF NOT EXISTS introduced (
  kind TEXT NOT NULL, ref TEXT NOT NULL, ts INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'curriculum',
  PRIMARY KEY (kind, ref)
);
CREATE TABLE IF NOT EXISTS known_override (word TEXT PRIMARY KEY, status TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, ts INTEGER NOT NULL, type TEXT NOT NULL,
  minutes REAL NOT NULL DEFAULT 0, detail TEXT
);
CREATE INDEX IF NOT EXISTS activity_date ON activity(date);
CREATE TABLE IF NOT EXISTS day_state (date TEXT PRIMARY KEY, mode TEXT NOT NULL, done TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS grammar_progress (
  id TEXT PRIMARY KEY, lesson_done INTEGER, best_score REAL, attempts INTEGER NOT NULL DEFAULT 0, last_ts INTEGER
);
CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY, url TEXT NOT NULL, title TEXT NOT NULL, source_id TEXT, duration REAL NOT NULL DEFAULT 0,
  path TEXT, status TEXT NOT NULL, error TEXT, added_at INTEGER NOT NULL, coverage REAL, projected_coverage REAL,
  themes TEXT NOT NULL DEFAULT '[]', summary TEXT, thumbnail TEXT, subs_source TEXT, watched INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS segments (
  video_id TEXT NOT NULL, idx INTEGER NOT NULL, start REAL NOT NULL, end REAL NOT NULL, text TEXT NOT NULL,
  tokens TEXT NOT NULL, fr TEXT, PRIMARY KEY (video_id, idx)
);
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY, video_id TEXT NOT NULL, planned_date TEXT NOT NULL, status TEXT NOT NULL,
  preteach TEXT NOT NULL DEFAULT '[]', created INTEGER NOT NULL, completed_at INTEGER, comprehension REAL
);
CREATE TABLE IF NOT EXISTS mined (
  id TEXT PRIMARY KEY, video_id TEXT, zh TEXT NOT NULL, fr TEXT, start REAL, end REAL, created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, week INTEGER NOT NULL, score REAL NOT NULL,
  ts INTEGER NOT NULL, details TEXT
);
CREATE TABLE IF NOT EXISTS ai_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS stories (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, zh TEXT NOT NULL, fr TEXT, theme TEXT, created INTEGER NOT NULL, read INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS word_videos (
  target TEXT NOT NULL, slot TEXT NOT NULL, video_id TEXT NOT NULL, title TEXT, channel TEXT, duration INTEGER, score REAL,
  rank INTEGER, source TEXT, start INTEGER, status TEXT, fetched_at INTEGER, off_slot INTEGER NOT NULL DEFAULT 0,
  status_at INTEGER,
  PRIMARY KEY (target, slot, video_id)
);
`;

let SQL: SqlJsStatic | null = null;

export async function initSql(wasmDir?: string): Promise<SqlJsStatic> {
  if (SQL) return SQL;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const initSqlJs = require('sql.js');
  SQL = await initSqlJs(wasmDir ? { locateFile: (f: string) => path.join(wasmDir, f) } : undefined);
  return SQL!;
}

export class Db {
  private db: Database;
  private file: string | null;
  private timer: NodeJS.Timeout | null = null;

  constructor(sql: SqlJsStatic, file: string | null) {
    this.file = file;
    if (file && fs.existsSync(file)) this.db = new sql.Database(fs.readFileSync(file));
    else this.db = new sql.Database();
    this.db.exec(SCHEMA);
    this.addMissingColumns();
  }

  /** Colonnes ajoutées après la création d'une table (base existante) : ALTER TABLE additif. */
  private addMissingColumns(): void {
    const add: [table: string, column: string, decl: string][] = [['word_videos', 'status_at', 'INTEGER']];
    for (const [table, column, decl] of add) {
      const cols = this.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);
      if (cols.length && !cols.includes(column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    }
  }

  all<T = Record<string, unknown>>(sql: string, params: Params = []): T[] {
    const st = this.db.prepare(sql);
    try {
      st.bind(params);
      const out: T[] = [];
      while (st.step()) out.push(st.getAsObject() as T);
      return out;
    } finally {
      st.free();
    }
  }

  get<T = Record<string, unknown>>(sql: string, params: Params = []): T | undefined {
    return this.all<T>(sql, params)[0];
  }

  run(sql: string, params: Params = []): void {
    this.db.run(sql, params);
    this.scheduleSave();
  }

  tx(fn: () => void): void {
    this.db.exec('BEGIN');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.scheduleSave();
  }

  getSetting<T>(key: string, fallback: T): T {
    const r = this.get<{ value: string }>('SELECT value FROM settings WHERE key=?', [key]);
    return r ? (JSON.parse(r.value) as T) : fallback;
  }

  setSetting(key: string, value: unknown): void {
    this.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [
      key,
      JSON.stringify(value),
    ]);
  }

  private scheduleSave() {
    if (!this.file) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.saveNow(), 800);
  }

  saveNow(): void {
    if (!this.file) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const data = this.db.export();
    const tmp = this.file + '.tmp';
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, Buffer.from(data));
    fs.renameSync(tmp, this.file);
  }
}
