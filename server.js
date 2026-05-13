const express    = require('express');
const fetch      = require('node-fetch');
const path       = require('path');
const rateLimit  = require('express-rate-limit');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Env ────────────────────────────────────────────────
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;
const RAPIDAPI_KEY    = process.env.RAPIDAPI_KEY;
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;
const EXP_CAMREF      = process.env.EXPEDIA_CAMREF      || '1011l5J2sw';
const EXP_CREATIVE    = process.env.EXPEDIA_CREATIVEREF || '1100l68075';
const EXP_ADREF       = process.env.EXPEDIA_ADREF       || 'PZoIW2sGmc';
const MONTHLY_CAP     = parseInt(process.env.MONTHLY_CAP || '500', 10);

// ── Global usage counter ───────────────────────────────
// Resets automatically on the 1st of each month.
// When you add a database later, replace this with a DB-backed counter.
const usage = {
  count:    0,
  month:    new Date().getMonth(),
  year:     new Date().getFullYear(),
};

function checkAndIncrementUsage() {
  const now = new Date();
  // Reset on new month
  if (now.getMonth() !== usage.month || now.getFullYear() !== usage.year) {
    usage.count = 0;
    usage.month = now.getMonth();
    usage.year  = now.getFullYear();
    console.log('[usage] Monthly counter reset');
  }
  if (usage.count >= MONTHLY_CAP) return false;
  usage.count++;
  console.log(`[usage] ${usage.count}/${MONTHLY_CAP} this month`);
  return true;
}

// ── IP Rate Limiter — 50 requests per IP per hour ──────
const analyzeRateLimit = rateLimit({
  windowMs:         60 * 60 * 1000,   // 1 hour
  max:              50,
  standardHeaders:  true,
  legacyHeaders:    false,
  message: {
    error: 'Too many requests — you\'ve hit the hourly limit of 50 analyses. Try again in an hour.'
  },
  handler: (req, res, next, options) => {
    console.warn(`[rate-limit] IP blocked: ${req.ip}`);
    res.status(429).json(options.message);
  }
});

// ── Platform Detection ─────────────────────────────────
function detectPlatform(url) {
  if (url.includes('tiktok.com') || url.includes('vm.tiktok.com')) return 'tiktok';
  if (url.includes('instagram.com'))                                return 'instagram';
  return null;
}

// ── TikTok Scraper ─────────────────────────────────────
async function scrapeTikTok(url) {
  const res  = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`);
  const data = await res.json();
  if (data.code === 0 && data.data?.title) {
    return { caption: data.data.title, author: data.data.author?.nickname || '' };
  }
  throw new Error('Could not fetch TikTok data. The video may be private or the URL invalid.');
}

// ── Instagram Scraper ──────────────────────────────────
async function scrapeInstagram(url) {
  if (!RAPIDAPI_KEY) throw new Error('Instagram requires RAPIDAPI_KEY in Railway Variables.');
  const res  = await fetch(
    `https://instagram-scraper-api2.p.rapidapi.com/v1/post_info?code_or_id_or_url=${encodeURIComponent(url)}`,
    { headers: { 'X-RapidAPI-Key': RAPIDAPI_KEY, 'X-RapidAPI-Host': 'instagram-scraper-api2.p.rapidapi.com' } }
  );
  const data    = await res.json();
  const caption = data?.data?.caption_text || data?.data?.edge_media_to_caption?.edges?.[0]?.node?.text || '';
  if (!caption) throw new Error('Could not extract Instagram caption. Post may be private.');
  return { caption };
}

// ── AI Location Extraction ─────────────────────────────
async function extractLocations(caption, platform) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{
        role:    'user',
        content: `Extract all specific, searchable locations from this ${platform} caption.

Caption: "${caption}"

Include restaurants, cafes, bars, shops, landmarks, neighborhoods, streets, cities.
Be as specific as possible — include city and country when you can infer them.
Example output: ["Da Enzo al 29, Rome, Italy", "Trastevere, Rome, Italy", "Colosseum, Rome, Italy"]

Return ONLY a valid JSON array of location strings. No explanation, no markdown.
If no real locations found, return: []`
      }]
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || 'Claude API error — check your ANTHROPIC_API_KEY.');
  }

  const data = await res.json();
  const raw  = data.content[0].text.trim().replace(/```json|```/g, '').trim();
  return JSON.parse(raw);
}

