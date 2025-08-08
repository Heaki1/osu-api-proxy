// server.js (REPLACE your existing file with this)
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

// Create tables with sensible schema (primary key for upserts)
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS algeria_top50 (
    beatmap_id INTEGER,
    beatmap_title TEXT,
    player_id INTEGER,
    username TEXT,
    rank INTEGER,
    score INTEGER,
    accuracy TEXT,
    mods TEXT,
    last_updated INTEGER,
    PRIMARY KEY (beatmap_id, player_id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS progress (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);
});

// Promise wrappers for sqlite3 (convenience)
function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}
function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}
function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

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

  try {
    const response = await axios.post('https://osu.ppy.sh/oauth/token', {
      client_id,
      client_secret,
      grant_type: 'client_credentials',
      scope: 'public'
    });

    access_token = response.data.access_token;
    // subtract 10s buffer
    token_expiry = now + (response.data.expires_in * 1000) - 10000;
    console.log('🔑 Obtained new osu! token (expires in', response.data.expires_in, 's)');
    return access_token;
  } catch (err) {
    console.error('❌ Failed to get access token:', err.response?.data || err.message);
    throw err;
  }
}

// Bottleneck limiter to avoid API bans — tune minTime if you get 429s
const limiter = new Bottleneck({
  maxConcurrent: 3,
  minTime: 600 // 600 ms between requests -> ~100 requests/min if single concurrency
});

// Helper sleep
const sleep = ms => new Promise(res => setTimeout(res, ms));

