const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());

const port = process.env.PORT || 3000;

// osu! credentials
const client_id = '41700';
const client_secret = '2gBS9LgMq8uuo5tp6WlOsBaRTQSiJCzIYiFxKK2q';

let access_token = null;
let token_expiry = 0;

// ⏱️ Format seconds to MM:SS
function formatSeconds(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// 🧠 Get osu! API token
async function getAccessToken() {
  const now = Date.now();
  if (access_token && now < token_expiry) return access_token;

  const response = await axios.post('https://osu.ppy.sh/oauth/token', {
    client_id,
    client_secret,
    grant_type: 'client_credentials',
    scope: 'public'
  });

  access_token = response.data.access_token;
  token_expiry = now + (response.data.expires_in * 1000) - 10000;
  return access_token;
}

// ✅ Beatmap info route
app.get('/api/beatmap/:id', async (req, res) => {
  try {
    const token = await getAccessToken();
    const id = req.params.id;

    const response = await axios.get(`https://osu.ppy.sh/api/v2/beatmaps/${id}`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const bm = response.data;

    const data = {
      id: bm.id,
      title: `${bm.beatmapset.artist} - ${bm.beatmapset.title} (${bm.beatmapset.creator})`,
      stars: `${bm.difficulty_rating.toFixed(1)}★`,
      cs: bm.cs,
      ar: bm.ar,
      od: bm.accuracy,
      bpm: bm.bpm,
      length: formatSeconds(bm.total_length), // ✅ Added length here
      url: `https://osu.ppy.sh/beatmapsets/${bm.beatmapset.id}#osu/${bm.id}`,
      preview_url: bm.beatmapset.preview_url,
      cover_url: bm.beatmapset.covers.card
    };

    res.json(data);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch beatmap info from osu! API' });
  }
});

// 🔍 Optional search route
app.get('/api/search', async (req, res) => {
  try {
    const token = await getAccessToken();
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Missing ?q=title parameter' });

    const response = await axios.get('https://osu.ppy.sh/api/v2/search', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json'
      },
      params: {
        mode: 'osu',
        query,
        type: 'beatmapset'
      }
    });

    const sets = response.data.beatmapsets;
    if (!sets || sets.length === 0) {
      return res.status(404).json({ error: 'No results found' });
    }

    const top = sets[0];
    res.json({
      id: top.id,
      title: `${top.artist} - ${top.title} (${top.creator})`,
      url: `https://osu.ppy.sh/beatmapsets/${top.id}`,
      preview_url: top.preview_url,
      cover_url: top.covers.card
    });

  } catch (err) {
    console.error("❌ Search Error:", err.response?.data || err.message, err.response?.status);
    res.status(500).json({ error: 'Failed to search beatmaps' });
  }
});

// Static frontend
app.use(express.static(path.join(__dirname, 'public')));

// Start server
app.listen(port, () => {
  console.log(`osu! beatmap API proxy running at http://localhost:${port}`);
});
