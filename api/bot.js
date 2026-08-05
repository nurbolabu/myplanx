import { Bot, webhookCallback } from "grammy";

// Инициализируем бота с токеном из переменных окружения
const bot = new Bot(process.env.BOT_TOKEN);

// Настраиваем команду /start
bot.command("start", (ctx) => {
  ctx.reply(
    "👋 Привет! Я твой умный трекер целей и финансов.\n\n" +
    "Здесь мы будем вести учет твоих личных, рабочих и семейных планов.\n" +
    "Нажми кнопку ниже, чтобы открыть приложение.",
    {
      reply_markup: {
        inline_keyboard: [
          [
            { 
              text: "🚀 Открыть Mini App", 
              web_app: { url: process.env.WEB_APP_URL } 
            }
          ]
        ]
      }
    }
  );
});

// Экспортируем функцию как Webhook для Vercel
export default webhookCallback(bot, "http");