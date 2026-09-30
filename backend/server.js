const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { execSync } = require('child_process');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

// ─── CAMELOT WHEEL ───────────────────────────────────────────────────────────
const CAMELOT = {
  'C major': '8B',  'A minor': '8A',
  'G major': '9B',  'E minor': '9A',
  'D major': '10B', 'B minor': '10A',
  'A major': '11B', 'F# minor': '11A',
  'E major': '12B', 'C# minor': '12A',
  'B major': '1B',  'G# minor': '1A',
  'F# major': '2B', 'D# minor': '2A',
  'C# major': '3B', 'A# minor': '3A',
  'G# major': '4B', 'F minor': '4A',
  'D# major': '5B', 'C minor': '5A',
  'A# major': '6B', 'G minor': '6A',
  'F major': '7B',  'D minor': '7A',
};

function camelotCompatible(key1, key2) {
  if (!key1 || !key2) return 0;
  const k1 = CAMELOT[key1];
  const k2 = CAMELOT[key2];
  if (!k1 || !k2) return 0;
  const num1 = parseInt(k1);
  const num2 = parseInt(k2);
  const mode1 = k1.slice(-1);
  const mode2 = k2.slice(-1);
  if (k1 === k2) return 3;
  if (num1 === num2 && mode1 !== mode2) return 2;
  const diff = Math.abs(num1 - num2);
  if ((diff === 1 || diff === 11) && mode1 === mode2) return 2;
  return 0;
}

// ─── SPOTIFY AUTH ─────────────────────────────────────────────────────────────
async function getSpotifyToken() {
  const creds = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  console.log('Spotify auth response:', JSON.stringify(data));
  if (!data.access_token) throw new Error('Spotify auth failed: ' + JSON.stringify(data));
  return data.access_token;
}

// ─── OBTENER TRACKS ───────────────────────────────────────────────────────────
async function getPlaylistTracks(playlistId, token) {
  const tracks = [];
  let url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100`;
  while (url) {
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    const data = await res.json();
    console.log('Spotify playlist response status:', res.status, JSON.stringify(data).substring(0, 300));
    if (!data.items) break;
    for (const item of data.items) {
      if (!item.track) continue;
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

// ─── ANALIZAR AUDIO CON PYTHON/LIBROSA ───────────────────────────────────────
async function analyzeAudio(audioUrl, isFile = false) {
  const tmpMp3 = `/tmp/audio_${Date.now()}.mp3`;

  try {
    if (!isFile) {
      execSync(`curl -s -L --max-time 30 "${audioUrl}" -o "${tmpMp3}"`, { timeout: 35000 });
    }

    const filePath = isFile ? audioUrl : tmpMp3;

    const pythonScript = `
import sys
import json
import warnings
warnings.filterwarnings('ignore')

try:
    import librosa
    import numpy as np

    y, sr = librosa.load("${filePath}", duration=30, mono=True)

    # BPM
    tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
    bpm = round(float(tempo[0]) if hasattr(tempo, '__len__') else float(tempo))

    # Key usando chroma
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
    chroma_mean = np.mean(chroma, axis=1)
    
    keys = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    key_idx = int(np.argmax(chroma_mean))
    key_name = keys[key_idx]
    
    # Detectar modo (major/minor) con HPSS
    harmonic = librosa.effects.harmonic(y)
    tonnetz = librosa.feature.tonnetz(y=harmonic, sr=sr)
    mode_val = float(np.mean(tonnetz[1]))
    mode = 'major' if mode_val > 0 else 'minor'
    
    full_key = f"{key_name} {mode}"

    # Energy (RMS)
    rms = librosa.feature.rms(y=y)
    energy = float(np.mean(rms))
    energy_norm = min(1.0, energy * 10)

    print(json.dumps({"bpm": bpm, "key": full_key, "energy": round(energy_norm, 3)}))

except Exception as e:
    print(json.dumps({"error": str(e)}))
`;

    const result = execSync(`python3 -c '${pythonScript}'`, { timeout: 60000 }).toString().trim();

    if (!isFile) {
      try { fs.unlinkSync(tmpMp3); } catch {}
    }

    const parsed = JSON.parse(result);
    if (parsed.error) return null;
    return parsed;

  } catch (e) {
    try { fs.unlinkSync(tmpMp3); } catch {}
    return null;
  }
}

// ─── FALLBACK: YOUTUBE ────────────────────────────────────────────────────────
async function analyzeViaYouTube(trackName, artist) {
  const query = `${artist} ${trackName} audio`;
  const tmpBase = `/tmp/yt_${Date.now()}`;

  try {
    execSync(
      `yt-dlp --no-playlist -x --audio-format mp3 --audio-quality 5 ` +
      `--postprocessor-args "ffmpeg:-t 30" ` +
      `--output "${tmpBase}.%(ext)s" ` +
      `"ytsearch1:${query.replace(/"/g, '')}" 2>/dev/null`,
      { timeout: 90000 }
    );

    const mp3File = `${tmpBase}.mp3`;
    if (!fs.existsSync(mp3File)) return null;

    const result = await analyzeAudio(mp3File, true);
    try { fs.unlinkSync(mp3File); } catch {}
    return result;

  } catch (e) {
    return null;
  }
}

