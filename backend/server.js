const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { execSync } = require('child_process');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://dj-engine.onrender.com/callback';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://beamish-bombolone-61749e.netlify.app';

const CAMELOT = {
  'C major':'8B','A minor':'8A','G major':'9B','E minor':'9A',
  'D major':'10B','B minor':'10A','A major':'11B','F# minor':'11A',
  'E major':'12B','C# minor':'12A','B major':'1B','G# minor':'1A',
  'F# major':'2B','D# minor':'2A','C# major':'3B','A# minor':'3A',
  'G# major':'4B','F minor':'4A','D# major':'5B','C minor':'5A',
  'A# major':'6B','G minor':'6A','F major':'7B','D minor':'7A',
};

function camelotCompatible(k1, k2) {
  if (!k1 || !k2) return 0;
  const c1 = CAMELOT[k1], c2 = CAMELOT[k2];
  if (!c1 || !c2) return 0;
  const n1 = parseInt(c1), n2 = parseInt(c2);
  const m1 = c1.slice(-1), m2 = c2.slice(-1);
  if (c1 === c2) return 3;
  if (n1 === n2 && m1 !== m2) return 2;
  const diff = Math.abs(n1 - n2);
  if ((diff === 1 || diff === 11) && m1 === m2) return 2;
  return 0;
}

// ─── OAUTH ────────────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  const scopes = 'playlist-read-private playlist-read-collaborative';
  res.redirect(`https://accounts.spotify.com/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(scopes)}`);
});

app.get('/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send('No code');
  const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
  });
  const data = await tokenRes.json();
  if (!data.access_token) return res.status(500).send('Token error');
  res.redirect(`${FRONTEND_URL}?access_token=${data.access_token}&refresh_token=${data.refresh_token || ''}`);
});

// ─── OBTENER PLAYLISTS DEL USUARIO ───────────────────────────────────────────
app.get('/my-playlists', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const playlists = [];
    let url = 'https://api.spotify.com/v1/me/playlists?limit=50';
    while (url) {
      const r = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
      const d = await r.json();
      if (!d.items) break;
      for (const p of d.items) {
        if (!p) continue;
        playlists.push({
          id: p.id,
          name: p.name,
          total: p.tracks?.total || 0,
          image: p.images?.[0]?.url || null,
        });
      }
      url = d.next;
    }
    res.json({ playlists });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── OBTENER TRACKS VIA /me/playlists ────────────────────────────────────────
async function getPlaylistTracks(playlistId, token) {
  const tracks = [];
  // Usar endpoint que funciona en Development Mode
  let url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100`;
  let attempts = 0;
  while (url && attempts < 10) {
    attempts++;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    const data = await res.json();
    console.log(`Tracks fetch status: ${res.status}, items: ${data.items?.length || 0}`);
    if (res.status !== 200 || !data.items) break;
    for (const item of data.items) {
      if (!item?.track) continue;
      tracks.push({
        id: item.track.id,
        name: item.track.name,
        artist: item.track.artists.map(a => a.name).join(', '),
        preview_url: item.track.preview_url,
      });
    }
    url = data.next;
  }
  return tracks;
}

// ─── ANÁLISIS DE AUDIO ────────────────────────────────────────────────────────
async function analyzeAudio(audioUrl, isFile = false) {
  const tmpMp3 = `/tmp/audio_${Date.now()}.mp3`;
  try {
    if (!isFile) execSync(`curl -s -L --max-time 30 "${audioUrl}" -o "${tmpMp3}"`, { timeout: 35000 });
    const filePath = isFile ? audioUrl : tmpMp3;
    const result = execSync(`python3 -c '
import sys, json, warnings
warnings.filterwarnings("ignore")
try:
    import librosa, numpy as np
    y, sr = librosa.load("${filePath}", duration=30, mono=True)
    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
    bpm = round(float(tempo[0]) if hasattr(tempo, "__len__") else float(tempo))
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    keys = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"]
    key_name = keys[int(np.argmax(np.mean(chroma, axis=1)))]
    harmonic = librosa.effects.harmonic(y)
    tonnetz = librosa.feature.tonnetz(y=harmonic, sr=sr)
    mode = "major" if float(np.mean(tonnetz[1])) > 0 else "minor"
    rms = librosa.feature.rms(y=y)
    energy = min(1.0, float(np.mean(rms)) * 10)
    print(json.dumps({"bpm": bpm, "key": f"{key_name} {mode}", "energy": round(energy, 3)}))
except Exception as e:
    print(json.dumps({"error": str(e)}))
'`, { timeout: 60000 }).toString().trim();
    if (!isFile) { try { fs.unlinkSync(tmpMp3); } catch {} }
    const parsed = JSON.parse(result);
    return parsed.error ? null : parsed;
  } catch { try { fs.unlinkSync(tmpMp3); } catch {} return null; }
}

