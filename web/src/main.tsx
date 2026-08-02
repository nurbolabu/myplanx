import React, { FormEvent, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

declare global { interface Window { Telegram?: { WebApp?: { initData: string; ready(): void; expand(): void } } } }
type Task = { id: string; title: string; dueAt: string | null; reminderAt: string | null; assigneeId: string | null };
type Item = { id: string; title: string; quantity: string | null; category: string };
type Member = { id: string; name: string; role: string };
type Data = { user: { id: string; name: string }; spaces: { id: string; name: string; type: string }[]; activeSpaceId: string; members: Member[]; tasks: Task[]; shopping: Item[]; totals: Record<string, number> };
const tg = window.Telegram?.WebApp;
const request = (path: string, options?: RequestInit) => fetch(path, { ...options, headers: { 'Content-Type': 'application/json', 'x-telegram-init-data': tg?.initData ?? '', ...(options?.headers ?? {}) } });
const money = (value = 0) => `${new Intl.NumberFormat('ru-RU').format(value)} ₸`;

function App() {
  const [data, setData] = useState<Data | null>(null);
  const [tab, setTab] = useState<'today' | 'plans' | 'shopping' | 'budget'>('today');
  const [adding, setAdding] = useState<'task' | 'shopping' | 'expense' | 'space' | null>(null);
  const load = async (spaceId?: string) => { const response = await request(`/api/bootstrap${spaceId ? `?spaceId=${spaceId}` : ''}`); if (response.ok) setData(await response.json()); };
  useEffect(() => { tg?.ready(); tg?.expand(); void load(); }, []);
  const balance = useMemo(() => (data?.totals.income ?? 0) - (data?.totals.expense ?? 0), [data]);
  if (!data) return <main className="loading">Загружаем MyPlanX…</main>;
  const done = async (id: string) => { await request(`/api/tasks/${id}/complete`, { method: 'PATCH', body: JSON.stringify({ spaceId: data.activeSpaceId }) }); void load(); };
  const switchSpace = () => { const index = data.spaces.findIndex((space) => space.id === data.activeSpaceId); void load(data.spaces[(index + 1) % data.spaces.length].id); };
  return <main>
    <header><p className="eyebrow">{new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())}</p><h1>Привет, {data.user.name}</h1><button className="space" onClick={switchSpace}>{data.spaces.find(s => s.id === data.activeSpaceId)?.name}⌄</button></header>
    {tab === 'today' && <><section className="hero"><span>Ваш день</span><strong>{data.tasks.length} {data.tasks.length === 1 ? 'дело' : data.tasks.length < 5 ? 'дела' : 'дел'}</strong><p>Маленькие шаги делают большую неделю.</p></section><Section title="Сегодня" action={() => setAdding('task')} actionText="+ Дело"><TaskList tasks={data.tasks} onDone={done}/></Section><section className="quick"><button onClick={() => setAdding('task')}>✓<span>Задачу</span></button><button onClick={() => setAdding('shopping')}>🛒<span>Покупку</span></button><button onClick={() => setAdding('expense')}>₸<span>Расход</span></button></section></>}
    {tab === 'plans' && <><Section title="План недели" action={() => setAdding('task')} actionText="+ Дело"><TaskList tasks={data.tasks} onDone={done}/></Section><section className="invite-card"><div><b>Планируйте вместе</b><p>Создайте пространство для пары или семьи и пригласите близких.</p></div><button onClick={() => setAdding('space')}>Создать общее пространство</button></section></>}
    {tab === 'shopping' && <Section title="Покупки" action={() => setAdding('shopping')} actionText="+ Добавить">{data.shopping.length ? data.shopping.map(item => <div className="row" key={item.id}><i className="check"/><div><b>{item.title}</b><small>{item.category}{item.quantity ? ` · ${item.quantity}` : ''}</small></div></div>) : <Empty text="Список покупок пока пуст"/>}</Section>}
    {tab === 'budget' && <><section className="balance"><span>Остаток за месяц</span><strong>{money(balance)}</strong><div><small>Доходы {money(data.totals.income)}</small><small>Расходы {money(data.totals.expense)}</small></div></section><Section title="Последние операции" action={() => setAdding('expense')} actionText="+ Расход"><Empty text="Добавьте первую операцию"/></Section></>}
    <nav>{[['today','Сегодня'],['plans','Планы'],['shopping','Покупки'],['budget','Бюджет']].map(([key, label]) => <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key as typeof tab)}><span>{key === 'today' ? '◉' : key === 'plans' ? '▣' : key === 'shopping' ? '◌' : '₸'}</span>{label}</button>)}</nav>
    {adding && adding !== 'space' && <AddSheet type={adding} spaceId={data.activeSpaceId} members={data.members} close={() => setAdding(null)} saved={() => { setAdding(null); void load(); }}/>} 
    {adding === 'space' && <SpaceSheet close={() => setAdding(null)} saved={(spaceId) => { setAdding(null); void load(spaceId); }}/>} 
  </main>;
}

