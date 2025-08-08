// server.js
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const Bottleneck = require('bottleneck');
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// osu! API credentials
const client_id = process.env.OSU_CLIENT_ID;
const client_secret = process.env.OSU_CLIENT_SECRET;

let access_token = null;
let token_expiry = 0;

// SQLite database
const db = new sqlite3.Database('./leaderboard.db');
db.run(`CREATE TABLE IF NOT EXISTS algeria_top50 (
  beatmap_id INTEGER,
  beatmap_title TEXT,
  player_id INTEGER,
  username TEXT,
  rank INTEGER,
  score INTEGER,
  accuracy TEXT,
  mods TEXT,
  last_updated INTEGER
)`);

// Format seconds into mm:ss
function formatSeconds(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Get or refresh osu! API token
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

// ✅ Existing beatmap route
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
    res.status(500).json({ error: 'Failed to fetch beatmap info' });
  }
});

// ✅ Existing search route
app.get('/api/search', async (req, res) => {
  try {
    const token = await getAccessToken();
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: 'Missing ?q=title' });

    const response = await axios.get('https://osu.ppy.sh/api/v2/search', {
      headers: { Authorization: `Bearer ${token}` },
      params: { mode: 'osu', query, type: 'beatmapset' }
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

// ====================
// BACKGROUND LEADERBOARD FETCHER
// ====================

// Bottleneck limiter to avoid API bans
const limiter = new Bottleneck({
  maxConcurrent: 5,
  minTime: 250
});

// Fetch leaderboard and save Algerian players
async function fetchLeaderboard(beatmapId, beatmapTitle) {
  try {
    const token = await getAccessToken();
    const res = await axios.get(`https://osu.ppy.sh/api/v2/beatmaps/${beatmapId}/scores`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const algerianScores = res.data.scores.filter(s => s.user.country.code === 'DZ');

    if (algerianScores.length > 0) {
      const now = Date.now();
      const stmt = db.prepare(`INSERT INTO algeria_top50 
        (beatmap_id, beatmap_title, player_id, username, rank, score, accuracy, mods, last_updated)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      
      db.run("DELETE FROM algeria_top50 WHERE beatmap_id = ?", [beatmapId]);
      
      algerianScores.forEach((s, index) => {
        stmt.run(
          beatmapId,
          beatmapTitle,
          s.user.id,
          s.user.username,
          index + 1,
          s.score,
          (s.accuracy * 100).toFixed(2) + '%',
          s.mods.join(',') || 'None',
          now
        );
      });

      stmt.finalize();
      console.log(`🇩🇿 Saved ${algerianScores.length} Algerian scores for map ${beatmapId}`);
    }
  } catch (err) {
    console.warn(`⚠️ Failed to fetch leaderboard for ${beatmapId}:`, err.response?.data || err.message);
  }
}

// Get all beatmaps once (for demo, limit to 100 maps)
async function getAllBeatmaps() {
  const token = await getAccessToken();
  let allBeatmaps = [];
  let page = 1;

  while (true) {
    console.log(`📄 Fetching beatmap page ${page}...`);
    try {
      const res = await axios.get('https://osu.ppy.sh/api/v2/beatmapsets/search', {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          mode: 'osu',
          nsfw: false,
          sort: 'ranked_desc',
          page
        }
      });

      const sets = res.data.beatmapsets || [];
      if (sets.length === 0) {
        console.log("✅ No more pages to fetch.");
        break;
      }

      const beatmaps = sets.flatMap(set =>
        set.beatmaps.map(bm => ({
          id: bm.id,
          title: `${set.artist} - ${set.title} [${bm.version}]`
        }))
      );

      allBeatmaps.push(...beatmaps);
      page++;

      // Small delay to avoid triggering osu! API rate limits
      await new Promise(resolve => setTimeout(resolve, 500));

    } catch (err) {
      console.error(`❌ Failed to fetch page ${page}:`, err.response?.data || err.message);
      break;
    }
  }

  console.log(`📊 Total beatmaps fetched: ${allBeatmaps.length}`);
  return allBeatmaps;
}

// Periodic update
async function updateLeaderboards() {
  console.log("🔄 Updating Algerian leaderboards...");
  const beatmaps = await getAllBeatmaps();

  await Promise.allSettled(
    beatmaps.map(bm => limiter.schedule(() => fetchLeaderboard(bm.id, bm.title)))
  );

  console.log("✅ Leaderboard update complete");
}

// Update every 30 minutes
setInterval(updateLeaderboards, 30 * 60 * 1000);
updateLeaderboards(); // Initial run

// API endpoint to get cached Algerian scores
app.get('/api/algeria-top50', (req, res) => {
  db.all("SELECT * FROM algeria_top50 ORDER BY last_updated DESC", [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'DB error' });
    res.json(rows);
  });
});

app.listen(port, () => {
  console.log(`✅ osu! Algerian leaderboard tracker running at http://localhost:${port}`);
});
