// hindmovie.fit — Direct Stream Extractor v2 (Movies + TV + Anime + K-Drama + 4K)
// =========================================================================
// Scrapes DIRECT PLAYABLE streams from hindmovie.fit via TWO backends:
//
// 1. iqsmartgames API (for MOVIES):
//    GET streams.iqsmartgames.com/mymovieapi?imdbid=<imdb>&key=<key>
//    → fileslug → pro.iqsmartgames.com → hanerix.com → HLS stream
//    Returns: HLS (1080p/720p/480p, Hindi+English dual audio)
//
// 2. GDShine API (for TV, Anime, K-Drama, Movies not in iqsmart):
//    GET gdshine.org/api/files?search=<title>
//    → file UUID + filename (parse quality/episode from filename)
//    POST gdshine.org/api/downloads/<UUID>/via-worker?purpose=watch
//    → copyUrl (direct playable MKV, video/x-matroska, Accept-Ranges: bytes)
//    No login required. Files under 4GB work via shared GDrive.
//    Files over 4GB return 413 (needs user's own GDrive).
//
// USAGE:
//   node hindmovie_all_in_one.js <tmdbId> <movie|tv> [season] [episode]
//   node hindmovie_all_in_one.js search "dune"

'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const PROVIDER_NAME = 'HindMovie';
const TMDB_API_KEY = '8476a7ab80ad76f0936744df0430e67c';
const SITE_BASE = 'https://hindmovie.fit';
const IQSMART_API = 'https://streams.iqsmartgames.com';
const IQSMART_PLAYER = 'https://pro.iqsmartgames.com';
const IQSMART_KEY = 'e11a7debaaa4f5d25b671706ffe4d2acb56efbd4';
const GDSHINE_API = 'https://gdshine.org';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ─── HTTP helpers ───────────────────────────────────────────────────────────
function fetchText(url, { headers = {}, timeout = 15000, method = 'GET', body = null } = {}) {
  const finalHeaders = { 'User-Agent': UA, 'Accept': '*/*', ...headers };
  const args = ['-sL', '--max-time', String(Math.floor(timeout / 1000)), '--request', method];
  for (const [k, v] of Object.entries(finalHeaders)) args.push('-H', `${k}: ${v}`);
  if (body) args.push('--data', body);
  args.push(url);
  try {
    return execFileSync('curl', args, { maxBuffer: 50 * 1024 * 1024, timeout: timeout + 2000, encoding: 'utf8' });
  } catch (e) { throw new Error(`curl failed: ${e.message.slice(0, 80)}`); }
}

async function fetchJson(url, opts = {}) {
  return JSON.parse(await fetchText(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers || {}) } }));
}

// ─── Get TMDB info ──────────────────────────────────────────────────────────
async function getTMDBInfo(tmdbId, type) {
  const isTV = type === 'tv' || type === 'series';
  const url = `https://api.themoviedb.org/3/${isTV ? 'tv' : 'movie'}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    return {
      title: (isTV ? j.name : j.title) || 'Unknown',
      year: ((isTV ? j.first_air_date : j.release_date) || '').slice(0, 4),
      imdbId: j.imdb_id || (j.external_ids && j.external_ids.imdb_id) || null,
      type, tmdbId: String(tmdbId),
    };
  } catch (e) { return null; }
}

// ─── GDShine API: search files by query ─────────────────────────────────────
async function searchGDShine(query, limit = 20) {
  try {
    const data = await fetchJson(`${GDSHINE_API}/api/files?search=${encodeURIComponent(query)}&limit=${limit}`);
    return (data.data || []).map(f => ({
      id: f.id,
      shortId: f.shortId,
      name: f.name,
      size: parseInt(f.size),
      sizeGB: parseInt(f.size) / 1024 / 1024 / 1024,
      mimeType: f.mimeType,
      isPublic: f.isPublic,
    }));
  } catch (e) {
    console.log(`[HindMovie] GDShine search failed: ${e.message}`);
    return [];
  }
}

// ─── GDShine API: get watch/stream URL for a file ──────────────────────────
async function getGDShineStreamUrl(fileUuid) {
  try {
    const resp = await fetchJson(`${GDSHINE_API}/api/downloads/${fileUuid}/via-worker?purpose=watch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (resp.success && resp.data && resp.data.copyUrl) {
      return resp.data.copyUrl;
    }
    if (resp.error && resp.error.includes('too large')) {
      console.log(`[HindMovie] File too large for shared drive (>4GB) — skipping`);
    }
  } catch (e) {
    console.log(`[HindMovie] GDShine stream failed: ${e.message.slice(0, 60)}`);
  }
  return null;
}

