# Reel Atlas

Map locations from TikTok and Instagram reels using AI.

## Setup (GitHub + Railway)

### 1. Create a GitHub repo
- Go to github.com → New repository → name it `reel-atlas`
- Upload these files maintaining this structure:
  ```
  reel-atlas/
  ├── server.js
  ├── package.json
  └── public/
      └── index.html
  ```

### 2. Deploy on Railway
- Go to railway.app → New Project → Deploy from GitHub repo
- Select your `reel-atlas` repo
- Railway will auto-detect it's a Node.js app and deploy it

### 3. Set environment variables in Railway
Go to your Railway project → Variables → Add these:

| Variable | Value | Required |
|---|---|---|
| `ANTHROPIC_API_KEY` | Your key from platform.anthropic.com | Yes |
| `RAPIDAPI_KEY` | Your key from rapidapi.com | Only for Instagram |

### 4. Get your API keys

**Anthropic (Claude AI) — required:**
1. Go to platform.anthropic.com
2. Sign up → API Keys → Create Key
3. Add credits (pay-as-you-go, ~$0.01 per video analyzed)

**RapidAPI (Instagram scraping) — only if you want Instagram:**
1. Go to rapidapi.com → sign up (free)
2. Search "Instagram Scraper API2"
3. Subscribe to the free tier → copy your API key

### 5. Access the app
Railway gives you a public URL like `https://reel-atlas-production.up.railway.app`
That URL is your web app — share it with anyone.

## How it works
1. Paste a TikTok or Instagram URL → hit Enter or "Map It"
2. Server fetches the video caption automatically
3. Claude AI extracts every location mentioned
4. Locations are geocoded and pinned on the map
5. Click any card in the sidebar to fly the map to that reel's locations

## Supported platforms
- ✅ TikTok (free, no extra key needed)
- ✅ Instagram Reels (requires RapidAPI key)

## Notes
- Videos with no caption or very vague captions won't return locations
- Private videos cannot be scraped
- Location index resets on page refresh (no database yet)
