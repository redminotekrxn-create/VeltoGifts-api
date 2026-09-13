import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import crypto from 'crypto'
import { neon } from '@neondatabase/serverless'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 3000

app.use(cors())
app.use(express.json())

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not configured')
}

const sql = process.env.DATABASE_URL
  ? neon(process.env.DATABASE_URL)
  : null

async function initDatabase() {
  if (!sql) return

  await sql`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      username TEXT DEFAULT '',
      first_name TEXT DEFAULT '',
      balance INTEGER NOT NULL DEFAULT 0,
      blocked BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `

  await sql`
    CREATE TABLE IF NOT EXISTS inventory (
      id UUID PRIMARY KEY,
      telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      reward_id TEXT NOT NULL,
      reward_name TEXT NOT NULL,
      value INTEGER NOT NULL DEFAULT 0,
      case_name TEXT DEFAULT '',
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `

  await sql`
    CREATE INDEX IF NOT EXISTS inventory_telegram_id_idx
    ON inventory(telegram_id)
  `

   await sql`
    CREATE TABLE IF NOT EXISTS roulette_spins (
      telegram_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
      last_spin_at TIMESTAMPTZ NOT NULL
    )
  ` console.log('PostgreSQL database ready')
}

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

function getInitData(req) {
  return (
    req.headers['x-telegram-init-data'] ||
    req.body?.initData ||
    ''
  )
}

async function getUser(telegramId) {
  if (!sql) {
    throw new Error('DATABASE_URL is not configured')
  }

  const id = String(telegramId)

  const result = await sql`
    SELECT
      telegram_id,
      username,
      first_name,
      balance,
      blocked
    FROM users
    WHERE telegram_id = ${id}
    LIMIT 1
  `

  if (!result.length) return null

  const row = result[0]

  const inventory = await sql`
    SELECT
      id,
      reward_id,
      reward_name,
      value,
      case_name,
      received_at
    FROM inventory
    WHERE telegram_id = ${id}
    ORDER BY received_at DESC
  `

  return {
    telegramId: String(row.telegram_id),
    username: row.username || '',
    firstName: row.first_name || '',
    balance: Number(row.balance),
    blocked: Boolean(row.blocked),
    inventory: inventory.map(item => ({
      id: item.id,
      rewardId: item.reward_id,
      name: item.reward_name,
      value: Number(item.value),
      caseName: item.case_name || '',
      receivedAt: item.received_at
    }))
  }
}

async function createUser(telegramUser) {
  const id = String(telegramUser.id)

  await sql`
    INSERT INTO users (
      telegram_id,
      username,
      first_name
    )
    VALUES (
      ${id},
      ${telegramUser.username || ''},
      ${telegramUser.first_name || ''}
    )
    ON CONFLICT (telegram_id)
    DO UPDATE SET
      username = EXCLUDED.username,
      first_name = EXCLUDED.first_name
  `

  return getUser(id)
}

async function requireTelegramUser(req, res) {
  const telegramUser = validateTelegramInitData(getInitData(req))

  if (!telegramUser) {
    res.status(401).json({
      ok: false,
      error: 'Invalid Telegram initData'
    })

    return null
  }

  return telegramUser
}

async function requireAdmin(req, res) {
  const telegramUser = await requireTelegramUser(req, res)

  if (!telegramUser) return null

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
    version: '2.0.0',
    database: 'postgresql'
  })
})

app.get('/api/health', async (req, res) => {
  try {
    if (!sql) {
      return res.status(500).json({
        ok: false,
        error: 'DATABASE_URL is not configured'
      })
    }

    await sql`SELECT 1`

    res.json({
      ok: true,
      message: 'VeltoGifts API is running',
      database: 'connected'
    })
  } catch (error) {
    console.error(error)

    res.status(500).json({
      ok: false,
      error: 'Database connection failed'
    })
  }
})

/* =========================
   ПОЛЬЗОВАТЕЛЬ
========================= */

app.post('/api/user', async (req, res) => {
  try {
    const telegramUser = await requireTelegramUser(req, res)

    if (!telegramUser) return

    let user = await getUser(telegramUser.id)

    if (!user) {
      user = await createUser(telegramUser)
    }

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
  } catch (error) {
    console.error(error)

    res.status(500).json({
      ok: false,
      error: 'Database error'
    })
  }
})