function Section({ title, action, actionText, children }: { title: string; action: () => void; actionText: string; children: React.ReactNode }) { return <section className="section"><div className="section-head"><h2>{title}</h2><button onClick={action}>{actionText}</button></div><div className="card">{children}</div></section>; }
function Empty({ text }: { text: string }) { return <p className="empty">{text}</p>; }
function TaskList({ tasks, onDone }: { tasks: Task[]; onDone: (id: string) => void }) { return tasks.length ? <>{tasks.map(task => <div className="row" key={task.id}><button className="check" onClick={() => onDone(task.id)} aria-label="Выполнить задачу"/><div><b>{task.title}</b>{task.dueAt && <small>{new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(task.dueAt))}</small>}{task.reminderAt && <small>🔔 Напоминание</small>}</div></div>)}</> : <Empty text="На сегодня всё свободно"/>; }
function AddSheet({ type, spaceId, members, close, saved }: { type: 'task' | 'shopping' | 'expense'; spaceId: string; members: Member[]; close: () => void; saved: () => void }) {
  const [busy, setBusy] = useState(false); const title = type === 'task' ? 'Новое дело' : type === 'shopping' ? 'Добавить покупку' : 'Добавить расход';
  const submit = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); setBusy(true); const form = new FormData(event.currentTarget); const value = String(form.get('value') ?? '');
    const body = type === 'expense' ? { spaceId, kind: 'expense', amount: Number(value), category: String(form.get('category') || 'Другое') } : type === 'task' ? { spaceId, title: value, dueAt: form.get('dueAt') ? new Date(String(form.get('dueAt'))).toISOString() : null, reminderAt: form.get('reminderAt') ? new Date(String(form.get('reminderAt'))).toISOString() : null, assigneeId: String(form.get('assigneeId') || '') || undefined } : { spaceId, title: value, quantity: String(form.get('quantity') || '') || null, category: String(form.get('category') || 'Другое') };
    const endpoint = type === 'task' ? '/api/tasks' : type === 'shopping' ? '/api/shopping' : '/api/transactions'; const response = await request(endpoint, { method: 'POST', body: JSON.stringify(body) }); if (response.ok) saved(); else setBusy(false); };
  return <div className="overlay"><form className="sheet" onSubmit={submit}><div className="handle"/><div className="sheet-title"><h2>{title}</h2><button type="button" onClick={close}>Отмена</button></div><label>{type === 'expense' ? 'Сумма' : type === 'shopping' ? 'Что купить?' : 'Что нужно сделать?'}<input name="value" type={type === 'expense' ? 'number' : 'text'} min="1" required autoFocus placeholder={type === 'expense' ? '0' : 'Например, купить молоко'}/></label>{type === 'task' && <><label>Исполнитель<select name="assigneeId" defaultValue={members[0]?.id}>{members.map((member) => <option value={member.id} key={member.id}>{member.name}{member.role === 'owner' ? ' (владелец)' : ''}</option>)}</select></label><label>Срок<input name="dueAt" type="datetime-local"/></label><label>Напомнить<input name="reminderAt" type="datetime-local"/></label></>}{type !== 'task' && <label>Категория<input name="category" placeholder={type === 'expense' ? 'Продукты' : 'Другое'}/></label>}{type === 'shopping' && <label>Количество<input name="quantity" placeholder="2 шт."/></label>}<button className="save" disabled={busy}>{busy ? 'Сохраняем…' : 'Сохранить'}</button></form></div>;
}
function SpaceSheet({ close, saved }: { close: () => void; saved: (id: string) => void }) {
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); setBusy(true); const name = String(new FormData(event.currentTarget).get('name')); const response = await request('/api/spaces', { method: 'POST', body: JSON.stringify({ name }) }); if (!response.ok) return setBusy(false); const result = await response.json(); if (result.invite.link) { await navigator.clipboard?.writeText(result.invite.link); window.alert('Ссылка-приглашение скопирована. Отправьте её партнёру — он нажмёт /start и сразу войдёт в общее пространство.'); } saved(result.space.id); };
  return <div className="overlay"><form className="sheet" onSubmit={submit}><div className="handle"/><div className="sheet-title"><h2>Новое общее пространство</h2><button type="button" onClick={close}>Отмена</button></div><p className="sheet-copy">Например, «Мы», «Дом» или «Семья». После создания вы получите ссылку для партнёра.</p><label>Название<input name="name" required minLength={2} autoFocus placeholder="Наш дом"/></label><button className="save" disabled={busy}>{busy ? 'Создаём…' : 'Создать и пригласить'}</button></form></div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
