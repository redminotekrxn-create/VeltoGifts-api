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

  if (!hash) {
    return null
  }

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

  if (calculatedHash !== hash) {
    return null
  }

  const authDate = Number(params.get('auth_date'))

  if (!authDate) {
    return null
  }

  const age = Math.floor(Date.now() / 1000) - authDate

  if (age > 86400 || age < 0) {
    return null
  }

  const userJson = params.get('user')

  if (!userJson) {
    return null
  }

  try {
    return JSON.parse(userJson)
  } catch {
    return null
  }
}

app.get('/', (req, res) => {
  res.json({
    ok: true,
    name: 'VeltoGifts API',
    version: '1.1.0'
  })
})

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    message: 'VeltoGifts API is running'
  })
})

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

app.get('/api/admin/check', (req, res) => {
  const initData = req.headers['x-telegram-init-data']

  const telegramUser = validateTelegramInitData(initData)

  if (!telegramUser) {
    return res.status(401).json({
      ok: false,
      error: 'Invalid Telegram initData'
    })
  }

  const adminId = String(process.env.ADMIN_TELEGRAM_ID || '')

  res.json({
    ok: true,
    isAdmin: String(telegramUser.id) === adminId
  })
})

app.listen(PORT, () => {
  console.log(`VeltoGifts API running on port ${PORT}`)
})
