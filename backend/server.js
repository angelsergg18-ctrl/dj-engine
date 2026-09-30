const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const EssentiaWASM = require('essentia.js-model').EssentiaWASM;
const Essentia = require('essentia.js');

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
  if (k1 === k2) return 3; // misma key = perfecto
  if (num1 === num2 && mode1 !== mode2) return 2; // relativa = muy bueno
  const diff = Math.abs(num1 - num2);
  if ((diff === 1 || diff === 11) && mode1 === mode2) return 2; // vecino = muy bueno
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
  return data.access_token;
}

// ─── OBTENER TRACKS DE PLAYLIST ───────────────────────────────────────────────
async function getPlaylistTracks(playlistId, token) {
  const tracks = [];
  let url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100`;
  while (url) {
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    for (const item of data.items) {
      if (!item.track) continue;
      tracks.push({
        id: item.track.id,
        name: item.track.name,
        artist: item.track.artists.map(a => a.name).join(', '),
        preview_url: item.track.preview_url,
        duration_ms: item.track.duration_ms,
      });
    }
    url = data.next;
  }
  return tracks;
}

// ─── ANALIZAR AUDIO CON ESSENTIA ──────────────────────────────────────────────
async function analyzeAudioUrl(audioUrl) {
  // Descargar audio temporalmente
  const tmpFile = `/tmp/audio_${Date.now()}.mp3`;
  const tmpWav = `/tmp/audio_${Date.now()}.wav`;

  try {
    // Descargar
    execSync(`curl -s -L "${audioUrl}" -o "${tmpFile}"`);
    // Convertir a wav para Essentia
    execSync(`ffmpeg -y -i "${tmpFile}" -ar 44100 -ac 1 "${tmpWav}" 2>/dev/null`);

    // Leer y analizar con Essentia
    const audioBuffer = fs.readFileSync(tmpWav);
    const essentia = new Essentia(EssentiaWASM);

    const audioArray = new Float32Array(audioBuffer.buffer);
    const vectorSignal = essentia.arrayToVector(audioArray);

    // BPM
    const rhythm = essentia.RhythmExtractor2013(vectorSignal);
    const bpm = Math.round(rhythm.bpm);

    // Key
    const keyResult = essentia.KeyExtractor(vectorSignal);
    const key = `${keyResult.key} ${keyResult.scale}`;

    // Energy
    const energy = essentia.Energy(vectorSignal).energy;

    // Limpiar
    fs.unlinkSync(tmpFile);
    fs.unlinkSync(tmpWav);

    return { bpm, key, energy: parseFloat(energy.toFixed(3)) };
  } catch (e) {
    try { fs.unlinkSync(tmpFile); } catch {}
    try { fs.unlinkSync(tmpWav); } catch {}
    return null;
  }
}

// ─── FALLBACK: YOUTUBE ────────────────────────────────────────────────────────
async function analyzeViaYouTube(trackName, artist) {
  const query = `${artist} ${trackName} official audio`;
  const tmpFile = `/tmp/yt_${Date.now()}`;

  try {
    // Descargar solo 30 segundos de audio desde YouTube
    execSync(
      `yt-dlp --no-playlist -x --audio-format mp3 --postprocessor-args "-t 30" ` +
      `--output "${tmpFile}.%(ext)s" "ytsearch1:${query}" 2>/dev/null`,
      { timeout: 60000 }
    );

    const mp3File = `${tmpFile}.mp3`;
    if (!fs.existsSync(mp3File)) return null;

    const result = await analyzeAudioUrl(`file://${mp3File}`);
    try { fs.unlinkSync(mp3File); } catch {}
    return result;

  } catch (e) {
    return null;
  }
}

