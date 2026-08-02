import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export type Task = {
  id: string; spaceId: string; title: string; dueAt: string | null;
  reminderAt: string | null; assigneeId: string | null; status: 'open' | 'done'; createdAt: string;
};

export type Transaction = {
  id: string; spaceId: string; kind: 'expense' | 'income'; amount: number;
  category: string; paidBy: string; happenedAt: string; note: string | null;
};

const db = new DatabaseSync('myplanx.sqlite');
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, owner_id TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS space_members (space_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', PRIMARY KEY (space_id, user_id));
  CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, title TEXT NOT NULL, due_at TEXT, assignee_id TEXT, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, kind TEXT NOT NULL, amount REAL NOT NULL, category TEXT NOT NULL, paid_by TEXT NOT NULL, happened_at TEXT NOT NULL, note TEXT);
  CREATE TABLE IF NOT EXISTS shopping_items (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, title TEXT NOT NULL, quantity TEXT, category TEXT NOT NULL DEFAULT 'Другое', is_done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS invitations (code TEXT PRIMARY KEY, space_id TEXT NOT NULL, creator_id TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL);
`);

function addColumn(table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumn('tasks', 'reminder_at', 'TEXT');
addColumn('tasks', 'reminded_at', 'TEXT');

const now = () => new Date().toISOString();

export function ensureUser(id: string, name: string) {
  db.prepare('INSERT OR IGNORE INTO users (id, name, created_at) VALUES (?, ?, ?)').run(id, name, now());
  const own = db.prepare("SELECT id FROM spaces WHERE owner_id = ? AND type = 'personal'").get(id) as { id: string } | undefined;
  if (!own) {
    const spaceId = randomUUID();
    db.prepare('INSERT INTO spaces (id, name, type, owner_id, created_at) VALUES (?, ?, ?, ?, ?)').run(spaceId, 'Мой план', 'personal', id, now());
    db.prepare('INSERT INTO space_members (space_id, user_id, role) VALUES (?, ?, ?)').run(spaceId, id, 'owner');
  }
}

export function getSpaces(userId: string) {
  return db.prepare(`SELECT s.id, s.name, s.type FROM spaces s JOIN space_members m ON m.space_id = s.id WHERE m.user_id = ? ORDER BY s.created_at`).all(userId) as Array<{ id: string; name: string; type: string }>;
}

export function getMembers(spaceId: string) {
  return db.prepare(`SELECT u.id, u.name, m.role FROM space_members m JOIN users u ON u.id = m.user_id WHERE m.space_id = ? ORDER BY m.role = 'owner' DESC, u.name`).all(spaceId) as Array<{ id: string; name: string; role: string }>;
}

export function createSharedSpace(ownerId: string, name: string) {
  const id = randomUUID();
  db.prepare('INSERT INTO spaces (id, name, type, owner_id, created_at) VALUES (?, ?, ?, ?, ?)').run(id, name, 'shared', ownerId, now());
  db.prepare('INSERT INTO space_members (space_id, user_id, role) VALUES (?, ?, ?)').run(id, ownerId, 'owner');
  return { id, name, type: 'shared' };
}

export function createInvitation(spaceId: string, creatorId: string) {
  const code = randomUUID().replaceAll('-', '').slice(0, 12);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO invitations (code, space_id, creator_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)').run(code, spaceId, creatorId, expiresAt, now());
  return { code, expiresAt };
}

export function acceptInvitation(code: string, userId: string) {
  const invitation = db.prepare('SELECT space_id AS spaceId, expires_at AS expiresAt FROM invitations WHERE code = ?').get(code) as { spaceId: string; expiresAt: string } | undefined;
  if (!invitation || new Date(invitation.expiresAt) < new Date()) return null;
  db.prepare('INSERT OR IGNORE INTO space_members (space_id, user_id, role) VALUES (?, ?, ?)').run(invitation.spaceId, userId, 'member');
  return db.prepare('SELECT id, name, type FROM spaces WHERE id = ?').get(invitation.spaceId) as { id: string; name: string; type: string };
}

export function canAccess(userId: string, spaceId: string) {
  return Boolean(db.prepare('SELECT 1 FROM space_members WHERE user_id = ? AND space_id = ?').get(userId, spaceId));
}

export function getDashboard(spaceId: string) {
  const rows = db.prepare("SELECT * FROM tasks WHERE space_id = ? AND status = 'open' ORDER BY due_at IS NULL, due_at LIMIT 20").all(spaceId) as Array<Record<string, unknown>>;
  const tasks = rows.map((row) => ({ id: String(row.id), spaceId: String(row.space_id), title: String(row.title), dueAt: row.due_at as string | null, reminderAt: row.reminder_at as string | null, assigneeId: row.assignee_id as string | null, status: row.status as Task['status'], createdAt: String(row.created_at) }));
  const shopping = db.prepare('SELECT id, title, quantity, category FROM shopping_items WHERE space_id = ? AND is_done = 0 ORDER BY created_at DESC LIMIT 20').all(spaceId);
  const totals = db.prepare(`SELECT kind, COALESCE(SUM(amount), 0) AS total FROM transactions WHERE space_id = ? AND substr(happened_at, 1, 7) = substr(?, 1, 7) GROUP BY kind`).all(spaceId, now()) as Array<{ kind: string; total: number }>;
  return { tasks, shopping, members: getMembers(spaceId), totals: Object.fromEntries(totals.map((row) => [row.kind, row.total])) };
}

export function createTask(input: Omit<Task, 'id' | 'status' | 'createdAt'>) {
  const task: Task = { id: randomUUID(), status: 'open', createdAt: now(), ...input };
  db.prepare('INSERT INTO tasks (id, space_id, title, due_at, reminder_at, assignee_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(task.id, task.spaceId, task.title, task.dueAt, task.reminderAt, task.assigneeId, task.status, task.createdAt);
  return task;
}

export function dueReminders() {
  return db.prepare(`SELECT t.id, t.title, t.due_at AS dueAt, t.assignee_id AS assigneeId FROM tasks t WHERE t.status = 'open' AND t.assignee_id IS NOT NULL AND t.reminder_at IS NOT NULL AND t.reminded_at IS NULL AND t.reminder_at <= ?`).all(now()) as Array<{ id: string; title: string; dueAt: string; assigneeId: string }>;
}

export function markReminderSent(taskId: string) {
  db.prepare('UPDATE tasks SET reminded_at = ? WHERE id = ?').run(now(), taskId);
}

export function completeTask(id: string, spaceId: string) {
  db.prepare("UPDATE tasks SET status = 'done' WHERE id = ? AND space_id = ?").run(id, spaceId);
}

export function createTransaction(input: Omit<Transaction, 'id'>) {
  const transaction: Transaction = { id: randomUUID(), ...input };
  db.prepare('INSERT INTO transactions (id, space_id, kind, amount, category, paid_by, happened_at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(transaction.id, transaction.spaceId, transaction.kind, transaction.amount, transaction.category, transaction.paidBy, transaction.happenedAt, transaction.note);
  return transaction;
}

export function createShoppingItem(spaceId: string, title: string, quantity: string | null, category: string) {
  const item = { id: randomUUID(), spaceId, title, quantity, category, isDone: 0, createdAt: now() };
  db.prepare('INSERT INTO shopping_items (id, space_id, title, quantity, category, is_done, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(item.id, item.spaceId, item.title, item.quantity, item.category, item.isDone, item.createdAt);
  return item;
}
