# Lather.AI Backend

Node.js/Express API that proxies Anthropic calls and enforces per-device scan limits.

## Local development

```bash
npm install
cp .env.example .env
# Fill in ANTHROPIC_API_KEY and APP_SECRET in .env
npm run dev
```

Server runs at http://localhost:3000

## Deploy to Railway (recommended free option)

1. Push this folder to a GitHub repo (can be private)
2. Go to https://railway.app and create a new project
3. Select "Deploy from GitHub repo" and connect your repo
4. In Railway dashboard → Variables, add:
   - `ANTHROPIC_API_KEY` = your Anthropic key (sk-ant-...)
   - `APP_SECRET` = a long random string (make one up, e.g. `la_k9x2mq4p7r3abc`)
5. Railway auto-deploys. Copy the generated URL (e.g. `https://latherai-backend.up.railway.app`)
6. In the app's `src/utils/aiAnalysis.js`, update `BACKEND_URL` to this URL
7. Set the same `APP_SECRET` value in `src/utils/aiAnalysis.js` as `APP_SECRET` constant

## Update the app secret

The `APP_SECRET` must match in two places:
- Railway environment variable
- `APP_SECRET` constant in `LatherApp/src/utils/aiAnalysis.js`

## Endpoints

| Method | Path | Description |
|---|---|---|
| POST | /api/analyze-image | Camera scan — vision AI analysis |
| POST | /api/analyze-text | Text ingredient analysis |
| POST | /api/parse-skin | Parse plain-English skin description |
| POST | /api/alternatives | Fetch AI product alternatives |
| GET | /api/scan/status?deviceId=xxx | Check remaining scans |
| GET | /health | Health check |

## Scan limits

20 scans per device per month. Tracked in-memory — resets on server restart.
For persistence across restarts, replace the in-memory Map with a Redis store later.