/* =========================
   ПРОВЕРКА АДМИНА
========================= */

app.get('/api/admin/check', async (req, res) => {
  try {
    const telegramUser = await requireTelegramUser(req, res)

    if (!telegramUser) return

    const adminId = String(
      process.env.ADMIN_TELEGRAM_ID || ''
    )

    res.json({
      ok: true,
      isAdmin: String(telegramUser.id) === adminId
    })
  } catch (error) {
    console.error(error)

    res.status(500).json({
      ok: false,
      error: 'Server error'
    })
  }
})

/* =========================
   АДМИН — ПОЛЬЗОВАТЕЛИ
========================= */

app.get('/api/admin/users', async (req, res) => {
  try {
    const admin = await requireAdmin(req, res)

    if (!admin) return

    const rows = await sql`
      SELECT
        u.telegram_id,
        u.username,
        u.first_name,
        u.balance,
        u.blocked,
        COUNT(i.id)::int AS inventory_count
      FROM users u
      LEFT JOIN inventory i
        ON i.telegram_id = u.telegram_id
      GROUP BY
        u.telegram_id,
        u.username,
        u.first_name,
        u.balance,
        u.blocked
      ORDER BY u.created_at DESC
    `

    const users = rows.map(row => ({
      telegramId: String(row.telegram_id),
      username: row.username || '',
      firstName: row.first_name || '',
      balance: Number(row.balance),
      blocked: Boolean(row.blocked),
      inventoryCount: Number(row.inventory_count)
    }))

    res.json({
      ok: true,
      users,
      total: users.length
    })
  } catch (error) {
    console.error(error)

    res.status(500).json({
      ok: false,
      error: 'Database error'
    })
  }
})

/* =========================
   АДМИН — БАЛАНС
========================= */

app.post('/api/admin/balance', async (req, res) => {
  try {
    const admin = await requireAdmin(req, res)

    if (!admin) return

    const { telegramId, amount } = req.body

    const id = String(telegramId || '')
    const value = Number(amount)

    if (!id || !Number.isInteger(value) || value === 0) {
      return res.status(400).json({
        ok: false,
        error: 'Invalid telegramId or amount'
      })
    }

    const result = await sql`
      UPDATE users
      SET balance = balance + ${value}
      WHERE telegram_id = ${id}
        AND balance + ${value} >= 0
      RETURNING telegram_id
    `

    if (!result.length) {
      const exists = await sql`
        SELECT telegram_id
        FROM users
        WHERE telegram_id = ${id}
      `

      if (!exists.length) {
        return res.status(404).json({
          ok: false,
          error: 'User not found'
        })
      }

      return res.status(400).json({
        ok: false,
        error: 'Balance cannot be negative'
      })
    }

    const user = await getUser(id)

    res.json({
      ok: true,
      user
    })
  } catch (error) {
    console.error(error)

    res.status(500).json({
      ok: false,
      error: 'Database error'
    })
  }
})

/* =========================
   АДМИН — БЛОКИРОВКА
========================= */

app.post('/api/admin/block', async (req, res) => {
  try {
    const admin = await requireAdmin(req, res)

    if (!admin) return

    const { telegramId, blocked } = req.body

    const id = String(telegramId || '')

    const result = await sql`
      UPDATE users
      SET blocked = ${Boolean(blocked)}
      WHERE telegram_id = ${id}
      RETURNING telegram_id
    `

    if (!result.length) {
      return res.status(404).json({
        ok: false,
        error: 'User not found'
      })
    }

    const user = await getUser(id)

    res.json({
      ok: true,
      user
    })
  } catch (error) {
    console.error(error)

    res.status(500).json({
      ok: false,
      error: 'Database error'
    })
  }
})

/* =========================
   КЕЙСЫ
========================= */

const cases = {
  starter: {
    id: 'starter',
    name: 'Starter Case',
    price: 10,
    reward: {
      id: 'common',
      name: 'Common Gift',
      value: 5
    }
  },

  premium: {
    id: 'premium',
    name: 'Premium Case',
    price: 50,
    reward: {
      id: 'rare',
      name: 'Rare Gift',
      value: 40
    }
  }
}

app.get('/api/cases', (req, res) => {
  res.json({
    ok: true,
    cases
  })
})

/* =========================
   ОТКРЫТИЕ КЕЙСА
========================= */