// ─── Parse quality from filename ────────────────────────────────────────────
function parseQuality(filename) {
  const f = (filename || '').toLowerCase();
  if (f.includes('2160') || f.includes('4k') || f.includes('uhd')) return '2160p';
  if (f.includes('1080')) return '1080p';
  if (f.includes('720')) return '720p';
  if (f.includes('480')) return '480p';
  return '720p';
}

// ─── Parse episode from filename ────────────────────────────────────────────
function parseEpisode(filename) {
  const m = (filename || '').match(/S(\d+)E(\d+)/i);
  if (m) return { season: parseInt(m[1]), episode: parseInt(m[2]) };
  return null;
}

// ─── Parse audio languages from filename ────────────────────────────────────
function parseLanguages(filename) {
  const f = (filename || '').toLowerCase();
  const langs = [];
  if (f.includes('hindi') || f.includes('hind')) langs.push('hi');
  if (f.includes('english') || f.includes('eng')) langs.push('en');
  if (f.includes('japanese') || f.includes('jap')) langs.push('ja');
  if (f.includes('korean') || f.includes('kor')) langs.push('ko');
  if (f.includes('chinese') || f.includes('chi') || f.includes('mandarin')) langs.push('zh');
  if (f.includes('tamil') || f.includes('tam')) langs.push('ta');
  if (f.includes('telugu') || f.includes('tel')) langs.push('te');
  return langs.length > 0 ? langs : ['en'];
}

// ─── Resolve movie streams via iqsmartgames API ─────────────────────────────
async function resolveMovieViaIqsmart(imdbId, info) {
  let files = null;
  try {
    const apiUrl = `${IQSMART_API}/mymovieapi?imdbid=${imdbId}&key=${IQSMART_KEY}`;
    const data = await fetchJson(apiUrl, {
      headers: { 'Origin': IQSMART_API, 'Referer': IQSMART_API + '/' },
    });
    if (data.success && data.data && data.data.length > 0) {
      files = data.data.map(d => ({ fileslug: d.fileslug, filename: d.filename, fsize: d.fsize }));
    }
  } catch (e) { /* fall through */ }
  if (!files || files.length === 0) return [];

  const allStreams = [];
  const seenUrls = new Set();
  for (const file of files) {
    const streamResult = await resolveStreamViaMultimovies(file.fileslug);
    if (!streamResult) continue;
    const results = Array.isArray(streamResult) ? streamResult : [streamResult];
    for (const result of results) {
      let variants = [];
      if (result.masterText && result.masterText.startsWith('#EXTM3U')) {
        variants = parseMasterM3u8(result.masterText, result.url);
      } else {
        const baseUrl = result.url.replace(/\/master\.m3u8.*$/, '');
        variants = [
          { resolution: { w: 1920, h: 1080 }, quality: '1080p', url: `${baseUrl}/index-f3-v1-a1.m3u8`, audioLanguages: ['hi', 'en'] },
          { resolution: { w: 1280, h: 720 }, quality: '720p', url: `${baseUrl}/index-f2-v1-a1.m3u8`, audioLanguages: ['hi', 'en'] },
          { resolution: { w: 852, h: 480 }, quality: '480p', url: `${baseUrl}/index-f1-v1-a1.m3u8`, audioLanguages: ['hi', 'en'] },
        ];
      }
      for (const v of variants) {
        if (seenUrls.has(v.url)) continue;
        seenUrls.add(v.url);
        allStreams.push(buildStream(v, info, v.audioLanguages, result.sourceName || 'iqsmart', 'hls'));
      }
    }
  }
  return allStreams;
}

// ─── Resolve stream URL via multimovies scraper (pro.iqsmartgames.com) ──────
async function resolveStreamViaMultimovies(fileslug) {
  const mmFile = path.join(__dirname, 'multimovies_all_in_one.js');
  if (!require('fs').existsSync(mmFile)) return null;
  try {
    const mm = require(mmFile);
    return await mm.fetchStreamUrl(fileslug);
  } catch (e) { return null; }
}

