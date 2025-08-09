// server.js — Postgres version, no SQLite
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const Bottleneck = require('bottleneck');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

// DB pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Uncomment for some external connections:
  // ssl: { rejectUnauthorized: false }
});

// helper query wrappers
async function query(sql, params = []) {
  return pool.query(sql, params);
}
async function getRows(sql, params = []) {
  const res = await pool.query(sql, params);
  return res.rows;
}
async function getRow(sql, params = []) {
  const res = await pool.query(sql, params);
  return res.rows[0];
}

// create tables
async function ensureTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS algeria_top50 (
      beatmap_id BIGINT,
      beatmap_title TEXT,
      player_id BIGINT,
      username TEXT,
      rank INTEGER,
      score BIGINT,
      accuracy TEXT,
      mods TEXT,
      last_updated BIGINT,
      PRIMARY KEY (beatmap_id, player_id)
    );
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS progress (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

// osu! API credentials
const client_id = process.env.OSU_CLIENT_ID;
const client_secret = process.env.OSU_CLIENT_SECRET;

let access_token = null;
let token_expiry = 0;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// format seconds into mm:ss
function formatSeconds(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// token getter
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
  console.log('🔑 Obtained new osu! token (expires in', response.data.expires_in, 's)');
  return access_token;
}

// rate limiter
const limiter = new Bottleneck({
  maxConcurrent: 3,
  minTime: 600
});

const sleep = ms => new Promise(res => setTimeout(res, ms));

// fetch leaderboard for one beatmap
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
      const algerianScores = scores.filter(s => s.user?.country?.code === 'DZ');

      if (algerianScores.length > 0) {
        const now = Date.now();
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('DELETE FROM algeria_top50 WHERE beatmap_id = $1', [beatmapId]);

          for (let i = 0; i < algerianScores.length; i++) {
            const s = algerianScores[i];
            const mods = s.mods?.length ? s.mods.join(',') : 'None';
            const accuracyText = typeof s.accuracy === 'number'
              ? (s.accuracy * 100).toFixed(2) + '%'
              : (s.accuracy || 'N/A');

            await client.query(
              `INSERT INTO algeria_top50
                (beatmap_id, beatmap_title, player_id, username, rank, score, accuracy, mods, last_updated)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
               ON CONFLICT (beatmap_id, player_id) DO UPDATE
                 SET beatmap_title = EXCLUDED.beatmap_title,
                     username = EXCLUDED.username,
                     rank = EXCLUDED.rank,
                     score = EXCLUDED.score,
                     accuracy = EXCLUDED.accuracy,
                     mods = EXCLUDED.mods,
                     last_updated = EXCLUDED.last_updated`,
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
          await client.query('COMMIT');
          console.log(`🇩🇿 Saved ${algerianScores.length} Algerian scores for map ${beatmapId}`);
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
        }
      }
      return;
    } catch (err) {
      const status = err.response?.status;
      console.warn(`⚠️ fetchLeaderboard error for ${beatmapId} (attempt ${attempt + 1}):`, err.response?.data || err.message);
      if (status === 401) {
        access_token = null;
        attempt++;
        await sleep(1000 * attempt);
        continue;
      }
      if (status === 429) {
        const wait = (2 ** attempt) * 1000 + 1000;
        console.warn(`⏳ Rate limited on ${beatmapId}, waiting ${wait}ms before retry`);
        await sleep(wait);
        attempt++;
        continue;
      }
      break;
    }
  }
}

// get all beatmaps
async function getAllBeatmaps() {
  let allBeatmaps = [];
  let page = 1;
  while (true) {
    try {
      const token = await getAccessToken();
      console.log(`📄 Fetching beatmap page ${page}...`);
      const res = await axios.get('https://osu.ppy.sh/api/v2/beatmapsets/search', {
        headers: { Authorization: `Bearer ${token}` },
        params: { mode: 'osu', nsfw: false, sort: 'ranked_desc', page }
      });

      const sets = res.data.beatmapsets || [];
      if (sets.length === 0) break;

      const beatmaps = sets.flatMap(set =>
        (set.beatmaps || []).map(bm => ({
          id: bm.id,
          title: `${set.artist} - ${set.title} [${bm.version}]`
        }))
      );
      allBeatmaps.push(...beatmaps);
      page++;
      await sleep(500);
    } catch (err) {
      console.error(`❌ Failed to fetch beatmap page ${page}:`, err.response?.data || err.message);
      break;
    }
  }
  console.log(`📊 Total beatmaps fetched: ${allBeatmaps.length}`);
  return allBeatmaps;
}

// progress helpers
async function getProgress(key) {
  const row = await getRow('SELECT value FROM progress WHERE key = $1', [key]);
  return row ? row.value : null;
}
async function saveProgress(key, value) {
  await query(
    `INSERT INTO progress (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}

// main update function
async function updateLeaderboards() {
  console.log("🔄 Updating Algerian leaderboards...");
  const beatmaps = await getAllBeatmaps();
  const lastId = await getProgress("last_beatmap_id");
  let startIndex = 0;
  if (lastId) {
    const idx = beatmaps.findIndex(b => b.id == lastId);
    if (idx >= 0 && idx < beatmaps.length - 1) {
      startIndex = idx + 1;
    }
  }
  const mapsToScan = beatmaps.slice(startIndex);
  console.log(`📌 Resuming scan from index ${startIndex} of ${beatmaps.length}`);

  for (let i = 0; i < mapsToScan.length; i++) {
    const bm = mapsToScan[i];
    await limiter.schedule(() => fetchLeaderboard(bm.id, bm.title));
    await saveProgress("last_beatmap_id", bm.id);
    await sleep(500);
  }
  console.log("✅ Finished scan, starting over next run.");
}

// API endpoints
app.get('/api/algeria-top50', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '1000', 10);
    const rows = await getRows(
      'SELECT * FROM algeria_top50 ORDER BY score DESC LIMIT $1',
      [limit]
    );
    res.json(rows);
  } catch (err) {
    console.error('❌ /api/algeria-top50 DB error:', err.message || err);
    res.status(500).json({ error: 'DB error' });
  }
});

// start server
app.listen(port, async () => {
  console.log(`✅ osu! Algerian leaderboard tracker running at http://localhost:${port}`);
  await ensureTables();
  await updateLeaderboards();
  setInterval(updateLeaderboards, 30 * 60 * 1000);
});