// Robust leaderboard fetcher with retries/backoff
async function fetchLeaderboard(beatmapId, beatmapTitle) {
  const maxRetries = 4;
  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      const token = await getAccessToken();

      const res = await axios.get(`https://osu.ppy.sh/api/v2/beatmaps/${beatmapId}/scores`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      const scores = res.data.scores || [];
      const algerianScores = scores.filter(s => s.user && s.user.country && s.user.country.code === 'DZ');

      if (algerianScores.length > 0) {
        const now = Date.now();

        // Transaction: delete existing rows for this beatmap, then insert new rows
        await runAsync('BEGIN TRANSACTION');
        await runAsync('DELETE FROM algeria_top50 WHERE beatmap_id = ?', [beatmapId]);

        for (let i = 0; i < algerianScores.length; i++) {
          const s = algerianScores[i];
          const mods = (s.mods && s.mods.length) ? s.mods.join(',') : 'None';
          const accuracyText = (typeof s.accuracy === 'number') ? (s.accuracy * 100).toFixed(2) + '%' : (s.accuracy || 'N/A');

          await runAsync(
            `INSERT OR REPLACE INTO algeria_top50
              (beatmap_id, beatmap_title, player_id, username, rank, score, accuracy, mods, last_updated)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              beatmapId,
              beatmapTitle,
              s.user.id,
              s.user.username,
              i + 1,
              s.score,
              accuracyText,
              mods,
              now
            ]
          );
        }

        await runAsync('COMMIT');
        console.log(`🇩🇿 Saved ${algerianScores.length} Algerian scores for map ${beatmapId}`);
      }

      // success -> break
      return;
    } catch (err) {
      const status = err.response?.status;
      console.warn(`⚠️ fetchLeaderboard error for ${beatmapId} (attempt ${attempt + 1}):`, err.response?.data || err.message);

      // Token problem -> force refresh and retry
      if (status === 401) {
        access_token = null;
        attempt++;
        await sleep(1000 * attempt);
        continue;
      }

      // Rate limited -> exponential backoff
      if (status === 429) {
        const wait = (2 ** attempt) * 1000 + 1000;
        console.warn(`⏳ Rate limited on ${beatmapId}, waiting ${wait}ms before retry`);
        await sleep(wait);
        attempt++;
        continue;
      }

      // Other errors -> bail after logging
      break;
    }
  }
}

// Paginated fetch of beatmaps (walks pages until none left)
async function getAllBeatmaps() {
  let allBeatmaps = [];
  let page = 1;

  while (true) {
    try {
      const token = await getAccessToken();
      console.log(`📄 Fetching beatmap page ${page}...`);
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
        console.log('✅ No more beatmapset pages');
        break;
      }

      const beatmaps = sets.flatMap(set =>
        (set.beatmaps || []).map(bm => ({ id: bm.id, title: `${set.artist} - ${set.title} [${bm.version}]` }))
      );

      allBeatmaps.push(...beatmaps);
      page++;

      // small delay between pages to be gentle
      await sleep(500);
    } catch (err) {
      console.error(`❌ Failed to fetch beatmap page ${page}:`, err.response?.data || err.message);
      break;
    }
  }

  console.log(`📊 Total beatmaps fetched: ${allBeatmaps.length}`);
  return allBeatmaps;
}

// Progress helpers
function getProgress(key) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT value FROM progress WHERE key = ?`, [key], (err, row) => {
      if (err) return reject(err);
      resolve(row ? row.value : null);
    });
  });
}

function saveProgress(key, value) {
  return new Promise((resolve, reject) => {
    db.run(`INSERT OR REPLACE INTO progress (key, value) VALUES (?, ?)`, [key, value], (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

// Continuous/resumable update function
async function updateLeaderboards() {
  console.log("🔄 Updating Algerian leaderboards...");

  // Fetch all beatmaps
  const beatmaps = await getAllBeatmaps();
  const lastId = await getProgress("last_beatmap_id");

  // If we have a last scanned ID, start from it
  let startIndex = 0;
  if (lastId) {
    const idx = beatmaps.findIndex(b => b.id == lastId);
    if (idx >= 0 && idx < beatmaps.length - 1) {
      startIndex = idx + 1; // start after the last one
    }
  }

  // Slice the list from where we left off
  const mapsToScan = beatmaps.slice(startIndex);

  console.log(`📌 Resuming scan from index ${startIndex} of ${beatmaps.length}`);

  // Loop through maps with rate limiting
  for (let i = 0; i < mapsToScan.length; i++) {
    const bm = mapsToScan[i];
    await limiter.schedule(() => fetchLeaderboard(bm.id, bm.title));

    // Save progress after each map
    await saveProgress("last_beatmap_id", bm.id);

    // Small pause to avoid token expiry on huge scans
    await new Promise(res => setTimeout(res, 500));
  }

  console.log("✅ Finished scan, starting over next run.");
}

// API endpoint to get cached Algerian scores (optional query ?limit=100)
app.get('/api/algeria-top50', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '1000', 10);
    const rows = await allAsync('SELECT * FROM algeria_top50 ORDER BY last_updated DESC LIMIT ?', [limit]);
    res.json(rows);
  } catch (err) {
    console.error('❌ /api/algeria-top50 DB error:', err.message || err);
    res.status(500).json({ error: 'DB error' });
  }
});

// Small helper endpoints
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
    console.error('❌ Beatmap Fetch Error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch beatmap info' });
  }
});

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
    if (!sets || sets.length === 0) return res.status(404).json({ error: 'No results found' });
    const top = sets[0];
    res.json({
      id: top.id,
      title: `${top.artist} - ${top.title} (${top.creator})`,
      url: `https://osu.ppy.sh/beatmapsets/${top.id}`,
      preview_url: top.preview_url,
      cover_url: top.covers.card
    });
  } catch (err) {
    console.error('❌ Search Error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to search beatmaps' });
  }
});

app.listen(port, () => {
  console.log(`✅ osu! Algerian leaderboard tracker running at http://localhost:${port}`);
});

// Scheduler: initial run + periodic resume every 30m
(async () => {
  try {
    await updateLeaderboards();
    setInterval(updateLeaderboards, 30 * 60 * 1000);
  } catch (err) {
    console.error('❌ Fatal during initial update:', err);
  }
})();