// ─── ORDENAMIENTO ─────────────────────────────────────────────────────────────
function orderPlaylist(tracks) {
  if (tracks.length === 0) return tracks;

  const withData = tracks.filter(t => t.bpm && t.key);
  const withoutData = tracks.filter(t => !t.bpm || !t.key);

  if (withData.length === 0) return tracks;

  const ordered = [];
  const remaining = [...withData];

  remaining.sort((a, b) => (a.energy || 0) - (b.energy || 0));
  ordered.push(remaining.shift());

  while (remaining.length > 0) {
    const last = ordered[ordered.length - 1];
    let bestScore = -1;
    let bestIndex = 0;

    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i];
      let score = 0;
      score += camelotCompatible(last.key, c.key) * 40;
      const bpmDiff = Math.abs((last.bpm || 120) - (c.bpm || 120));
      if (bpmDiff <= 3) score += 30;
      else if (bpmDiff <= 8) score += 20;
      else if (bpmDiff <= 15) score += 10;
      const energyDiff = (c.energy || 0) - (last.energy || 0);
      if (energyDiff >= 0 && energyDiff <= 0.15) score += 20;
      else if (energyDiff < 0 && energyDiff >= -0.1) score += 10;
      if (score > bestScore) { bestScore = score; bestIndex = i; }
    }

    ordered.push(remaining.splice(bestIndex, 1)[0]);
  }

  return [...ordered, ...withoutData];
}

function generateTransitionNote(t1, t2) {
  const notes = [];
  const cs = camelotCompatible(t1.key, t2.key);
  const bpmDiff = Math.abs((t1.bpm || 0) - (t2.bpm || 0));

  if (cs === 3) notes.push(`misma tonalidad (${CAMELOT[t1.key]})`);
  else if (cs === 2) notes.push(`tonalidades compatibles (${CAMELOT[t1.key]} → ${CAMELOT[t2.key]})`);
  else if (cs === 0 && t1.key && t2.key) notes.push(`cambio de tonalidad (${CAMELOT[t1.key]} → ${CAMELOT[t2.key]})`);

  if (bpmDiff <= 3) notes.push(`BPM idéntico (${t1.bpm} → ${t2.bpm})`);
  else if (bpmDiff <= 8) notes.push(`BPM compatible (${t1.bpm} → ${t2.bpm})`);
  else notes.push(`salto BPM (${t1.bpm} → ${t2.bpm})`);

  const ed = ((t2.energy || 0) - (t1.energy || 0)).toFixed(2);
  if (parseFloat(ed) > 0.05) notes.push(`energía ↑`);
  else if (parseFloat(ed) < -0.05) notes.push(`energía ↓`);

  return notes.join(' · ');
}

// ─── ENDPOINT PRINCIPAL ───────────────────────────────────────────────────────
app.post('/analyze', async (req, res) => {
  try {
    const { playlist_url } = req.body;
    const match = playlist_url.match(/playlist\/([a-zA-Z0-9]+)/);
    if (!match) return res.status(400).json({ error: 'URL de playlist inválida' });

    const token = await getSpotifyToken();
    const tracks = await getPlaylistTracks(match[1], token);
    if (!tracks.length) return res.status(400).json({ error: 'Playlist vacía o privada' });

    const analyzed = [];
    for (const track of tracks) {
      let audioData = null;

      if (track.preview_url) {
        audioData = await analyzeAudio(track.preview_url);
      }

      if (!audioData) {
        audioData = await analyzeViaYouTube(track.name, track.artist);
      }

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

    const setFinal = ordered.map((track, i) => ({
      position: i + 1,
      name: track.name,
      artist: track.artist,
      bpm: track.bpm,
      key: track.key,
      camelot: track.camelot,
      energy: track.energy,
      source: track.source,
      transition_note: i > 0 ? generateTransitionNote(ordered[i - 1], track) : 'Opening track',
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
