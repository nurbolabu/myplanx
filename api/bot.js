import { Bot, webhookCallback, Keyboard, InlineKeyboard, session } from "grammy";
import { conversations, createConversation } from "@grammyjs/conversations";
import { createClient } from "@supabase/supabase-js";

const bot = new Bot(process.env.BOT_TOKEN);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Главная клавиатура
const mainKeyboard = new Keyboard()
  .text("➕ Добавить запись")
  .row()
  .text("🎯 Мои Цели")
  .text("💳 Финансы")
  .row()
  .webApp("🚀 Открыть Mini App", process.env.WEB_APP_URL || "https://myplanx.vercel.app")
  .resized();

bot.use(session({ initial: () => ({}) }));
bot.use(conversations());

// --- НОВАЯ ФУНКЦИЯ: Отмена любого текущего действия ---
bot.command("cancel", async (ctx) => {
  await ctx.conversation.exit();
  await ctx.reply("Действие отменено 🛑", { reply_markup: mainKeyboard });
});

// --- СЦЕНА 1: Добавление Цели ---
async function addGoalConversation(conversation, ctx) {
  await ctx.reply("Выберите тип цели (или отправьте /cancel для отмены):", {
    reply_markup: new InlineKeyboard()
      .text("💡 Обычная цель", "goal_type_ordinary")
      .text("🧠 SMART-цель", "goal_type_smart")
  });

  const typeCtx = await conversation.waitFor("callback_query:data");
  const goalType = typeCtx.callbackQuery.data === "goal_type_smart" ? "smart" : "ordinary";
  await typeCtx.answerCallbackQuery();

  await typeCtx.reply("Введите название цели:");
  const titleCtx = await conversation.waitFor("message:text");
  if (titleCtx.message.text === "/cancel") {
    return titleCtx.reply("Отменено 🛑", { reply_markup: mainKeyboard });
  }
  const title = titleCtx.message.text;

  await titleCtx.reply("Укажите срок выполнения:", {
    reply_markup: new InlineKeyboard()
      .text("📅 На сегодня", "period_today")
      .text("📆 На месяц", "period_month")
  });

  const periodCtx = await conversation.waitFor("callback_query:data");
  const period = periodCtx.callbackQuery.data.replace("period_", "");
  await periodCtx.answerCallbackQuery();

  await periodCtx.reply("Выберите пространство:", {
    reply_markup: new InlineKeyboard()
      .text("🟢 Личное", "space_personal")
      .text("🔵 Работа", "space_work")
      .text("🔴 Семья", "space_shared")
  });

  const spaceCtx = await conversation.waitFor("callback_query:data");
  const spaceType = spaceCtx.callbackQuery.data.replace("space_", "");
  await spaceCtx.answerCallbackQuery();

  try {
    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('telegram_id', ctx.from.id)
      .maybeSingle();

    if (profile) {
      const { data: space } = await supabase
        .from('spaces')
        .select('id, space_members!inner(user_id)')
        .eq('space_members.user_id', profile.id)
        .eq('type', spaceType)
        .maybeSingle();

      if (space) {
        await supabase.from('goals').insert({
          space_id: space.id,
          created_by: profile.id,
          title: title,
          type: goalType,
          period: period,
          status: 'todo'
        });
        await spaceCtx.reply(`✅ Цель "${title}" создана!`, { reply_markup: mainKeyboard });
      } else {
        await spaceCtx.reply("⚠️ Пространство не найдено.");
      }
    }
  } catch (e) {
    console.error(e);
    await spaceCtx.reply("⚠️ Ошибка сохранения цели.");
  }
}

// --- СЦЕНА 2: Добавление Расхода / Дохода ---
async function addFinanceConversation(conversation, ctx) {
  await ctx.reply("Введите сумму (число) или /cancel для отмены:");
  const amountCtx = await conversation.waitFor("message:text");
  
  if (amountCtx.message.text === "/cancel") {
    return amountCtx.reply("Отменено 🛑", { reply_markup: mainKeyboard });
  }

  const amount = parseFloat(amountCtx.message.text.replace(",", "."));

  if (isNaN(amount)) {
    await amountCtx.reply("⚠️ Неверная сумма. Начните заново.");
    return;
  }

  await amountCtx.reply("Это расход или доход?", {
    reply_markup: new InlineKeyboard()
      .text("➖ Расход", "fin_expense")
      .text("➕ Доход", "fin_income")
  });

  const typeCtx = await conversation.waitFor("callback_query:data");
  const finType = typeCtx.callbackQuery.data === "fin_expense" ? "expense" : "income";
  await typeCtx.answerCallbackQuery();

  await typeCtx.reply("Введите название или категорию (например: Кофе):");
  const titleCtx = await conversation.waitFor("message:text");
  const title = titleCtx.message.text;

  try {
    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('telegram_id', ctx.from.id)
      .maybeSingle();

    if (profile) {
      const { data: member } = await supabase
        .from('space_members')
        .select('space_id')
        .eq('user_id', profile.id)
        .limit(1)
        .maybeSingle();

      if (member) {
        await supabase.from('transactions').insert({
          space_id: member.space_id,
          user_id: profile.id,
          amount: amount,
          type: finType,
          title: title
        });
        const sign = finType === "expense" ? "➖" : "➕";
        await titleCtx.reply(`✅ Записано: ${sign} ${amount} (${title})`, { reply_markup: mainKeyboard });
      }
    }
  } catch (e) {
    console.error(e);
    await titleCtx.reply("⚠️ Ошибка сохранения транзакции.");
  }
}