app.post('/api/cases/open', async (req, res) => {
  try {
    const telegramUser = await requireTelegramUser(req, res)

    if (!telegramUser) return

    const { caseId } = req.body
    const currentCase = cases[caseId]

    if (!currentCase) {
      return res.status(404).json({
        ok: false,
        error: 'Case not found'
      })
    }

    const id = String(telegramUser.id)
    const user = await getUser(id)

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

    const reward = currentCase.reward
    const itemId = crypto.randomUUID()

    await sql`
      UPDATE users
      SET balance = balance - ${currentCase.price}
      WHERE telegram_id = ${id}
        AND balance >= ${currentCase.price}
    `

    await sql`
      INSERT INTO inventory (
        id,
        telegram_id,
        reward_id,
        reward_name,
        value,
        case_name
      )
      VALUES (
        ${itemId},
        ${id},
        ${reward.id},
        ${reward.name},
        ${reward.value},
        ${currentCase.name}
      )
    `

    const updatedUser = await getUser(id)

    const item = updatedUser.inventory.find(
      item => item.id === itemId
    )

    res.json({
      ok: true,
      case: currentCase.name,
      spent: currentCase.price,
      reward: item,
      balance: updatedUser.balance,
      inventory: updatedUser.inventory
    })
  } catch (error) {
    console.error(error)

    res.status(500).json({
      ok: false,
      error: 'Database error'
    })
  }
})
/* =========================
   БЕСПЛАТНАЯ РУЛЕТКА
========================= */

const freeRouletteRewards = [
  {
    id: 'common',
    name: 'Common Gift',
    value: 5
  },
  {
    id: 'common',
    name: 'Common Gift',
    value: 10
  },
  {
    id: 'rare',
    name: 'Rare Gift',
    value: 20
  },
  {
    id: 'epic',
    name: 'Epic Gift',
    value: 50
  },
  {
    id: 'legendary',
    name: 'Legendary Gift',
    value: 100
  }
]

function getRandomRouletteReward() {
  const randomIndex = Math.floor(
    Math.random() * freeRouletteRewards.length
  )

  return freeRouletteRewards[randomIndex]
}

app.post('/api/roulette/free', async (req, res) => {
  try {
    const telegramUser = await requireTelegramUser(req, res)

    if (!telegramUser) return

    const id = String(telegramUser.id)
    const user = await getUser(id)

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

    const existingSpin = await sql`
      SELECT last_spin_at
      FROM roulette_spins
      WHERE telegram_id = ${id}
      LIMIT 1
    `

    if (existingSpin.length) {
      const lastSpin = new Date(existingSpin[0].last_spin_at)

      const nextSpin = new Date(
        lastSpin.getTime() + 24 * 60 * 60 * 1000
      )

      const remaining = nextSpin.getTime() - Date.now()

      if (remaining > 0) {
        return res.status(429).json({
          ok: false,
          error: 'Roulette is on cooldown',
          remainingMs: remaining,
          nextSpinAt: nextSpin.toISOString()
        })
      }
    }

    const reward = getRandomRouletteReward()
    const itemId = crypto.randomUUID()

    await sql`
      INSERT INTO roulette_spins (
        telegram_id,
        last_spin_at
      )
      VALUES (
        ${id},
        NOW()
      )
      ON CONFLICT (telegram_id)
      DO UPDATE SET
        last_spin_at = NOW()
    `

    await sql`
      INSERT INTO inventory (
        id,
        telegram_id,
        reward_id,
        reward_name,
        value,
        case_name
      )
      VALUES (
        ${itemId},
        ${id},
        ${reward.id},
        ${reward.name},
        ${reward.value},
        'Free Roulette'
      )
    `

    const updatedUser = await getUser(id)

    const item = updatedUser.inventory.find(
      item => item.id === itemId
    )

    res.json({
      ok: true,
      reward: item,
      balance: updatedUser.balance,
      inventory: updatedUser.inventory,
      nextSpinAt: new Date(
        Date.now() + 24 * 60 * 60 * 1000
      ).toISOString()
    })
  } catch (error) {
    console.error(error)

    res.status(500).json({
      ok: false,
      error: 'Database error'
    })
  }
})
/* =========================
   ЗАПУСК
========================= */

initDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`VeltoGifts API running on port ${PORT}`)
    })
  })
  .catch(error => {
    console.error('Database initialization failed:', error)
    process.exit(1)
  })
