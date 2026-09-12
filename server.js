import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 3000

app.use(cors())
app.use(express.json())

const users = new Map()

app.get('/', (req, res) => {
  res.json({
    ok: true,
    name: 'VeltoGifts API',
    version: '1.0.0'
  })
})

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    message: 'VeltoGifts API is running'
  })
})

app.post('/api/user', (req, res) => {
  const { telegramId, username, firstName } = req.body

  if (!telegramId) {
    return res.status(400).json({
      ok: false,
      error: 'telegramId is required'
    })
  }

  const id = String(telegramId)

  if (!users.has(id)) {
    users.set(id, {
      telegramId: id,
      username: username || '',
      firstName: firstName || '',
      balance: 0,
      blocked: false,
      inventory: []
    })
  }

  const user = users.get(id)

  res.json({
    ok: true,
    user
  })
})

app.get('/api/admin/check', (req, res) => {
  const telegramId = String(req.query.telegramId || '')
  const adminId = String(process.env.ADMIN_TELEGRAM_ID || '')

  res.json({
    ok: true,
    isAdmin: telegramId !== '' && telegramId === adminId
  })
})

app.listen(PORT, () => {
  console.log(`VeltoGifts API running on port ${PORT}`)
})