// ─── Parse master.m3u8 ──────────────────────────────────────────────────────
function parseMasterM3u8(text, streamUrl) {
  if (!text || !text.startsWith('#EXTM3U')) return [];
  const variants = [];
  let currentRes = null, currentAudioLang = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const l = line.trim();
    if (l.startsWith('#EXT-X-MEDIA:TYPE=AUDIO')) {
      const langMatch = l.match(/LANGUAGE="([^"]+)"/);
      if (langMatch) currentAudioLang.push(langMatch[1]);
    } else if (l.startsWith('#EXT-X-STREAM-INF:')) {
      const resMatch = l.match(/RESOLUTION=(\d+)x(\d+)/);
      if (resMatch) currentRes = { w: parseInt(resMatch[1]), h: parseInt(resMatch[2]) };
    } else if (l && !l.startsWith('#') && currentRes) {
      let variantUrl;
      if (l.startsWith('http')) variantUrl = l;
      else if (l.startsWith('/')) { const u = new URL(streamUrl); variantUrl = `${u.protocol}//${u.host}${l}`; }
      else { const base = streamUrl.replace(/\/[^/]*$/, ''); variantUrl = `${base}/${l}`; }
      variants.push({
        resolution: currentRes,
        quality: currentRes.h >= 2160 ? '2160p' : currentRes.h >= 1080 ? '1080p' : currentRes.h >= 720 ? '720p' : currentRes.h >= 480 ? '480p' : '360p',
        audioLanguages: [...currentAudioLang],
        url: variantUrl,
      });
      currentRes = null; currentAudioLang = [];
    }
  }
  return variants;
}

// ─── Build Stremio stream object ────────────────────────────────────────────
function buildStream(variant, info, audioLangs, sourceName, streamType) {
  const langsLabel = audioLangs && audioLangs.length > 0 ? audioLangs.join('+') : 'multi';
  const isMkv = streamType === 'mkv';
  return {
    name: `${PROVIDER_NAME} [${sourceName}] | ${variant.quality} | ${langsLabel}`,
    title: `${info.title}${info.year ? ` (${info.year})` : ''} [HindMovie ${variant.resolution ? variant.resolution.w + 'x' + variant.resolution.h : ''} ${variant.quality} ${langsLabel}]`,
    url: variant.url,
    quality: variant.quality,
    type: isMkv ? 'video/x-matroska' : 'application/vnd.apple.mpegurl',
    behaviorHints: { bingeGroup: `hindmovie-${variant.quality}-${langsLabel}-${sourceName}` },
  };
}

