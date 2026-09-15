import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import crypto from 'crypto'
import { neon } from '@neondatabase/serverless'
import { virtualGifts } from './virtualGifts.js'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 3000

app.use(cors())
app.use(express.json())
app.get('/api/virtual-gifts', (req, res) => {
  res.json({
    ok: true,
    gifts: virtualGifts
  })
})

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not configured')
}

const sql = process.env.DATABASE_URL
  ? neon(process.env.DATABASE_URL)
  : null

/* =========================
   DATABASE
========================= */

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
  `

  await sql`
    CREATE TABLE IF NOT EXISTS promo_codes (
      id UUID PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      reward_stars INTEGER NOT NULL,
      max_activations INTEGER NOT NULL,
      activations_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `

  await sql`
    CREATE TABLE IF NOT EXISTS promo_activations (
      promo_id UUID NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
      telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
      activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (promo_id, telegram_id)
    )
  `

  console.log('PostgreSQL database ready')
}

initDatabase().catch(error => {
  console.error('Database initialization error:', error)
})

/* =========================
   TELEGRAM INIT DATA
========================= */

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

/* =========================
   USERS
========================= */

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

/* =========================
   AUTH
========================= */

async function requireTelegramUser(req, res) {
  const telegramUser = validateTelegramInitData(
    getInitData(req)
  )

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
   ROOT
========================= */

app.get('/', (req, res) => {
  res.json({
    ok: true,
    name: 'VeltoGifts API',
    version: '2.1.0',
    database: 'postgresql'
  })
})

/* =========================
   HEALTH
========================= */

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
   USER
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
   ADMIN CHECK
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
   ADMIN USERS
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
   ADMIN BALANCE
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
   ADMIN BLOCK
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
   CASES
========================= */

const cases = {
  poor: {
    id: 'poor',
    name: '🥔 Бомж',
    price: 50,
    gifts: [
      { giftId: '5170145012310081615', chance: 30 },
      { giftId: '5170233102089322756', chance: 25 },
      { giftId: '5170250947678437525', chance: 20 },
      { giftId: '5168103777563050263', chance: 15 },
      { giftId: '6028601630662853006', chance: 10 }
    ]
  },

  newbie: {
    id: 'newbie',
    name: '🆕 Новенький',
    price: 150,
    gifts: [
      { giftId: '5170250947678437525', chance: 30 },
      { giftId: '5168103777563050263', chance: 25 },
      { giftId: '5170144170496491616', chance: 20 },
      { giftId: '5170314324215857265', chance: 15 },
      { giftId: '5170564780938756245', chance: 10 }
    ]
  },

  rich: {
    id: 'rich',
    name: '💰 Богач',
    price: 300,
    gifts: [
      { giftId: '5170144170496491616', chance: 25 },
      { giftId: '5170314324215857265', chance: 25 },
      { giftId: '5170564780938756245', chance: 20 },
      { giftId: '5168043875654172773', chance: 15 },
      { giftId: '5170690322832818290', chance: 15 }
    ]
  },

  billionaire: {
    id: 'billionaire',
    name: '👑 Миллиардер',
    price: 699,
    gifts: [
      { giftId: '5168043875654172773', chance: 30 },
      { giftId: '5170690322832818290', chance: 25 },
      { giftId: '5170521118301225164', chance: 25 },
      { giftId: '5170564780938756245', chance: 20 }
    ]
  }
}

async function getTelegramGifts() {
  const token = process.env.BOT_TOKEN

  if (!token) {
    throw new Error('BOT_TOKEN is not configured')
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/getAvailableGifts`
  )

  const data = await response.json()

  if (!data.ok) {
    throw new Error(
      data.description || 'Telegram API error'
    )
  }

  return data.result?.gifts || []
}

app.get('/api/telegram/gifts', async (req, res) => {
  try {
    const token = process.env.BOT_TOKEN

    if (!token) {
      return res.status(500).json({
        ok: false,
        error: 'BOT_TOKEN is not configured'
      })
    }

    const response = await fetch(
      `https://api.telegram.org/bot${token}/getAvailableGifts`
    )

    const data = await response.json()

    if (!data.ok) {
      return res.status(500).json({
        ok: false,
        error: data.description || 'Telegram API error'
      })
    }

    const gifts = (data.result?.gifts || []).map((gift) => ({
      id: gift.id,
      name: gift.sticker?.emoji || `Telegram Gift #${gift.id}`,
      emoji: gift.sticker?.emoji || '🎁',
      image: `/api/telegram/gift-image/${encodeURIComponent(gift.id)}`,
      starCount: gift.star_count || 0,
      upgradeStarCount: gift.upgrade_star_count || 0,
      totalCount: gift.total_count || null,
      remainingCount: gift.remaining_count || null,
      background: gift.background || null
    }))

    return res.json({
      ok: true,
      gifts
    })
  } catch (error) {
    console.error('Telegram gifts error:', error)

    return res.status(500).json({
      ok: false,
      error: 'Failed to load Telegram gifts'
    })
  }
})

