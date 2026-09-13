import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import crypto from 'crypto'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 3000

app.use(cors())
app.use(express.json())

const users = new Map()

function validateTelegramInitData(initData) {
  if (!initData || !process.env.BOT_TOKEN) {
    return null
  }

  const params = new URLSearchParams(initData)
  const hash = params.get('hash')

  if (!hash) return null

  params.delete('hash')

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')

  const secretKey = crypto
    .createHmac('sha256', 'WebAppData')
    .update(process.env.BOT_TOKEN)
    .digest()

  const calculatedHash = crypto
    .createHmac('sha256', secretKey)
    .update(dataCheckString)
    .digest('hex')

  if (calculatedHash !== hash) return null

  const authDate = Number(params.get('auth_date'))

  if (!authDate) return null

  const age = Math.floor(Date.now() / 1000) - authDate

  if (age > 86400 || age < 0) return null

  const userJson = params.get('user')

  if (!userJson) return null

  try {
    return JSON.parse(userJson)
  } catch {
    return null
  }
}

function requireAdmin(req, res) {
  const telegramUser = validateTelegramInitData(
    req.headers['x-telegram-init-data']
  )

  if (!telegramUser) {
    res.status(401).json({
      ok: false,
      error: 'Invalid Telegram initData'
    })

    return null
  }

  const adminId = String(
    process.env.ADMIN_TELEGRAM_ID || ''
  )

  if (String(telegramUser.id) !== adminId) {
    res.status(403).json({
      ok: false,
      error: 'Admin access required'
    })

    return null
  }

  return telegramUser
}

/* =========================
   ОСНОВНЫЕ API
========================= */

app.get('/', (req, res) => {
  res.json({
    ok: true,
    name: 'VeltoGifts API',
    version: '1.3.0'
  })
})

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    message: 'VeltoGifts API is running'
  })
})

/* =========================
   ПОЛЬЗОВАТЕЛЬ
========================= */

app.post('/api/user', (req, res) => {
  const { initData } = req.body

  const telegramUser = validateTelegramInitData(initData)

  if (!telegramUser) {
    return res.status(401).json({
      ok: false,
      error: 'Invalid Telegram initData'
    })
  }

  const id = String(telegramUser.id)

  if (!users.has(id)) {
    users.set(id, {
      telegramId: id,
      username: telegramUser.username || '',
      firstName: telegramUser.first_name || '',
      balance: 0,
      blocked: false,
      inventory: []
    })
  }

  const user = users.get(id)

  if (user.blocked) {
    return res.status(403).json({
      ok: false,
      error: 'User is blocked'
    })
  }

  res.json({
    ok: true,
    user
  })
})

/* =========================
   ПРОВЕРКА АДМИНА
========================= */

app.get('/api/admin/check', (req, res) => {
  const telegramUser = validateTelegramInitData(
    req.headers['x-telegram-init-data']
  )

  if (!telegramUser) {
    return res.status(401).json({
      ok: false,
      error: 'Invalid Telegram initData'
    })
  }

  const adminId = String(
    process.env.ADMIN_TELEGRAM_ID || ''
  )

  res.json({
    ok: true,
    isAdmin: String(telegramUser.id) === adminId
  })
})

/* =========================
   АДМИН — ПОЛЬЗОВАТЕЛИ
========================= */

app.get('/api/admin/users', (req, res) => {
  if (!requireAdmin(req, res)) return

  const list = [...users.values()].map(user => ({
    telegramId: user.telegramId,
    username: user.username,
    firstName: user.firstName,
    balance: user.balance,
    blocked: user.blocked,
    inventoryCount: user.inventory.length
  }))

  res.json({
    ok: true,
    users: list,
    total: list.length
  })
})

/* =========================
   АДМИН — БАЛАНС
========================= */

