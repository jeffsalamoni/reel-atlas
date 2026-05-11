const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;
const RAPIDAPI_KEY    = process.env.RAPIDAPI_KEY;
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;

// ── Platform Detection ─────────────────────────────────
function detectPlatform(url) {
  if (url.includes('tiktok.com') || url.includes('vm.tiktok.com')) return 'tiktok';
  if (url.includes('instagram.com'))                                return 'instagram';
  return null;
}

// ── TikTok Scraper (free, no key) ─────────────────────
async function scrapeTikTok(url) {
  const res  = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`);
  const data = await res.json();
  if (data.code === 0 && data.data?.title) {
    return { caption: data.data.title, author: data.data.author?.nickname || '' };
  }
  throw new Error('Could not fetch TikTok data. The video may be private or the URL invalid.');
}

// ── Instagram Scraper (RapidAPI) ───────────────────────
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

// ── Google Places: Text Search → rich place data ───────
async function getPlaceDetails(query) {
  if (!GOOGLE_MAPS_KEY) throw new Error('GOOGLE_MAPS_API_KEY is not set in Railway Variables.');

  const res  = await fetch(
    `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${GOOGLE_MAPS_KEY}`
  );
  const data = await res.json();

  if (data.status !== 'OK' || !data.results?.length) return null;

  const p = data.results[0];
  return {
    name:        p.name,
    lat:         p.geometry.location.lat,
    lon:         p.geometry.location.lng,
    rating:      p.rating             ?? null,
    ratingCount: p.user_ratings_total ?? null,
    types:       p.types              ?? [],
    address:     p.formatted_address  ?? '',
    placeId:     p.place_id,
    mapsUrl:     `https://www.google.com/maps/place/?q=place_id:${p.place_id}`
  };
}

// ── POST /analyze ──────────────────────────────────────
app.post('/analyze', async (req, res) => {
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
          const place = await getPlaceDetails(query).catch(() => null);
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

app.get('/ping', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Reel Atlas live on port ${PORT}`));
