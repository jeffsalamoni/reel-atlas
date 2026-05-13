const express = require('express');
const fetch   = require('node-fetch');
const path    = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ANTHROPIC_KEY    = process.env.ANTHROPIC_API_KEY;
const RAPIDAPI_KEY     = process.env.RAPIDAPI_KEY;
const GOOGLE_MAPS_KEY  = process.env.GOOGLE_MAPS_API_KEY;
const EXPEDIA_AFF_CODE = process.env.EXPEDIA_AFFILIATE_CODE || 'ItV4cGh';

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

// ── Expedia Affiliate URL Builder ──────────────────────
function buildAffiliateLinks(city) {
  if (!city) return null;
  const slug = city.toLowerCase().trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
  if (!slug) return null;
  const base = 'https://expedia.com/affiliates';
  const code = EXPEDIA_AFF_CODE;
  return {
    hotels: `${base}/${slug}-hotels.${code}`,
    cars:   `${base}/${slug}-car-rentals.${code}`,
  };
}

// ── Google Places: Text Search + Place Details ─────────
// Text Search gives us coords, rating, types.
// Place Details gives us address_components (needed for city).
async function getPlaceDetails(query) {
  if (!GOOGLE_MAPS_KEY) throw new Error('GOOGLE_MAPS_API_KEY is not set in Railway Variables.');

  // Step 1: Text Search
  const searchRes  = await fetch(
    `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${GOOGLE_MAPS_KEY}`
  );
  const searchData = await searchRes.json();
  if (searchData.status !== 'OK' || !searchData.results?.length) return null;

  const p = searchData.results[0];

  // Step 2: Place Details — fetch address_components for accurate city extraction
  // (Text Search does not return address_components)
  const detailRes  = await fetch(
    `https://maps.googleapis.com/maps/api/place/details/json?place_id=${p.place_id}&fields=address_components&key=${GOOGLE_MAPS_KEY}`
  );
  const detailData = await detailRes.json();
  const comps      = detailData.result?.address_components || [];

  // 'locality' is the city in most countries; fall back to postal_town or admin_area_level_2
  const cityComp = comps.find(c => c.types.includes('locality'))
    || comps.find(c => c.types.includes('postal_town'))
    || comps.find(c => c.types.includes('administrative_area_level_2'));
  const city = cityComp?.long_name || '';

  return {
    name:        p.name,
    lat:         p.geometry.location.lat,
    lon:         p.geometry.location.lng,
    rating:      p.rating             ?? null,
    ratingCount: p.user_ratings_total ?? null,
    types:       p.types              ?? [],
    address:     p.formatted_address  ?? '',
    city,
    placeId:     p.place_id,
    mapsUrl:     `https://www.google.com/maps/place/?q=place_id:${p.place_id}`,
    affiliate:   buildAffiliateLinks(city),
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

app.get('/ping', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Reel Atlas live on port ${PORT}`));