// ─── Resolve streams via GDShine API ────────────────────────────────────────
async function resolveViaGDShine(info, isTV, season, episode) {
  // GDShine search uses single-word matching with dots in filenames
  // Strategy: build the expected filename pattern and search for it
  const titleWords = info.title.split(/[\s:,\-()]+/).filter(w => w.length > 2).map(w => w.toLowerCase());
  
  let allFiles = [];
  
  if (isTV) {
    const targetSeason = parseInt(season) || 1;
    const targetEpisode = parseInt(episode) || 1;
    const sStr = String(targetSeason).padStart(2, '0');
    const eStr = String(targetEpisode).padStart(2, '0');
    
    // Build the expected filename pattern: Title.S01E01
    const titlePart = titleWords.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('.');
    const episodePattern = `${titlePart}.S${sStr}E${eStr}`;
    console.log(`[HindMovie] Searching GDShine for: "${episodePattern}"`);
    allFiles = await searchGDShine(episodePattern, 20);
    
    // If no results, try with first word + S01E01
    if (allFiles.length === 0) {
      const altPattern = `${titleWords[0]}.S${sStr}E${eStr}`;
      console.log(`[HindMovie] Trying: "${altPattern}"`);
      allFiles = await searchGDShine(altPattern, 20);
    }
    
    // If still no results, search with just the title word and filter
    if (allFiles.length === 0) {
      console.log(`[HindMovie] Trying broad search: "${titleWords[0]}"`);
      allFiles = await searchGDShine(titleWords[0], 100);
    }
    
    // Filter to matching episode
    const byQuality = {};
    for (const f of allFiles) {
      const ep = parseEpisode(f.name);
      if (ep && ep.season === targetSeason && ep.episode === targetEpisode) {
        const q = parseQuality(f.name);
        if (f.sizeGB > 4) continue; // Skip files over 4GB
        if (!byQuality[q]) byQuality[q] = f;
      }
    }
    const matchedFiles = Object.values(byQuality);
    
    if (matchedFiles.length === 0) {
      console.log('[HindMovie] No matching files found on GDShine');
      return [];
    }
    
    // Sort by quality
    const qOrder = { '2160p': 0, '1080p': 1, '720p': 2, '480p': 3 };
    matchedFiles.sort((a, b) => (qOrder[parseQuality(a.name)] || 99) - (qOrder[parseQuality(b.name)] || 99));
    
    // Get stream URL for each matched file
    const allStreams = [];
    const seenUrls = new Set();
    for (const file of matchedFiles) {
      const quality = parseQuality(file.name);
      const langs = parseLanguages(file.name);
      const sizeStr = file.sizeGB < 1 ? `${Math.round(file.sizeGB * 1024)}MB` : `${file.sizeGB.toFixed(2)}GB`;
      console.log(`[HindMovie] GDShine: ${file.name.substring(0, 60)}... (${quality}, ${sizeStr})`);
      const streamUrl = await getGDShineStreamUrl(file.id);
      if (!streamUrl || seenUrls.has(streamUrl)) continue;
      seenUrls.add(streamUrl);
      allStreams.push(buildStream({
        url: streamUrl,
        resolution: quality === '2160p' ? { w: 3840, h: 2160 } : quality === '1080p' ? { w: 1920, h: 1080 } : quality === '720p' ? { w: 1280, h: 720 } : { w: 852, h: 480 },
        quality,
        audioLanguages: langs,
      }, info, langs, 'gdshine', 'mkv'));
    }
    return allStreams;
  } else {
    // For movies: search with the title
    const searchQuery = titleWords.join('.');
    console.log(`[HindMovie] Searching GDShine for: "${searchQuery}"`);
    allFiles = await searchGDShine(searchQuery, 50);
    
    // If no results, try with just first word
    if (allFiles.length === 0) {
      console.log(`[HindMovie] Trying: "${titleWords[0]}"`);
      allFiles = await searchGDShine(titleWords[0], 50);
    }
    
    if (allFiles.length === 0) {
      console.log('[HindMovie] No files found on GDShine');
      return [];
    }
    console.log(`[HindMovie] Found ${allFiles.length} files on GDShine`);
    
    // Match by all title words being in filename
    const byQuality = {};
    for (const f of allFiles) {
      const nameLower = f.name.toLowerCase();
      const matches = titleWords.every(w => nameLower.includes(w));
      if (matches && f.sizeGB <= 4) {
        const q = parseQuality(f.name);
        if (!byQuality[q]) byQuality[q] = f;
      }
    }
    const matchedFiles = Object.values(byQuality);
    
    if (matchedFiles.length === 0) {
      console.log('[HindMovie] No matching files found on GDShine');
      return [];
    }
    
    const qOrder = { '2160p': 0, '1080p': 1, '720p': 2, '480p': 3 };
    matchedFiles.sort((a, b) => (qOrder[parseQuality(a.name)] || 99) - (qOrder[parseQuality(b.name)] || 99));
    
    const allStreams = [];
    const seenUrls = new Set();
    for (const file of matchedFiles) {
      const quality = parseQuality(file.name);
      const langs = parseLanguages(file.name);
      const sizeStr = file.sizeGB < 1 ? `${Math.round(file.sizeGB * 1024)}MB` : `${file.sizeGB.toFixed(2)}GB`;
      console.log(`[HindMovie] GDShine: ${file.name.substring(0, 60)}... (${quality}, ${sizeStr})`);
      const streamUrl = await getGDShineStreamUrl(file.id);
      if (!streamUrl || seenUrls.has(streamUrl)) continue;
      seenUrls.add(streamUrl);
      allStreams.push(buildStream({
        url: streamUrl,
        resolution: quality === '2160p' ? { w: 3840, h: 2160 } : quality === '1080p' ? { w: 1920, h: 1080 } : quality === '720p' ? { w: 1280, h: 720 } : { w: 852, h: 480 },
        quality,
        audioLanguages: langs,
      }, info, langs, 'gdshine', 'mkv'));
    }
    return allStreams;
  }
}

