# VOIDMAIL

> Anonymous disposable inbox system with realtime OTP interception, cyberpunk UI, and GuerrillaMail-powered backend.

![VOIDMAIL Banner](https://img.shields.io/badge/VOIDMAIL-CYBERPUNK-red?style=for-the-badge)
![Vercel](https://img.shields.io/badge/Deploy-Vercel-black?style=for-the-badge&logo=vercel)
![Node.js](https://img.shields.io/badge/Node.js-18.x-green?style=for-the-badge&logo=node.js)
![Status](https://img.shields.io/badge/STATUS-ONLINE-red?style=for-the-badge)

---

## ✨ Features

- ⚡ Disposable email generation
- 📩 Realtime inbox polling
- 🔑 Automatic OTP code detection
- 📋 One-click OTP copy
- 📬 Full message viewer modal
- 🌌 Cyberpunk animated UI
- 🎨 Three.js particle background
- 🔄 Auto-refresh system
- 💾 Session persistence with localStorage
- 🚫 GuerrillaMail welcome-email filtering
- 📱 Responsive mobile layout
- ☁️ Vercel serverless deployment
- 🔐 Anonymous inbox system

---

# 📸 Preview

## Main Interface

- Realtime disposable inbox
- Neon cyberpunk styling
- Animated status indicators
- Live refresh countdown

## OTP Interception

VOIDMAIL automatically detects:
- verification codes
- login OTPs
- authentication PINs

and exposes them instantly inside:
- inbox cards
- OTP banners
- modal viewer

---

# 🏗️ Architecture

```txt
Frontend
 ├── index.html
 ├── style.css
 ├── script.js
 └── Three.js effects

Backend
 └── api/proxy.js

Provider
 └── GuerrillaMail Public API
```

---

# ⚙️ Tech Stack

## Frontend
- HTML5
- CSS3
- Vanilla JavaScript
- Three.js

## Backend
- Node.js
- Vercel Serverless Functions

## Email Provider
- GuerrillaMail Public API

---

# 🚀 Deployment

## 1. Clone Repository

```bash
git clone https://github.com/YOUR_USERNAME/voidmail.git
cd voidmail
```

---

## 2. Install Vercel CLI

```bash
npm install -g vercel
```

---

## 3. Deploy

```bash
vercel
```

---

# 📁 Project Structure

```txt
VOIDMAIL/
│
├── api/
│   └── proxy.js
│
├── index.html
├── style.css
├── script.js
├── vercel.json
└── README.md
```

---

# 🔥 Core Features Explained

## Temporary Email Generation

VOIDMAIL generates anonymous disposable inboxes through GuerrillaMail's public API.

```txt
Frontend
   ↓
/api/proxy
   ↓
GuerrillaMail API
```

---

## Session Persistence

The backend maps sessions using:

```js
sid → { phpsessid, email, seq }
```

This preserves inbox continuity during polling.

---

## OTP Detection

VOIDMAIL automatically scans:
- subject
- preview
- full email body

for OTP patterns using regex detection.

Example:

```js
/\b\d{4,8}\b/g
```

---

## Realtime Polling

Features:
- anti-overlap request protection
- visibility pause handling
- countdown timer
- auto refresh cycle
- session auto-recovery

---

# 🎨 UI Features

- Cyberpunk design language
- Neon glow effects
- Animated scanlines
- Noise grain overlay
- Glitch hover animations
- Realtime status indicators
- Particle background system
- Modal transitions
- OTP pulse effects

---

# 🔒 Privacy

VOIDMAIL:
- stores no accounts
- requires no signup
- uses disposable sessions
- does not permanently save inboxes

---

# ⚠️ Limitations

Current session storage uses:

```js
const sessions = new Map();
```

Because of Vercel serverless behavior:
- sessions reset on cold starts
- inboxes are temporary
- persistence is limited

For production-scale persistence:
- Upstash Redis
- Vercel KV
- Supabase
- Redis

are recommended.

---

# 🛠️ Future Improvements

Planned features:
- custom domains
- websocket live updates
- inbox search
- delete mail
- attachment viewer
- dark/light themes
- Redis persistence
- browser notifications
- matrix rain mode
- AI spam detection

---

# 📜 API Routes

## Generate Inbox

```http
GET /api/proxy?action=generate
```

Response:

```json
{
  "email": "example@sharklasers.com",
  "sid": "session_token"
}
```

---

## Fetch Inbox

```http
GET /api/proxy?action=inbox&sid=SESSION_ID
```

---

## Read Full Email

```http
GET /api/proxy?action=read&sid=SESSION_ID&email_id=MAIL_ID
```

---

# 🧠 Credits

## GuerrillaMail
Public temporary email provider:
https://www.guerrillamail.com/

## Three.js
3D rendering engine:
https://threejs.org/

---

# 📄 License

MIT License

---

# ⚡ VOIDMAIL

> NO LOGS. NO TRACE. NO MERCY.