bot.use(createConversation(addGoalConversation));
bot.use(createConversation(addFinanceConversation));

bot.command("start", async (ctx) => {
  const telegramId = ctx.from.id;
  const username = ctx.from.username || null;
  const firstName = ctx.from.first_name || "Пользователь";

  try {
    let { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('telegram_id', telegramId)
      .maybeSingle();

    let userId;
    if (!profile) {
      const { data: newProfile } = await supabase
        .from('profiles')
        .insert({
          telegram_id: telegramId,
          username: username,
          first_name: firstName
        })
        .select('id')
        .single();
      
      userId = newProfile.id;

      const spacesTypes = [
        { name: 'Личное', type: 'personal' },
        { name: 'Работа', type: 'work' },
        { name: 'Семья', type: 'shared' }
      ];

      for (const st of spacesTypes) {
        const { data: sp } = await supabase
          .from('spaces')
          .insert({ name: st.name, type: st.type })
          .select('id')
          .single();

        await supabase
          .from('space_members')
          .insert({ space_id: sp.id, user_id: userId, role: 'owner' });
      }
    }

    await ctx.reply(`👋 Привет, ${firstName}! Твой планер готов.`, { reply_markup: mainKeyboard });
  } catch (error) {
    console.error("Database error:", error);
    await ctx.reply("⚠️ Ошибка базы данных.");
  }
});

bot.hears("➕ Добавить запись", async (ctx) => {
  await ctx.reply("Что вы хотите добавить?", {
    reply_markup: new InlineKeyboard()
      .text("🎯 Цель / Задачу", "add_goal_choice")
      .row()
      .text("💳 Расход / Доход", "add_finance_choice")
  });
});

// --- ИНТЕРАКТИВНОЕ МЕНЮ "🎯 Мои Цели" ---
bot.hears("🎯 Мои Цели", async (ctx) => {
  const keyboard = new InlineKeyboard()
    .text("🟢 Личное", "nav_period:personal")
    .text("🔵 Работа", "nav_period:work")
    .row()
    .text("🔴 Семья", "nav_period:shared")
    .row()
    .text("❌ Закрыть", "nav_close"); // Новая кнопка закрытия

  await ctx.reply("📂 Выберите пространство:", { reply_markup: keyboard });
});

// --- ОБРАБОТКА "💳 Финансы" ---
bot.hears("💳 Финансы", async (ctx) => {
  try {
    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('telegram_id', ctx.from.id)
      .maybeSingle();

    if (!profile) return ctx.reply("⚠️ Профиль не найден. Нажмите /start");

    const { data: txs, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('user_id', profile.id)
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) throw error;

    if (!txs || txs.length === 0) {
      return ctx.reply("💳 У вас пока нет транзакций.\nНажмите **«➕ Добавить запись»**, чтобы внести расход или доход!", {
        parse_mode: "Markdown"
      });
    }

    let totalIncome = 0;
    let totalExpense = 0;

    txs.forEach(t => {
      const val = parseFloat(t.amount);
      if (t.type === 'income') totalIncome += val;
      else totalExpense += val;
    });

    let text = `💳 **Обзор финансов:**\n\n`;
    text += `📈 Доходы: +${totalIncome}\n📉 Расходы: -${totalExpense}\n\n`;
    text += `**Последние записи:**\n`;

    txs.forEach((t) => {
      const sign = t.type === 'income' ? '➕' : '➖';
      text += `${sign} ${t.amount} — ${t.title || 'Без названия'}\n`;
    });

    await ctx.reply(text, { parse_mode: "Markdown" });
  } catch (e) {
    console.error(e);
    await ctx.reply("⚠️ Ошибка при загрузке финансов.");
  }
});

// --- ГЛОБАЛЬНЫЙ ОБРАБОТЧИК КНОПОК ---
bot.on("callback_query:data", async (ctx, next) => {
  const data = ctx.callbackQuery?.data;
  
  // ЗАЩИТА: Если данных нет, передаем управление дальше (исправляет ошибку startsWith)
  if (!data) return next();

  // Обработка кнопки добавления цели/финансов
  if (data === "add_goal_choice") {
    await ctx.answerCallbackQuery();
    return ctx.conversation.enter("addGoalConversation");
  }
  
  if (data === "add_finance_choice") {
    await ctx.answerCallbackQuery();
    return ctx.conversation.enter("addFinanceConversation");
  }

  // НОВАЯ ФУНКЦИЯ: Закрыть меню
  if (data === "nav_close") {
    await ctx.deleteMessage().catch(() => {});
    return ctx.answerCallbackQuery();
  }

  // Навигация: Возврат к выбору пространства
  if (data === "nav_spaces") {
    const keyboard = new InlineKeyboard()
      .text("🟢 Личное", "nav_period:personal")
      .text("🔵 Работа", "nav_period:work")
      .row()
      .text("🔴 Семья", "nav_period:shared")
      .row()
      .text("❌ Закрыть", "nav_close");
    
    await ctx.editMessageText("📂 Выберите пространство:", { reply_markup: keyboard });
    return ctx.answerCallbackQuery();
  }

  // Навигация: Выбор периода
  if (data.startsWith("nav_period:")) {
    const spaceType = data.split(":")[1];
    const spaceNames = { personal: "🟢 Личное", work: "🔵 Работа", shared: "🔴 Семья" };

    const keyboard = new InlineKeyboard()
      .text("📅 На сегодня", `nav_list:${spaceType}:today`)
      .text("📆 На месяц", `nav_list:${spaceType}:month`)
      .row()
      .text("🔙 Назад", "nav_spaces");

    await ctx.editMessageText(`Пространство: **${spaceNames[spaceType]}**\nВыберите период:`, { 
      reply_markup: keyboard, 
      parse_mode: "Markdown" 
    });
    return ctx.answerCallbackQuery();
  }

  // Навигация: Загрузка списка целей
  if (data.startsWith("nav_list:")) {
    const [, spaceType, period] = data.split(":");
    await renderGoalsList(ctx, spaceType, period);
    return ctx.answerCallbackQuery();
  }

  // Выполнение цели (Смена статуса todo <-> done)
  if (data.startsWith("goal_toggle:")) {
    const [, goalId, spaceType, period] = data.split(":");
    
    try {
      const { data: goal } = await supabase.from('goals').select('status').eq('id', goalId).single();
      if (goal) {
        const newStatus = goal.status === 'todo' ? 'done' : 'todo';
        await supabase.from('goals').update({ status: newStatus }).eq('id', goalId);
        
        // Перерисовываем список
        await renderGoalsList(ctx, spaceType, period);
      }
    } catch (e) {
      console.error(e);
      await ctx.answerCallbackQuery({ text: "⚠️ Ошибка обновления", show_alert: true });
    }
    return ctx.answerCallbackQuery();
  }

  // Если нажатие не распознано — передаем дальше
  await next();
});

// Вспомогательная функция отрисовки целей
async function renderGoalsList(ctx, spaceType, period) {
  try {
    const { data: profile } = await supabase.from('profiles').select('id').eq('telegram_id', ctx.from.id).single();
    if (!profile) return;

    const { data: space } = await supabase.from('spaces')
      .select('id, space_members!inner(user_id)')
      .eq('space_members.user_id', profile.id)
      .eq('type', spaceType)
      .single();

    if (!space) {
      return ctx.editMessageText("⚠️ Пространство не найдено.");
    }

    const { data: goals } = await supabase.from('goals')
      .select('*')
      .eq('space_id', space.id)
      .eq('period', period)
      .order('created_at', { ascending: false });

    const spaceNames = { personal: "🟢 Лично", work: "🔵 Работа", shared: "🔴 Семья" };
    const periodNames = { today: "на сегодня", month: "на месяц" };
    
    let text = `🎯 Цели **${spaceNames[spaceType]}** ${periodNames[period]}:\nНажмите на цель, чтобы отметить её как выполненную.`;
    
    const keyboard = new InlineKeyboard();

    if (!goals || goals.length === 0) {
      text = `📭 В категории **${spaceNames[spaceType]}** ${periodNames[period]} пока нет целей.`;
    } else {
      goals.forEach(g => {
        const icon = g.status === 'done' ? '✅' : '⬜️';
        keyboard.text(`${icon} ${g.title}`, `goal_toggle:${g.id}:${spaceType}:${period}`).row();
      });
    }

    keyboard.text("🔙 Назад", `nav_period:${spaceType}`);

    await ctx.editMessageText(text, { reply_markup: keyboard, parse_mode: "Markdown" });
  } catch (e) {
    console.error(e);
    await ctx.editMessageText("⚠️ Ошибка загрузки списка.");
  }
}

export default webhookCallback(bot, "http");