// ─── Main entry point ──────────────────────────────────────────────────────
async function getStreams(tmdbId, type, season, episode) {
  tmdbId = String(tmdbId);
  const isTV = type === 'tv' || type === 'series';
  console.log(`[HindMovie] Request: tmdb=${tmdbId} type=${type}` + (isTV ? ` S${season}E${episode}` : ''));

  // 1. Get TMDB info
  const info = await getTMDBInfo(tmdbId, type);
  if (!info) {
    console.log('[HindMovie] TMDB fetch failed');
    return [];
  }
  console.log(`[HindMovie] TMDB: ${info.title} IMDB: ${info.imdbId || 'N/A'}`);

  const allStreams = [];
  const seenUrls = new Set();

  // 2. For MOVIES: try iqsmartgames API first (gives HLS with multiple qualities)
  if (!isTV && info.imdbId) {
    console.log('[HindMovie] Trying iqsmartgames API for movie...');
    const iqsmartStreams = await resolveMovieViaIqsmart(info.imdbId, info);
    for (const s of iqsmartStreams) {
      if (!seenUrls.has(s.url)) { seenUrls.add(s.url); allStreams.push(s); }
    }
    console.log(`[HindMovie] iqsmart: ${iqsmartStreams.length} stream(s)`);
  }

  // 3. Try GDShine API for ALL content types (movies, TV, anime, K-drama)
  console.log('[HindMovie] Trying GDShine API...');
  const gdshineStreams = await resolveViaGDShine(info, isTV, season, episode);
  for (const s of gdshineStreams) {
    if (!seenUrls.has(s.url)) { seenUrls.add(s.url); allStreams.push(s); }
  }
  console.log(`[HindMovie] GDShine: ${gdshineStreams.length} stream(s)`);

  // 4. Sort by quality (4K first, then 1080p, etc.)
  const qOrder = { '2160p': 0, '1080p': 1, '720p': 2, '480p': 3, '360p': 4 };
  allStreams.sort((a, b) => (qOrder[a.quality] || 99) - (qOrder[b.quality] || 99));

  console.log(`[HindMovie] ${allStreams.length} stream(s) total`);
  return allStreams;
}

// ─── Module exports ─────────────────────────────────────────────────────────
module.exports = {
  getStreams, getTMDBInfo, searchGDShine, getGDShineStreamUrl,
  resolveMovieViaIqsmart, resolveViaGDShine, resolveStreamViaMultimovies,
  parseMasterM3u8, SITE_BASE, GDSHINE_API, IQSMART_API,
};

// ─── CLI ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log('HindMovie.fit Direct Stream Extractor v2');
    console.log('  Movies + TV + Anime + K-Drama + 4K (no login required)');
    console.log('');
    console.log('Usage: node hindmovie_all_in_one.js <tmdbId> <movie|tv> [season] [episode]');
    console.log('Examples:');
    console.log('  node hindmovie_all_in_one.js 693134 movie          # Dune Part Two');
    console.log('  node hindmovie_all_in_one.js 1396 tv 1 1           # Breaking Bad S01E01');
    console.log('  node hindmovie_all_in_one.js 95479 tv 1 1          # Jujutsu Kaisen');
    console.log('  node hindmovie_all_in_one.js 1228710 movie         # Mandalorian (4K)');
    process.exit(1);
  }
  getStreams(args[0], args[1], args[2], args[3])
    .then(s => {
      console.log('\n=== Final playable streams ===');
      if (s.length === 0) { console.log('No streams found.'); return; }
      s.forEach((x, i) => {
        console.log(`${i+1}. ${x.name}`);
        console.log(`   URL: ${x.url.slice(0, 150)}${x.url.length > 150 ? '...' : ''}`);
      });
      console.log(`\nTotal: ${s.length}`);
    })
    .catch(e => { console.error('FATAL: ' + e.stack); process.exit(1); });
}