app.post('/api/admin/balance', (req, res) => {
  if (!requireAdmin(req, res)) return

  const { telegramId, amount } = req.body

  const id = String(telegramId || '')
  const value = Number(amount)

  if (!id || !Number.isInteger(value) || value === 0) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid telegramId or amount'
    })
  }

  const user = users.get(id)

  if (!user) {
    return res.status(404).json({
      ok: false,
      error: 'User not found'
    })
  }

  if (user.balance + value < 0) {
    return res.status(400).json({
      ok: false,
      error: 'Balance cannot be negative'
    })
  }

  user.balance += value

  res.json({
    ok: true,
    user
  })
})

/* =========================
   АДМИН — БЛОКИРОВКА
========================= */

app.post('/api/admin/block', (req, res) => {
  if (!requireAdmin(req, res)) return

  const { telegramId, blocked } = req.body

  const id = String(telegramId || '')
  const user = users.get(id)

  if (!user) {
    return res.status(404).json({
      ok: false,
      error: 'User not found'
    })
  }

  user.blocked = Boolean(blocked)

  res.json({
    ok: true,
    user
  })
})

/* =========================
   КЕЙСЫ
========================= */

const cases = {
  starter: {
    id: 'starter',
    name: 'Starter Case',
    price: 10,

    rewards: [
      {
        id: 'common',
        name: 'Common Gift',
        value: 5,
        chance: 60
      },
      {
        id: 'rare',
        name: 'Rare Gift',
        value: 15,
        chance: 30
      },
      {
        id: 'epic',
        name: 'Epic Gift',
        value: 30,
        chance: 10
      }
    ]
  },

  premium: {
    id: 'premium',
    name: 'Premium Case',
    price: 50,

    rewards: [
      {
        id: 'rare',
        name: 'Rare Gift',
        value: 40,
        chance: 55
      },
      {
        id: 'epic',
        name: 'Epic Gift',
        value: 80,
        chance: 30
      },
      {
        id: 'legendary',
        name: 'Legendary Gift',
        value: 150,
        chance: 15
      }
    ]
  }
}

/* =========================
   ВЫБОР НАГРАДЫ
========================= */

function chooseReward(rewards) {
  const random = Math.random() * 100

  let current = 0

  for (const reward of rewards) {
    current += reward.chance

    if (random <= current) {
      return reward
    }
  }

  return rewards[rewards.length - 1]
}

/* =========================
   СПИСОК КЕЙСОВ
========================= */

app.get('/api/cases', (req, res) => {
  res.json({
    ok: true,
    cases
  })
})

/* =========================
   ОТКРЫТИЕ КЕЙСА
========================= */

app.post('/api/cases/open', (req, res) => {
  const { initData, caseId } = req.body

  const telegramUser = validateTelegramInitData(initData)

  if (!telegramUser) {
    return res.status(401).json({
      ok: false,
      error: 'Invalid Telegram initData'
    })
  }

  const currentCase = cases[caseId]

  if (!currentCase) {
    return res.status(404).json({
      ok: false,
      error: 'Case not found'
    })
  }

  const id = String(telegramUser.id)
  const user = users.get(id)

  if (!user) {
    return res.status(404).json({
      ok: false,
      error: 'User not found'
    })
  }

  if (user.blocked) {
    return res.status(403).json({
      ok: false,
      error: 'User is blocked'
    })
  }

  if (user.balance < currentCase.price) {
    return res.status(400).json({
      ok: false,
      error: 'Not enough balance',
      required: currentCase.price,
      balance: user.balance
    })
  }

  const reward = chooseReward(currentCase.rewards)

  user.balance -= currentCase.price

  const item = {
    id: crypto.randomUUID(),
    rewardId: reward.id,
    name: reward.name,
    value: reward.value,
    caseName: currentCase.name,
    receivedAt: new Date().toISOString()
  }

  user.inventory.push(item)

  res.json({
    ok: true,
    case: currentCase.name,
    spent: currentCase.price,
    reward: item,
    balance: user.balance,
    inventory: user.inventory
  })
})

/* =========================
   ЗАПУСК
========================= */

app.listen(PORT, () => {
  console.log(`VeltoGifts API running on port ${PORT}`)
})
