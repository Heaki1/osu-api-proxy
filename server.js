const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
require('dotenv').config(); // Load environment variables from .env

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// osu! API credentials (from .env)
const client_id = process.env.OSU_CLIENT_ID;
const client_secret = process.env.OSU_CLIENT_SECRET;

let access_token = null;
let token_expiry = 0;

// ⏱️ Format seconds to mm:ss
function formatSeconds(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// 🔐 Get or refresh osu! API token
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

// ✅ GET /api/beatmap/:id → fetch beatmap info
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
      length: formatSeconds(bm.total_length || 0),
      url: `https://osu.ppy.sh/beatmapsets/${bm.beatmapset.id}#osu/${bm.id}`,
      preview_url: bm.beatmapset.preview_url,
      cover_url: bm.beatmapset.covers.card
    };

    res.json(data);
  } catch (err) {
    console.error("❌ Beatmap Fetch Error:", err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch beatmap info from osu! API' });
  }
});

// 🔍 GET /api/search?q= → search beatmaps
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
    console.error("❌ Search Error:", err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to search beatmaps' });
  }
});

// 🔝 GET /api/leaderboard-scores?user=username
app.get('/api/leaderboard-scores', async (req, res) => {
  const username = req.query.user;
  if (!username) return res.status(400).json({ error: 'Missing ?user=username' });

  try {
    const token = await getAccessToken();

    // 1. Get user ID
    const userRes = await axios.get(`https://osu.ppy.sh/api/v2/users/${username}/osu`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const userId = userRes.data.id;

    // 2. Get top 50 scores
    const topScoresRes = await axios.get(`https://osu.ppy.sh/api/v2/users/${userId}/scores/best?limit=50`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const topScores = topScoresRes.data;
    const leaderboardMatches = [];

for (const score of topScores) {
  const beatmapId = score.beatmap?.id;
  if (!beatmapId || !score.beatmap?.beatmapset) continue;

  try {
    const leaderboardRes = await axios.get(`https://osu.ppy.sh/api/v2/beatmaps/${beatmapId}/scores`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const scores = leaderboardRes.data.scores;
    const found = scores.find((s) => s.user.id === userId);

    // 🔍 Add this debug log here
    console.log(`🎯 Checked map ${beatmapId} | Found in leaderboard: ${!!found}`);

    if (found) {
      leaderboardMatches.push({
        beatmap: {
          id: score.beatmap.id,
          title: `${score.beatmap.beatmapset.artist} - ${score.beatmap.beatmapset.title} [${score.beatmap.version}]`,
          url: `https://osu.ppy.sh/beatmaps/${score.beatmap.id}`
        },
        rank: scores.findIndex(s => s.user.id === userId) + 1,
        score: found.score,
        accuracy: (found.accuracy * 100).toFixed(2) + '%',
        mods: found.mods.join(',') || 'None'
      });
    }
  } catch (err) {
    console.warn(`⚠️ Failed leaderboard check for beatmap ${beatmapId}:`, err.response?.data || err.message);
    continue;
  }
}

  
    res.json(leaderboardMatches);
  } catch (err) {
    console.error("❌ Leaderboard Score Fetch Error:", err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch leaderboard scores' });
  }
});
// Start server
app.listen(port, () => {
  console.log(`✅ osu! beatmap API proxy running at http://localhost:${port}`);
});