app.get('/api/telegram/gift-image/:giftId', async (req, res) => {
  try {
    const token = process.env.BOT_TOKEN

    if (!token) {
      return res.status(500).send('BOT_TOKEN is not configured')
    }

    const giftsResponse = await fetch(
      `https://api.telegram.org/bot${token}/getAvailableGifts`
    )

    const giftsData = await giftsResponse.json()

    if (!giftsData.ok) {
      return res.status(500).send('Telegram API error')
    }

    const gift = (giftsData.result?.gifts || []).find(
      (item) => String(item.id) === String(req.params.giftId)
    )

    if (!gift) {
      return res.status(404).send('Gift not found')
    }

    const fileId = gift.sticker?.thumbnail?.file_id

    if (!fileId) {
      return res.status(404).send('Gift image not found')
    }

    const fileResponse = await fetch(
      `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`
    )

    const fileData = await fileResponse.json()

    if (!fileData.ok || !fileData.result?.file_path) {
      return res.status(500).send('Failed to get gift image')
    }

    const imageResponse = await fetch(
      `https://api.telegram.org/file/bot${token}/${fileData.result.file_path}`
    )

    if (!imageResponse.ok) {
      return res.status(500).send('Failed to download gift image')
    }

    const contentType =
      imageResponse.headers.get('content-type') || 'image/jpeg'

    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer())

    res.setHeader('Content-Type', contentType)
    res.setHeader('Cache-Control', 'public, max-age=3600')

    return res.send(imageBuffer)
  } catch (error) {
    console.error('Telegram gift image error:', error)
    return res.status(500).send('Failed to load gift image')
  }
})
app.get('/api/cases', (req, res) => {
  res.json({
    ok: true,
    cases
  })
})

/* =========================
   OPEN CASE
========================= */

