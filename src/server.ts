import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { Bot, Keyboard } from 'grammy';
import { z } from 'zod';
import { acceptInvitation, canAccess, completeTask, createInvitation, createSharedSpace, createShoppingItem, createTask, createTransaction, dueReminders, ensureUser, getDashboard, getSpaces, markReminderSent } from './database.js';

const token = process.env.BOT_TOKEN ?? '';
if (!token) throw new Error('BOT_TOKEN is required');
const webAppUrl = process.env.WEB_APP_URL ?? 'http://localhost:5173';
const port = Number(process.env.PORT ?? 3000);
const bot = new Bot(token);
let botUsername = process.env.BOT_USERNAME ?? '';
const plannerKeyboard = () => webAppUrl.startsWith('https://') ? new Keyboard().webApp('Открыть планер', webAppUrl).resized() : undefined;

function verifyInitData(raw: string) {
  const params = new URLSearchParams(raw);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const signature = crypto.createHmac('sha256', secret).update(check).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature))) return null;
  const user = params.get('user');
  return user ? z.object({ id: z.number(), first_name: z.string(), last_name: z.string().optional() }).parse(JSON.parse(user)) : null;
}

function identity(req: express.Request) {
  const initData = req.header('x-telegram-init-data');
  const user = initData ? verifyInitData(initData) : null;
  if (user) return { id: String(user.id), name: [user.first_name, user.last_name].filter(Boolean).join(' ') };
  if (process.env.NODE_ENV !== 'production') return { id: 'local-user', name: 'Вы' };
  throw new Error('Telegram authorization required');
}

bot.command('start', async (ctx) => {
  const from = ctx.from;
  if (!from) return;
  ensureUser(String(from.id), [from.first_name, from.last_name].filter(Boolean).join(' '));
  const inviteCode = ctx.match?.trim().match(/^join_([a-z0-9]+)$/i)?.[1];
  if (inviteCode) {
    const space = acceptInvitation(inviteCode, String(from.id));
    if (space) await ctx.reply(`Вы присоединились к пространству «${space.name}». Теперь задачи, покупки и бюджет будут общими.`);
    else await ctx.reply('Эта ссылка-приглашение недействительна или уже истекла. Попросите создать новую.');
  }
  await ctx.reply(webAppUrl.startsWith('https://')
    ? 'Добро пожаловать в MyPlanX. Здесь будут задачи, покупки и общий бюджет — без отдельного логина.'
    : 'MyPlanX готов. Mini App будет доступен сразу после размещения проекта по HTTPS.');
  const keyboard = plannerKeyboard();
  if (keyboard) await ctx.reply('Откройте планер:', { reply_markup: keyboard });
});

bot.command('today', async (ctx) => {
  if (!ctx.from) return;
  ensureUser(String(ctx.from.id), ctx.from.first_name);
  const [space] = getSpaces(String(ctx.from.id));
  const { tasks } = getDashboard(space.id);
  const text = tasks.length ? tasks.map((task, index) => `${index + 1}. ${task.title}${task.dueAt ? ` — ${new Date(task.dueAt).toLocaleString('ru-RU')}` : ''}`).join('\n') : 'На сегодня пока нет задач.';
  await ctx.reply(`📅 Сегодня\n${text}`);
});

bot.command('help', (ctx) => ctx.reply('Команды: /start — открыть планер, /today — задачи. Скоро можно будет добавлять дела обычным текстом.'));

const app = express();
app.use(express.json());
app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));
app.use((req, res, next) => { try { res.locals.user = identity(req); ensureUser(res.locals.user.id, res.locals.user.name); next(); } catch { res.status(401).json({ error: 'Unauthorized' }); } });

app.get('/api/bootstrap', (req, res) => {
  const spaces = getSpaces(res.locals.user.id);
  const requested = typeof req.query.spaceId === 'string' ? req.query.spaceId : spaces[0]?.id;
  if (!requested || !canAccess(res.locals.user.id, requested)) return res.status(403).json({ error: 'Space unavailable' });
  res.json({ user: res.locals.user, spaces, activeSpaceId: requested, ...getDashboard(requested) });
});

