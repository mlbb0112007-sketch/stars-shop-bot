require('dotenv').config()
const { Bot, InlineKeyboard } = require('grammy')

const BOT_TOKEN = process.env.BOT_TOKEN
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID
const ADMIN_USERNAME = process.env.ADMIN_USERNAME // без @, для связи "на крайний случай"
const MINIAPP_URL = process.env.MINIAPP_URL

if (!BOT_TOKEN) throw new Error('BOT_TOKEN не задан в .env')
if (!ADMIN_CHAT_ID) throw new Error('ADMIN_CHAT_ID не задан в .env')
if (!MINIAPP_URL) throw new Error('MINIAPP_URL не задан в .env')

const bot = new Bot(BOT_TOKEN)

// Должно совпадать с PACKAGES в miniapp.html — если меняешь цены там,
// поменяй и здесь, чтобы текст в /start не разъезжался с магазином
const PACKAGES = [
  { stars: 50, price: 13000, badge: null },
  { stars: 100, price: 25000, badge: '🔥' },
  { stars: 250, price: 60000, badge: '-8%' },
  { stars: 500, price: 120000, badge: '-15%' },
]

const PAY_LABELS = {
  card: 'Click / Payme',
  transfer: 'Перевод на карту',
}

// Простое хранилище в памяти: userId -> { orderId, order, status }
// status: 'awaiting_photo' -> 'pending_review' -> 'done' / 'rejected'
// ВАЖНО: при перезапуске бота это всё обнулится. Для прода — заменить
// на базу (sqlite/postgres/redis), особенно если заказов будет много.
const pendingOrders = new Map()
let orderCounter = 1

// /start — цены, контакт на крайний случай и кнопка открытия мини-аппа
bot.command('start', async (ctx) => {
  const priceLines = PACKAGES.map(
    (p) => `⭐ ${p.stars} — ${p.price.toLocaleString('ru')} сум${p.badge ? ` ${p.badge}` : ''}`
  ).join('\n')

  const contactLine = ADMIN_USERNAME
    ? `\n\nЕсли что-то пошло не так — пиши @${ADMIN_USERNAME}`
    : ''

  await ctx.reply(
    `Telegram Stars дёшево и быстро\n\n${priceLines}${contactLine}\n\nЖми кнопку ниже, чтобы открыть магазин 👇`,
    {
      reply_markup: new InlineKeyboard().webApp('🛍 Открыть магазин', MINIAPP_URL),
    }
  )
})

// Заказ пришёл из мини-аппа: tg.sendData(...) в miniapp.html
bot.on('message:web_app_data', async (ctx) => {
  let order
  try {
    order = JSON.parse(ctx.message.web_app_data.data)
  } catch (e) {
    return ctx.reply('Не получилось прочитать заказ, попробуй ещё раз через магазин.')
  }

  const orderId = orderCounter++
  const userId = ctx.from.id

  pendingOrders.set(userId, { orderId, order, status: 'awaiting_photo' })

  const payLabel = PAY_LABELS[order.pay_method] || order.pay_method

  await ctx.reply(
    `Заказ #${orderId} принят ✅\n\n` +
      `⭐ ${order.stars} звёзд\n` +
      `💰 ${order.price.toLocaleString('ru')} сум\n` +
      `💳 ${payLabel}\n\n` +
      `Теперь пришли сюда скриншот чека — без него заказ не уйдёт на проверку.`
  )
})

// Пользователь присылает фото чека
bot.on('message:photo', async (ctx) => {
  const userId = ctx.from.id
  const pending = pendingOrders.get(userId)

  if (!pending || pending.status !== 'awaiting_photo') {
    return ctx.reply('Сейчас не жду от тебя фото. Сначала оформи заказ в магазине 🛍')
  }

  pending.status = 'pending_review'

  const photo = ctx.message.photo[ctx.message.photo.length - 1] // самое крупное из доступных фото
  const { order, orderId } = pending
  const payLabel = PAY_LABELS[order.pay_method] || order.pay_method
  const user = ctx.from

  const adminKeyboard = new InlineKeyboard()
    .text('✅ Подтвердить', `confirm:${userId}:${orderId}`)
    .text('❌ Отклонить', `reject:${userId}:${orderId}`)

  await ctx.api.sendPhoto(ADMIN_CHAT_ID, photo.file_id, {
    caption:
      `Заказ #${orderId}\n` +
      `От: ${[user.first_name, user.last_name].filter(Boolean).join(' ')} ` +
      `(@${user.username || 'без username'}, id ${userId})\n\n` +
      `⭐ ${order.stars} звёзд\n💰 ${order.price.toLocaleString('ru')} сум\n💳 ${payLabel}`,
    reply_markup: adminKeyboard,
  })

  await ctx.reply('Чек получен, заказ отправлен на проверку. Жди подтверждения 🙏')
})

// Админ нажимает "Подтвердить" / "Отклонить" под фото в админ-чате
bot.on('callback_query:data', async (ctx) => {
  const [action, userIdStr, orderIdStr] = ctx.callbackQuery.data.split(':')
  const userId = Number(userIdStr)
  const pending = pendingOrders.get(userId)

  if (!pending || String(pending.orderId) !== orderIdStr) {
    return ctx.answerCallbackQuery({ text: 'Заказ уже не актуален', show_alert: true })
  }

  if (action === 'confirm') {
    pending.status = 'done'
    // Важно: Bot API не умеет начислять Stars пользователю напрямую — это
    // не операция с балансом, а подарок, который оформляется вручную через
    // официальный интерфейс Telegram (Settings → Gift Stars → username).
    // Жми "Подтвердить" только после того, как реально отправил звёзды.
    await ctx.api.sendMessage(
      userId,
      `🎉 Заказ #${pending.orderId} подтверждён! ⭐ ${pending.order.stars} звёзд уже у тебя — проверь профиль.`
    )
    await ctx.editMessageCaption({
      caption: ctx.callbackQuery.message.caption + '\n\n✅ Подтверждено',
    })
  } else if (action === 'reject') {
    pending.status = 'rejected'
    await ctx.api.sendMessage(
      userId,
      `❌ Заказ #${pending.orderId} отклонён. Если это ошибка — напиши в поддержку.`
    )
    await ctx.editMessageCaption({
      caption: ctx.callbackQuery.message.caption + '\n\n❌ Отклонено',
    })
  }

  pendingOrders.delete(userId)
  await ctx.answerCallbackQuery()
})

bot.catch((err) => console.error('Ошибка бота:', err))

bot.start()
console.log('Бот запущен')