async function analyzeViaYouTube(trackName, artist) {
  const query = `${artist} ${trackName} audio`.replace(/"/g, '').replace(/'/g, '');
  const tmpBase = `/tmp/yt_${Date.now()}`;
  try {
    execSync(`yt-dlp --no-playlist -x --audio-format mp3 --audio-quality 5 --postprocessor-args "ffmpeg:-t 30" --output "${tmpBase}.%(ext)s" "ytsearch1:${query}" 2>/dev/null`, { timeout: 90000 });
    const mp3File = `${tmpBase}.mp3`;
    if (!fs.existsSync(mp3File)) return null;
    const result = await analyzeAudio(mp3File, true);
    try { fs.unlinkSync(mp3File); } catch {}
    return result;
  } catch { return null; }
}

// ─── ORDENAMIENTO ─────────────────────────────────────────────────────────────
function orderPlaylist(tracks) {
  const withData = tracks.filter(t => t.bpm && t.key);
  const withoutData = tracks.filter(t => !t.bpm || !t.key);
  if (!withData.length) return tracks;
  const ordered = [];
  const remaining = [...withData];
  remaining.sort((a, b) => (a.energy || 0) - (b.energy || 0));
  ordered.push(remaining.shift());
  while (remaining.length > 0) {
    const last = ordered[ordered.length - 1];
    let bestScore = -1, bestIndex = 0;
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i];
      let score = camelotCompatible(last.key, c.key) * 40;
      const bpmDiff = Math.abs((last.bpm || 120) - (c.bpm || 120));
      if (bpmDiff <= 3) score += 30;
      else if (bpmDiff <= 8) score += 20;
      else if (bpmDiff <= 15) score += 10;
      const ed = (c.energy || 0) - (last.energy || 0);
      if (ed >= 0 && ed <= 0.15) score += 20;
      else if (ed < 0 && ed >= -0.1) score += 10;
      if (score > bestScore) { bestScore = score; bestIndex = i; }
    }
    ordered.push(remaining.splice(bestIndex, 1)[0]);
  }
  return [...ordered, ...withoutData];
}

function transitionNote(t1, t2) {
  const notes = [];
  const cs = camelotCompatible(t1.key, t2.key);
  const bd = Math.abs((t1.bpm || 0) - (t2.bpm || 0));
  if (cs === 3) notes.push(`misma tonalidad (${CAMELOT[t1.key]})`);
  else if (cs === 2) notes.push(`tonalidades compatibles (${CAMELOT[t1.key]} → ${CAMELOT[t2.key]})`);
  if (bd <= 3) notes.push(`BPM idéntico (${t1.bpm})`);
  else if (bd <= 8) notes.push(`BPM compatible (${t1.bpm} → ${t2.bpm})`);
  else notes.push(`salto BPM (${t1.bpm} → ${t2.bpm})`);
  const ed = ((t2.energy || 0) - (t1.energy || 0)).toFixed(2);
  if (parseFloat(ed) > 0.05) notes.push('energía ↑');
  else if (parseFloat(ed) < -0.05) notes.push('energía ↓');
  return notes.join(' · ');
}

// ─── ANALIZAR PLAYLIST ────────────────────────────────────────────────────────
app.post('/analyze', async (req, res) => {
  try {
    const { playlist_id, access_token } = req.body;
    if (!access_token) return res.status(401).json({ error: 'NO_TOKEN' });
    if (!playlist_id) return res.status(400).json({ error: 'No playlist_id' });

    const tracks = await getPlaylistTracks(playlist_id, access_token);
    console.log(`Got ${tracks.length} tracks for playlist ${playlist_id}`);
    if (!tracks.length) return res.status(400).json({ error: 'Playlist vacía o sin acceso' });

    const analyzed = [];
    for (const track of tracks) {
      let audioData = null;
      if (track.preview_url) audioData = await analyzeAudio(track.preview_url);
      if (!audioData) audioData = await analyzeViaYouTube(track.name, track.artist);
      analyzed.push({
        ...track,
        bpm: audioData?.bpm || null,
        key: audioData?.key || null,
        energy: audioData?.energy || null,
        camelot: audioData?.key ? CAMELOT[audioData.key] : null,
        source: audioData ? (track.preview_url ? 'spotify_preview' : 'youtube') : 'sin_datos',
      });
    }

    const ordered = orderPlaylist(analyzed);
    const setFinal = ordered.map((t, i) => ({
      position: i + 1,
      name: t.name,
      artist: t.artist,
      bpm: t.bpm,
      key: t.key,
      camelot: t.camelot,
      energy: t.energy,
      source: t.source,
      transition_note: i > 0 ? transitionNote(ordered[i-1], t) : 'Opening track',
    }));

    res.json({ set: setFinal, total: ordered.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DJ Engine corriendo en puerto ${PORT}`));