// ── Expedia Affiliate Links ────────────────────────────
function buildAffiliateLinks(city, lat, lon) {
  if (!city) return null;
  const affBase  = 'https://expedia.com/affiliate';
  const tracking = `siteid=1&camref=${EXP_CAMREF}&creativeref=${EXP_CREATIVE}&adref=${EXP_ADREF}`;
  const hotelDest = encodeURIComponent(`https://www.expedia.com/Hotel-Search?destination=${encodeURIComponent(city)}`);
  const carDest   = encodeURIComponent(`https://www.expedia.com/carsearch?locn=${encodeURIComponent(city)}&olat=${lat}&olon=${lon}`);
  return {
    hotels: `${affBase}?${tracking}&landingPage=${hotelDest}`,
    cars:   `${affBase}?${tracking}&landingPage=${carDest}`,
  };
}

// ── Google Places ──────────────────────────────────────
async function getPlaceDetails(query) {
  if (!GOOGLE_MAPS_KEY) throw new Error('GOOGLE_MAPS_API_KEY is not set in Railway Variables.');

  const searchRes  = await fetch(
    `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${GOOGLE_MAPS_KEY}`
  );
  const searchData = await searchRes.json();
  if (searchData.status !== 'OK' || !searchData.results?.length) return null;

  const p   = searchData.results[0];
  const lat = p.geometry.location.lat;
  const lon = p.geometry.location.lng;

  const detailRes  = await fetch(
    `https://maps.googleapis.com/maps/api/place/details/json?place_id=${p.place_id}&fields=address_components&key=${GOOGLE_MAPS_KEY}`
  );
  const detailData = await detailRes.json();
  const comps      = detailData.result?.address_components || [];

  const cityComp = comps.find(c => c.types.includes('locality'))
    || comps.find(c => c.types.includes('postal_town'))
    || comps.find(c => c.types.includes('administrative_area_level_2'));
  const city = cityComp?.long_name || '';

  return {
    name:        p.name,
    lat,
    lon,
    rating:      p.rating             ?? null,
    ratingCount: p.user_ratings_total ?? null,
    types:       p.types              ?? [],
    address:     p.formatted_address  ?? '',
    city,
    placeId:     p.place_id,
    mapsUrl:     `https://www.google.com/maps/place/?q=place_id:${p.place_id}`,
    affiliate:   buildAffiliateLinks(city, lat, lon),
  };
}

// ── POST /analyze ──────────────────────────────────────
app.post('/analyze', analyzeRateLimit, async (req, res) => {
  // Check global monthly cap before doing anything expensive
  if (!checkAndIncrementUsage()) {
    console.warn('[usage] Monthly cap reached');
    return res.status(429).json({
      error: `This app has reached its monthly usage limit. Check back next month, or contact the owner.`
    });
  }

  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required.' });

  const platform = detectPlatform(url);
  if (!platform) return res.status(400).json({ error: 'Only TikTok and Instagram URLs are supported.' });

  try {
    const content = platform === 'tiktok'
      ? await scrapeTikTok(url)
      : await scrapeInstagram(url);

    if (!content?.caption?.trim()) {
      return res.status(400).json({ error: 'No caption found — video may be private or have no description.' });
    }

    const locationNames = await extractLocations(content.caption, platform);

    const locations = (
      await Promise.all(
        locationNames.map(async query => {
          const place = await getPlaceDetails(query).catch(err => {
            console.warn(`[places] failed for "${query}":`, err.message);
            return null;
          });
          return place ? { query, place } : null;
        })
      )
    ).filter(Boolean);

    res.json({ url, platform, caption: content.caption, author: content.author || null, locations });

  } catch (err) {
    console.error('[analyze]', err.message);
    res.status(500).json({ error: err.message || 'Analysis failed.' });
  }
});

// ── GET /usage — check current usage (optional admin use) ──
app.get('/usage', (req, res) => {
  const now = new Date();
  res.json({
    count:     usage.count,
    cap:       MONTHLY_CAP,
    remaining: Math.max(0, MONTHLY_CAP - usage.count),
    month:     now.toLocaleString('default', { month: 'long', year: 'numeric' }),
    resetsOn:  `${now.getFullYear()}-${String(now.getMonth() + 2).padStart(2,'0')}-01`,
  });
});

app.get('/ping', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Reel Atlas live on port ${PORT}`));
