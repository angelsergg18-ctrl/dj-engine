const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { execSync } = require('child_process');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const GETBPM_KEY = process.env.GETBPM_API_KEY || '';

const CAMELOT = {
  'C major':'8B','A minor':'8A','G major':'9B','E minor':'9A',
  'D major':'10B','B minor':'10A','A major':'11B','F# minor':'11A',
  'E major':'12B','C# minor':'12A','B major':'1B','G# minor':'1A',
  'F# major':'2B','D# minor':'2A','C# major':'3B','A# minor':'3A',
  'G# major':'4B','F minor':'4A','D# major':'5B','C minor':'5A',
  'A# major':'6B','G minor':'6A','F major':'7B','D minor':'7A',
};

const CAMELOT_BY_KEY = {
  'C':'8B','Cm':'8A','G':'9B','Gm':'9A','D':'10B','Bm':'10A',
  'A':'11B','F#m':'11A','E':'12B','C#m':'12A','B':'1B','G#m':'1A',
  'F#':'2B','D#m':'2A','C#':'3B','A#m':'3A','G#':'4B','Fm':'4A',
  'D#':'5B','Cm2':'5A','A#':'6B','Gm2':'6A','F':'7B','Dm':'7A',
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

// ─── BUSCAR BPM Y KEY EN GETSONGBPM ──────────────────────────────────────────
async function lookupSongBPM(title, artist) {
  if (!GETBPM_KEY) return null;
  try {
    const query = encodeURIComponent(`${artist} ${title}`);
    const res = await fetch(`https://api.getsongbpm.com/search/?api_key=${GETBPM_KEY}&type=both&lookup=${query}`);
    const data = await res.json();
    if (!data.search?.length) return null;
    const song = data.search[0];
    return {
      bpm: song.tempo ? parseInt(song.tempo) : null,
      key: song.key_of ? song.key_of : null,
    };
  } catch { return null; }
}

// ─── ANÁLISIS DE AUDIO CON LIBROSA ───────────────────────────────────────────
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
  const query = `${artist} ${trackName} audio`.replace(/['"]/g, '');
  const tmpBase = `/tmp/yt_${Date.now()}`;
  try {
    execSync(
      `yt-dlp --no-playlist -x --audio-format mp3 --audio-quality 5 ` +
      `--postprocessor-args "ffmpeg:-t 30" ` +
      `--output "${tmpBase}.%(ext)s" "ytsearch1:${query}" 2>/dev/null`,
      { timeout: 90000 }
    );
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

// ─── ENDPOINT: ANALIZAR LISTA MANUAL ─────────────────────────────────────────
app.post('/analyze', async (req, res) => {
  try {
    const { tracks: trackList } = req.body;
    if (!trackList?.length) return res.status(400).json({ error: 'Lista de canciones vacía' });

    const analyzed = [];
    for (const track of trackList) {
      const { name, artist } = track;
      let audioData = null;

      // Ruta 1: GetSongBPM (rápido, si hay API key)
      const bpmData = await lookupSongBPM(name, artist);

      // Ruta 2: YouTube + Librosa (análisis real)
      audioData = await analyzeViaYouTube(name, artist);

      // Combinar: si librosa funcionó usamos sus datos, si no usamos GetSongBPM
      const finalBpm = audioData?.bpm || bpmData?.bpm || null;
      const finalKey = audioData?.key || null;
      const finalEnergy = audioData?.energy || null;

      analyzed.push({
        name,
        artist,
        bpm: finalBpm,
        key: finalKey,
        energy: finalEnergy,
        camelot: finalKey ? CAMELOT[finalKey] : null,
        source: audioData ? 'youtube_librosa' : (bpmData ? 'getsongbpm' : 'sin_datos'),
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