app.post('/api/spaces', (req, res) => {
  const body = z.object({ name: z.string().trim().min(2).max(50) }).parse(req.body);
  const space = createSharedSpace(res.locals.user.id, body.name);
  const invite = createInvitation(space.id, res.locals.user.id);
  const link = botUsername ? `https://t.me/${botUsername}?start=join_${invite.code}` : null;
  res.status(201).json({ space, invite: { ...invite, link } });
});

app.post('/api/spaces/:id/invitations', (req, res) => {
  if (!canAccess(res.locals.user.id, req.params.id)) return res.status(403).end();
  const invite = createInvitation(req.params.id, res.locals.user.id);
  res.status(201).json({ ...invite, link: botUsername ? `https://t.me/${botUsername}?start=join_${invite.code}` : null });
});

app.post('/api/tasks', (req, res) => {
  const body = z.object({ spaceId: z.string().uuid(), title: z.string().trim().min(1).max(160), dueAt: z.string().datetime().nullable().optional(), reminderAt: z.string().datetime().nullable().optional(), assigneeId: z.string().min(1).optional() }).parse(req.body);
  if (!canAccess(res.locals.user.id, body.spaceId)) return res.status(403).end();
  const assigneeId = body.assigneeId ?? res.locals.user.id;
  if (!canAccess(assigneeId, body.spaceId)) return res.status(422).json({ error: 'Assignee is not a space member' });
  res.status(201).json(createTask({ spaceId: body.spaceId, title: body.title, dueAt: body.dueAt ?? null, reminderAt: body.reminderAt ?? null, assigneeId }));
});

app.patch('/api/tasks/:id/complete', (req, res) => {
  const body = z.object({ spaceId: z.string().uuid() }).parse(req.body);
  if (!canAccess(res.locals.user.id, body.spaceId)) return res.status(403).end();
  completeTask(req.params.id, body.spaceId); res.status(204).end();
});

app.post('/api/shopping', (req, res) => {
  const body = z.object({ spaceId: z.string().uuid(), title: z.string().trim().min(1).max(100), quantity: z.string().max(30).nullable().optional(), category: z.string().max(40).default('Другое') }).parse(req.body);
  if (!canAccess(res.locals.user.id, body.spaceId)) return res.status(403).end();
  res.status(201).json(createShoppingItem(body.spaceId, body.title, body.quantity ?? null, body.category));
});

app.post('/api/transactions', (req, res) => {
  const body = z.object({ spaceId: z.string().uuid(), kind: z.enum(['expense', 'income']), amount: z.number().positive().max(10_000_000_000), category: z.string().trim().min(1).max(40), happenedAt: z.string().datetime().optional(), note: z.string().max(200).nullable().optional() }).parse(req.body);
  if (!canAccess(res.locals.user.id, body.spaceId)) return res.status(403).end();
  res.status(201).json(createTransaction({ ...body, happenedAt: body.happenedAt ?? new Date().toISOString(), note: body.note ?? null, paidBy: res.locals.user.id }));
});

app.use(express.static(path.join(process.cwd(), 'dist')));
app.get('/{*path}', (_req, res) => res.sendFile(path.join(process.cwd(), 'dist', 'index.html')));

app.listen(port, () => console.log(`MyPlanX API: http://localhost:${port}`));

async function startBot() {
  await bot.init();
  botUsername ||= bot.botInfo.username;
  bot.start({ onStart: () => console.log(`MyPlanX bot @${botUsername} is polling`) });
}

setInterval(async () => {
  for (const task of dueReminders()) {
    try {
      await bot.api.sendMessage(task.assigneeId, `⏰ Напоминание\n${task.title}${task.dueAt ? `\nСрок: ${new Date(task.dueAt).toLocaleString('ru-RU')}` : ''}`, { reply_markup: plannerKeyboard() });
    } catch {
      // A user may block the bot. Do not retry the same reminder forever.
    } finally {
      markReminderSent(task.id);
    }
  }
}, 30_000);

bot.catch((error) => console.error('Bot update error:', error.error));
void startBot();
