const cors = require('cors');
app.use(cors());
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();
const port = 3000;

// 🔒 Replace these with your actual osu! API credentials
const client_id = '41700';
const client_secret = '2gBS9LgMq8uuo5tp6WlOsBaRTQSiJCzIYiFxKK2q';

let access_token = null;
let token_expiry = 0;

app.use(cors());

// Fetch a new access token if needed
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

// Beatmap info endpoint
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
      url: `https://osu.ppy.sh/beatmapsets/${bm.beatmapset.id}#osu/${bm.id}`
    };

    res.json(data);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch beatmap info from osu! API' });
  }
});

app.listen(port, () => {
  console.log(`osu! beatmap API proxy running at http://localhost:${port}`);
});