app.post('/api/cases/open', async (req, res) => {
  try {
    const telegramUser = await requireTelegramUser(req, res)

    if (!telegramUser) return

    const caseId = String(req.body?.caseId || '').trim().toLowerCase()
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

    const telegramGifts = await getTelegramGifts()

const weightedGifts = currentCase.gifts
  .map(item => {
    const gift = telegramGifts.find(
      g => String(g.id) === String(item.giftId)
    )

    return gift ? { gift, chance: item.chance } : null
  })
  .filter(Boolean)

const totalChance = weightedGifts.reduce(
  (sum, item) => sum + item.chance,
  0
)

let random = Math.random() * totalChance
let selectedGift = null

for (const item of weightedGifts) {
  random -= item.chance

  if (random <= 0) {
    selectedGift = item.gift
    break
  }
}

if (!selectedGift) {
  return res.status(404).json({
    ok: false,
    error: 'Telegram Gifts are currently unavailable'
  })
}

const reward = giftToReward(selectedGift)
    const itemId = crypto.randomUUID()

    const updated = await sql`
      UPDATE users
      SET balance = balance - ${currentCase.price}
      WHERE telegram_id = ${id}
        AND balance >= ${currentCase.price}
      RETURNING telegram_id
    `

    if (!updated.length) {
      return res.status(400).json({
        ok: false,
        error: 'Not enough balance'
      })
    }

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
   FREE ROULETTE
========================= */

function giftToReward(gift) {
  return {
    id: String(gift.id),
    name: gift.sticker?.emoji || `Telegram Gift #${gift.id}`,
    value: Number(gift.star_count || 0),
    image: `/api/telegram/gift-image/${encodeURIComponent(gift.id)}`,
    telegramGiftId: String(gift.id),
    starCount: Number(gift.star_count || 0),
    upgradeStarCount: Number(gift.upgrade_star_count || 0)
  }
}

async function getRandomRouletteReward() {
  const telegramGifts = await getTelegramGifts()

  if (!telegramGifts.length) {
    throw new Error(
      'Telegram Gifts are currently unavailable'
    )
  }

  const available = telegramGifts.filter(
    gift => Number(gift.star_count || 0) > 0
  )

  if (!available.length) {
    throw new Error(
      'No Telegram Gifts available'
    )
  }

  const selectedGift =
    available[
      Math.floor(
        Math.random() * available.length
      )
    ]

  return giftToReward(selectedGift)
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
      const lastSpin = new Date(
        existingSpin[0].last_spin_at
      )

      const nextSpin = new Date(
        lastSpin.getTime() + 24 * 60 * 60 * 1000
      )

      const remaining =
        nextSpin.getTime() - Date.now()

      if (remaining > 0) {
        return res.status(429).json({
          ok: false,
          error: 'Roulette is on cooldown',
          remainingMs: remaining,
          nextSpinAt: nextSpin.toISOString()
        })
      }
    }

    const reward = await getRandomRouletteReward()
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
   PROMO CODES
========================= */

/*
  Создание через Telegram:

  /addpromo VELTO100 50 100

  VELTO100 = код
  50       = максимальное количество активаций
  100      = награда VeltoStars
*/

async function createPromoCode(code, maxActivations, rewardStars) {
  const normalizedCode = code
    .trim()
    .toUpperCase()

  const result = await sql`
    INSERT INTO promo_codes (
      id,
      code,
      reward_stars,
      max_activations
    )
    VALUES (
      ${crypto.randomUUID()},
      ${normalizedCode},
      ${rewardStars},
      ${maxActivations}
    )
    RETURNING
      id,
      code,
      reward_stars,
      max_activations,
      activations_count,
      created_at
  `

  return result[0]
}

/* =========================
   TELEGRAM BOT API
========================= */

async function telegramRequest(method, body) {
  if (!process.env.BOT_TOKEN) {
    throw new Error('BOT_TOKEN is not configured')
  }

  const response = await fetch(
    `https://api.telegram.org/bot${process.env.BOT_TOKEN}/${method}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }
  )

  const data = await response.json()

  if (!data.ok) {
    throw new Error(
      data.description || 'Telegram API error'
    )
  }

  return data
}

async function sendTelegramMessage(chatId, text) {
  return telegramRequest('sendMessage', {
    chat_id: chatId,
    text
  })
}

/* =========================
   TELEGRAM WEBHOOK
========================= */

app.post('/api/promo/activate', async (req, res) => {
  try {
    const telegramUser = await requireTelegramUser(req, res)

if (!telegramUser) {
  return
}

const telegramId = telegramUser.id
    const code = String(req.body?.code || '').trim().toUpperCase()

    if (!code) {
      return res.status(400).json({
        ok: false,
        error: 'Введите промокод'
      })
    }

    const promoResult = await sql`
      SELECT
        id,
        code,
        reward_stars,
        max_activations,
        activations_count
      FROM promo_codes
      WHERE UPPER(code) = ${code}
      LIMIT 1
    `

    if (promoResult.length === 0) {
      return res.status(404).json({
        ok: false,
        error: 'Промокод не найден'
      })
    }

    const promo = promoResult[0]

    if (promo.activations_count >= promo.max_activations) {
      return res.status(400).json({
        ok: false,
        error: 'Лимит активаций промокода исчерпан'
      })
    }

    const existing = await sql`
      SELECT 1
      FROM promo_activations
      WHERE promo_id = ${promo.id}
        AND telegram_id = ${telegramId}
      LIMIT 1
    `

    if (existing.length > 0) {
      return res.status(400).json({
        ok: false,
        error: 'Вы уже активировали этот промокод'
      })
    }

    await sql`
      INSERT INTO promo_activations (
        promo_id,
        telegram_id
      )
      VALUES (
        ${promo.id},
        ${telegramId}
      )
    `

    const updatedUser = await sql`
  UPDATE users
  SET balance = balance + ${promo.reward_stars}
  WHERE telegram_id = ${telegramId}
  RETURNING balance
`

if (updatedUser.length === 0) {
  throw new Error('User not found')
}

    return res.json({
  ok: true,
  message: 'Промокод успешно активирован',
  rewardStars: promo.reward_stars,
  balance: updatedUser[0].balance
})
  } catch (error) {
    console.error('Promo activation error:', error)

    return res.status(500).json({
      ok: false,
      error: 'Не удалось активировать промокод'
    })
  }
})

app.post('/api/telegram/webhook', async (req, res) => {
  try {
    const update = req.body

    if (!update || !update.message) {
      return res.json({
        ok: true
      })
    }

    const message = update.message
    const chatId = message.chat?.id
    const fromId = message.from?.id
    const text = String(message.text || '').trim()

    if (!chatId || !fromId) {
      return res.json({
        ok: true
      })
    }

    /* =========================
       START
    ========================= */

    if (text === '/start') {
      await sendTelegramMessage(
        chatId,
        '🎁 VeltoGifts\n\nОткрой Mini App через кнопку меню бота.'
      )

      return res.json({
        ok: true
      })
    }

    /* =========================
       ADD PROMO
    ========================= */

    if (
      text === '/addpromo' ||
      text.startsWith('/addpromo ')
    ) {
      const adminId = String(
        process.env.ADMIN_TELEGRAM_ID || ''
      )

      if (String(fromId) !== adminId) {
        await sendTelegramMessage(
          chatId,
          '⛔ У тебя нет прав для создания промокодов.'
        )

        return res.json({
          ok: true
        })
      }

      const parts = text.split(/\s+/)

      if (parts.length !== 4) {
        await sendTelegramMessage(
          chatId,
          '❌ Неверный формат.\n\nИспользуй:\n/addpromo VELTO100 50 100\n\nГде:\nVELTO100 — код\n50 — количество активаций\n100 — награда в VeltoStars'
        )

        return res.json({
          ok: true
        })
      }

      const code = parts[1]
      const maxActivations = Number(parts[2])
      const rewardStars = Number(parts[3])

      if (
        !/^[A-Za-z0-9_-]{3,32}$/.test(code)
      ) {
        await sendTelegramMessage(
          chatId,
          '❌ Код должен содержать от 3 до 32 символов: латинские буквы, цифры, _ или -.'
        )

        return res.json({
          ok: true
        })
      }

      if (
        !Number.isInteger(maxActivations) ||
        maxActivations <= 0
      ) {
        await sendTelegramMessage(
          chatId,
          '❌ Количество активаций должно быть целым числом больше 0.'
        )

        return res.json({
          ok: true
        })
      }

      if (
        !Number.isInteger(rewardStars) ||
        rewardStars <= 0
      ) {
        await sendTelegramMessage(
          chatId,
          '❌ Награда должна быть целым числом больше 0.'
        )

        return res.json({
          ok: true
        })
      }

      try {
        const promo = await createPromoCode(
          code,
          maxActivations,
          rewardStars
        )

        await sendTelegramMessage(
          chatId,
          `✅ Промокод создан!\n\n🎟 Код: ${promo.code}\n⭐ Награда: ${promo.reward_stars} VeltoStars\n👥 Активаций: 0/${promo.max_activations}`
        )
      } catch (error) {
        console.error(
          'Create promo error:',
          error
        )

        if (
          String(error.message || '').includes(
            'duplicate'
          )
        ) {
          await sendTelegramMessage(
            chatId,
            '❌ Такой промокод уже существует.'
          )
        } else {
          await sendTelegramMessage(
            chatId,
            '❌ Не удалось создать промокод.'
          )
        }
      }

      return res.json({
        ok: true
      })
    }

    /* =========================
       UNKNOWN COMMAND
    ========================= */

    if (text.startsWith('/')) {
      await sendTelegramMessage(
        chatId,
        'Неизвестная команда.\n\nДоступно:\n/start\n/addpromo VELTO100 50 100'
      )
    }

    res.json({
      ok: true
    })
  } catch (error) {
    console.error(
      'Telegram webhook error:',
      error
    )

    /*
      Telegram должен получить HTTP 200,
      чтобы не отправлять один и тот же update
      бесконечно.
    */

    res.json({
      ok: true
    })
  }
})

/* =========================
   DEBUG TABLES
========================= */

app.get('/api/debug/tables', async (req, res) => {
  try {
    const tables = await sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `

    res.json({
      ok: true,
      tables: tables.map(row => row.table_name)
    })
  } catch (error) {
    console.error(
      'Debug tables error:',
      error
    )

    res.status(500).json({
      ok: false,
      error: error.message
    })
  }
})

/* =========================
   DEBUG CREATE ROULETTE
========================= */

app.get(
  '/api/debug/create-roulette-table',
  async (req, res) => {
    try {
      await sql`
        CREATE TABLE IF NOT EXISTS roulette_spins (
          telegram_id BIGINT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
          last_spin_at TIMESTAMPTZ NOT NULL
        )
      `

      res.json({
        ok: true,
        message: 'roulette_spins created'
      })
    } catch (error) {
      console.error(
        'Create roulette table error:',
        error
      )

      res.status(500).json({
        ok: false,
        error: error.message
      })
    }
  }
)

/* =========================
   VERCEL
========================= */

export default app

app.get('/api/debug/create-promo-tables', async (req, res) => {
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS promo_codes (
        id UUID PRIMARY KEY,
        code TEXT UNIQUE NOT NULL,
        reward_stars INTEGER NOT NULL,
        max_activations INTEGER NOT NULL,
        activations_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `

    await sql`
      CREATE TABLE IF NOT EXISTS promo_activations (
        promo_id UUID NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
        telegram_id BIGINT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
        activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (promo_id, telegram_id)
      )
    `

    res.json({
      ok: true,
      message: 'Promo tables created'
    })
  } catch (error) {
    console.error(error)

    res.status(500).json({
      ok: false,
      error: error.message
    })
  }
})/* =========================
   LOCAL SERVER
========================= */

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(
      `VeltoGifts API running on port ${PORT}`
    )
  })
}