// ─── ALGORITMO DE ORDENAMIENTO ────────────────────────────────────────────────
function orderPlaylist(tracks) {
  if (tracks.length === 0) return tracks;

  const ordered = [];
  const remaining = [...tracks];

  // Empezar con el track de menor energía
  remaining.sort((a, b) => (a.energy || 0) - (b.energy || 0));
  ordered.push(remaining.shift());

  while (remaining.length > 0) {
    const last = ordered[ordered.length - 1];
    let bestScore = -1;
    let bestIndex = 0;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      let score = 0;

      // Compatibilidad armónica (peso alto)
      score += camelotCompatible(last.key, candidate.key) * 40;

      // Progresión de BPM suave (diferencia pequeña = mejor)
      const bpmDiff = Math.abs((last.bpm || 120) - (candidate.bpm || 120));
      if (bpmDiff <= 3) score += 30;
      else if (bpmDiff <= 8) score += 20;
      else if (bpmDiff <= 15) score += 10;

      // Progresión de energía (ligero incremento = mejor)
      const energyDiff = (candidate.energy || 0) - (last.energy || 0);
      if (energyDiff >= 0 && energyDiff <= 0.15) score += 20;
      else if (energyDiff < 0 && energyDiff >= -0.1) score += 10;

      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    ordered.push(remaining.splice(bestIndex, 1)[0]);
  }

  return ordered;
}

// ─── GENERAR JUSTIFICACIONES ──────────────────────────────────────────────────
function generateTransitionNote(track1, track2) {
  const notes = [];
  const camelotScore = camelotCompatible(track1.key, track2.key);
  const bpmDiff = Math.abs((track1.bpm || 0) - (track2.bpm || 0));

  if (camelotScore === 3) notes.push(`misma tonalidad (${CAMELOT[track1.key]})`);
  else if (camelotScore === 2) notes.push(`tonalidades compatibles (${CAMELOT[track1.key]} → ${CAMELOT[track2.key]})`);

  if (bpmDiff <= 3) notes.push(`BPM casi idéntico (${track1.bpm} → ${track2.bpm})`);
  else if (bpmDiff <= 8) notes.push(`BPM compatible (${track1.bpm} → ${track2.bpm})`);
  else notes.push(`salto de BPM (${track1.bpm} → ${track2.bpm})`);

  const energyDiff = ((track2.energy || 0) - (track1.energy || 0)).toFixed(2);
  if (energyDiff > 0) notes.push(`energía sube +${energyDiff}`);
  else if (energyDiff < 0) notes.push(`energía baja ${energyDiff}`);

  return notes.join(' · ');
}

// ─── ENDPOINT PRINCIPAL ───────────────────────────────────────────────────────
app.post('/analyze', async (req, res) => {
  try {
    const { playlist_url } = req.body;

    // Extraer playlist ID
    const match = playlist_url.match(/playlist\/([a-zA-Z0-9]+)/);
    if (!match) return res.status(400).json({ error: 'URL de playlist inválida' });
    const playlistId = match[1];

    // Auth Spotify
    const token = await getSpotifyToken();

    // Obtener tracks
    const tracks = await getPlaylistTracks(playlistId, token);
    if (tracks.length === 0) return res.status(400).json({ error: 'Playlist vacía o privada' });

    // Analizar cada track
    const analyzed = [];
    for (const track of tracks) {
      let audioData = null;

      // Ruta A: Preview de Spotify
      if (track.preview_url) {
        audioData = await analyzeAudioUrl(track.preview_url);
      }

      // Ruta B: YouTube fallback
      if (!audioData) {
        audioData = await analyzeViaYouTube(track.name, track.artist);
      }

      analyzed.push({
        ...track,
        bpm: audioData?.bpm || null,
        key: audioData?.key || null,
        energy: audioData?.energy || null,
        camelot: audioData?.key ? CAMELOT[audioData.key] : null,
        source: audioData ? (track.preview_url ? 'spotify_preview' : 'youtube') : 'no_data',
      });
    }

    // Ordenar playlist
    const ordered = orderPlaylist(analyzed);

    // Generar set final con transiciones
    const setWithTransitions = ordered.map((track, i) => ({
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

    res.json({ set: setWithTransitions, total: ordered.length });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DJ Engine corriendo en puerto ${PORT}`));
