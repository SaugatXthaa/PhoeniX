// src/nuvio/animotvslash.cjs
// AniMoTVSlash (animotvslash.org) — anime scraper, hardsub + softsub (+ movie dub).
//
// Site architecture (mapped live 2026-09-14):
//   - Search:      GET /wp-json/wp/v2/search?search=<title>&per_page=20
//                  → JSON [{title, url: https://animotvslash.org/anime/<slug>/}]
//                  (Dub variants exist as separate "(Dub)" series)
//   - Detail page: /anime/<slug>/ — metadata + all episode links at root:
//                  https://animotvslash.org/<series-slug>-episode-<N>/
//   - Episode page: `select.mirror` options, value = base64(HTML embed):
//        * DIV  → /jw-player|plyr-player|vidstack-player/<b64-json-config>
//                 jw      → config.url  = rumble.com HLS (1080p master)
//                 plyr    → config.url  = videas.fr hlsv1 (720p, needs Origin)
//                 vidstack→ config.url_N = videas.fr MP4 tiers (480/720/1080)
//        * IFRAME vidara.to/e/<filecode> → POST /api/stream {filecode}
//                 → streaming_url (1080p master) + subtitles (VTT)
//        * IFRAME minochinos.com/embed/<id> (VidHide; redirects to *.com)
//                 → packed JS "eval(function(p,a,c,k,e,d)..." → unpack
//                 → hls3/hls2 master.*.m3u8|.txt (1080p)
//        * IFRAME megaplay.buzz/stream/ani/<anilist>/<ep>/<sub|dub>
//                 → data-id → getSourcesNew → AES-enc (same as animesuge)
//                 → decrypt via megaplay_decrypt.cjs → file + tracks (6+ subs)
//        * IFRAME animotvslash.p2pplay.pro → WebTorrent/WebRTC — EXCLUDED
//          (user rule: no torrent streams)
//        * IFRAME bysezoxexe.com (Moon) / abyssplayer.com (Hydrax AES-CTR) /
//          tryembed.us.cc (server-side signature) / vidnest.fun /
//          animotvslash.ru (own-platform SPA) → unresolved, skipped honestly
//
// Quality ceiling: the site maxes at 1080p (rumble/videas/vidara/vidhide
// verified masters). No 4K exists upstream — we label honestly.

'use strict';

const crypto = require('crypto');

const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const TMDB_BASE = 'https://api.themoviedb.org/3';
const BASE = 'https://animotvslash.org';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PROVIDER_NAME = 'AniMoTVSlash';

// megaplay decrypt helper (same AES-256-CBC scheme as animesuge's backend)
const { decryptMegaplayEnc } = require('./megaplay_decrypt.cjs');

// ─── HTTP helpers ────────────────────────────────────────────────────────────

async function fetchText(url, headers = {}, timeoutMs = 12000) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, ...headers },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    if (!res.ok) {
      console.log(`[${PROVIDER_NAME}] HTTP ${res.status} ${url.slice(0, 100)}`);
      return '';
    }
    return await res.text();
  } catch (e) {
    console.log(`[${PROVIDER_NAME}] fetch err ${url.slice(0, 80)}: ${e?.message || e}`);
    return '';
  }
}

async function fetchJson(url, headers = {}, timeoutMs = 12000) {
  const txt = await fetchText(url, { 'Accept': 'application/json', ...headers }, timeoutMs);
  if (!txt) return null;
  try { return JSON.parse(txt); } catch { return null; }
}

// ─── TMDB ────────────────────────────────────────────────────────────────────

async function getTmdbInfo(tmdbId, mediaType) {
  const type = mediaType === 'tv' ? 'tv' : 'movie';
  const url = `${TMDB_BASE}/${type}/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`;
  const j = await fetchJson(url);
  return j;
}

// ─── Title normalization / scoring ──────────────────────────────────────────

function normalizeTitle(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&[a-z]+;|&#\d+;/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(the|a|an|tv|season|part|specials?|movie|ova|ona|oad|dub)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Search + detail matching ───────────────────────────────────────────────

async function searchSeries(query) {
  const data = await fetchJson(`${BASE}/wp-json/wp/v2/search?search=${encodeURIComponent(query)}&per_page=20&_fields=title,url`);
  if (!Array.isArray(data)) return [];
  return data
    .filter(r => r && typeof r.url === 'string' && /\/anime\/[^/]+\/?$/.test(r.url))
    .map(r => ({
      title: String(r.title || '').replace(/&#8217;/g, "'").replace(/&amp;/g, '&').trim(),
      url: r.url,
      slug: r.url.replace(/\/$/, '').split('/').pop(),
    }));
}

// WP search treats punctuation literally — TMDB titles like "Demon Slayer
// -Kimetsu no Yaiba- The Movie: Mugen Train" return nothing raw. Ladder:
// raw → punctuation-stripped → first-6-words → first-3-words. Stop at first
// ladder rung that yields candidates; dedupe by slug.
async function searchSeriesLadder(title) {
  const cleaned = title.replace(/[-–—_:()'"\u2019\u2018]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = cleaned.split(' ').filter(Boolean);
  const attempts = [...new Set([
    title,
    cleaned,
    words.slice(0, 6).join(' '),
    words.slice(0, 3).join(' '),
  ])].filter(q => q && q.length >= 3);
  // Task 41b: MERGE all rungs (dedupe by slug) instead of stopping at the
  // first productive one. WP search is quirky — "Frieren: Beyond Journey's
  // End" returns ONLY the Season-2 posts while plain "Frieren" also surfaces
  // the base (Season 1) post; first-productive-wins never saw the base post.
  const seen = new Set();
  const out = [];
  for (const q of attempts) {
    const r = await searchSeries(q);
    for (const x of r) {
      if (seen.has(x.slug)) continue;
      seen.add(x.slug);
      out.push(x);
    }
  }
  return out;
}

function pickBestSeries(results, tmdbTitle, tmdbYear, season) {
  // Task 41b: wrapper now walks the RANKED list (tryPostCandidates) — the top
  // pick alone loses when the best-scoring post only offers P2P servers while
  // a lower-ranked sibling (e.g. the sub variant) has real ones.
  return rankSeries(results, tmdbTitle, tmdbYear, season)[0] || null;
}

function rankSeries(results, tmdbTitle, tmdbYear, season) {
  const qNorm = normalizeTitle(tmdbTitle);
  const ranked = [];
  for (const r of results) {
    const isDubVariant = /\(dub\)/i.test(r.title) || /-dub(-|$)/.test(r.slug);
    // Sub requests never want "(Dub)" catalog entries; a dub request prefers
    // them (kept so future playable-dub servers are picked up automatically).
    const titleNorm = normalizeTitle(r.title);
    let score = 0;
    if (titleNorm === qNorm) score = 100;
    else if (titleNorm.includes(qNorm)) score = 80;
    else if (qNorm.includes(titleNorm)) score = 70;
    else {
      const qw = qNorm.split(' ').filter(w => w.length > 2);
      const cw = titleNorm.split(' ').filter(w => w.length > 2);
      const ov = qw.filter(w => cw.includes(w)).length;
      score = (ov / Math.max(qw.length, 1)) * 60;
    }
    if (score <= 0) continue;

    ranked.push({ ...r, score });
  }
  // Season awareness — Task 41b: match "-season-N" ANYWHERE in the slug
  // (slugs like "...-season-2-dub" defeat $-anchored regexes), treat dub
  // suffixes as neutral, and penalize the base slug when an S>1 post exists.
  for (const r of ranked) {
    // Task 67: also match word-form ordinals — the site publishes "jujutsu-
    // kaisen-2nd-season" style posts that -season-N alone never sees.
    const slugSeasonM = r.slug.match(/-season-(\d+)(?:-|$)/i)
      || r.slug.match(/-(\d+)(?:nd|rd|th)-season(?:-|$)/i);
    const slugSeason = slugSeasonM ? parseInt(slugSeasonM[1]) : null;
    if (season && season > 1) {
      if (slugSeason === season) r.score += 25;
      else if (slugSeason != null) r.score -= 30;
      else r.score -= 10; // base slug — only right when no season post exists
    } else {
      // S1 (or no season requested): prefer the base slug
      if (slugSeason != null && slugSeason !== 1) r.score -= 25;
      if (/-special|-ova|-movie-|-ona/.test(r.slug)) r.score -= 30;
    }
    // year sanity when the slug carries one
    if (tmdbYear && new RegExp(`-${tmdbYear}(-|$)`).test(r.slug)) r.score += 5;
  }
  // sort score desc; ties break toward the non-dub post (sub posts carry more
  // server variety on this site — dub variants are often P2P-only)
  ranked.sort((a, b) => (b.score - a.score) ||
    ((a.slug.endsWith('-dub') ? 1 : 0) - (b.slug.endsWith('-dub') ? 1 : 0)));
  if (!ranked.length || ranked[0].score < 50) {
    console.log(`[${PROVIDER_NAME}] no confident match for "${tmdbTitle}" (best=${ranked[0]?.score ?? 0})`);
    return [];
  }
  console.log(`[${PROVIDER_NAME}] ranked: ${ranked.slice(0, 3).map(r => `${r.slug}(${r.score})`).join(', ')}`);
  return ranked;
}

// Find the episode-page URL for the requested episode on a detail page.
// Episode pages live at site root: /<series-slug>-episode-<N>/
async function findEpisodeUrl(detailUrl, episode) {
  const html = await fetchText(detailUrl, {}, 15000);
  if (!html) return { url: null, meta: {} };

  // metadata from the detail page
  const meta = {};
  const ogTitle = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/);
  const ogImage = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/);
  const ogDesc = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/);
  if (ogTitle) meta.title = ogTitle[1];
  if (ogImage) meta.poster = ogImage[1];
  if (ogDesc) meta.synopsis = ogDesc[1].replace(/&amp;/g, '&').slice(0, 300);
  const genres = [...html.matchAll(/rel="tag">([^<]+)<\/a>/g)].map(m => m[1]).slice(0, 6);
  if (genres.length) meta.genres = genres;
  const yearMatch = html.match(/(?:Released?|Aired)[:\s<]+[^<]*?(\d{4})/i);
  if (yearMatch) meta.year = yearMatch[1];

  if (!episode || episode < 1) {
    // Movie-type entries: fall back to the *-episode-1 page linked from detail
    episode = 1;
  }
  // exact episode link (trailing slash disambiguates -episode-1 vs -episode-100)
  const esc = String(episode);
  const epRe = new RegExp(`href="(https://animotvslash\\.org/[a-z0-9%-]*-episode-${esc}/)"`, 'i');
  let m = html.match(epRe);
  if (!m) {
    // tolerate .html-less variants and %e2%98%86-style encodings by relaxing
    const epRe2 = new RegExp(`href="(https://animotvslash\\.org/[^"]*-episode-${esc}/?)"`, 'i');
    m = html.match(epRe2);
  }
  if (!m) {
    // Task 67: the site REPUBLISHED episode pages under duplicate slugs —
    // JJK S1 now links /jujutsu-kaisen-episode-1-2/ … -episode-24-2/ (the -N
    // suffix is the re-upload counter). Both exact forms above require the
    // episode number directly followed by '/' or '"', so every re-uploaded
    // page was invisible → "episode N link not found" → honest zero for the
    // whole catalog. Allow an optional -<digits> suffix after the number.
    const epRe3 = new RegExp(`href="(https://animotvslash\\.org/[a-z0-9%-]*-episode-${esc}-\\d+/?)"`, 'i');
    m = html.match(epRe3);
  }
  if (!m) {
    console.log(`[${PROVIDER_NAME}] episode ${episode} link not found on ${detailUrl.slice(0, 80)}`);
    return { url: null, meta };
  }
  return { url: m[1], meta };
}

// ─── Server resolution ───────────────────────────────────────────────────────

function decodePlayerConfig(divHtml) {
  const m = divHtml.match(/(jw-player|plyr-player|vidstack-player)\/([A-Za-z0-9+/=_-]+)/);
  if (!m) return null;
  const kind = m[1].replace('-player', '');
  let cfg;
  try {
    const b64 = m[2] + '='.repeat((4 - (m[2].length % 4)) % 4).replace(/-/g, '+').replace(/_/g, '/');
    cfg = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch { return null; }
  return { kind, cfg };
}

async function resolveVidaraPost(embedUrl) {
  const fc = embedUrl.split('/e/')[1]?.split(/[?#]/)[0];
  if (!fc) return null;
  const origin = new URL(embedUrl).origin;
  try {
    const res = await fetch(`${origin}/api/stream`, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Origin': origin,
        'Referer': embedUrl,
      },
      body: JSON.stringify({ filecode: fc, device: 'desktop' }),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) { console.log(`[${PROVIDER_NAME}] vidara HTTP ${res.status}`); return null; }
    const d = await res.json();
    if (!d || !d.streaming_url) return null;
    const subtitles = Array.isArray(d.subtitles)
      ? d.subtitles.filter(s => s && s.file_path).map(s => ({ url: s.file_path, lang: s.language || 'en' }))
      : [];
    return { url: d.streaming_url, subtitles, label: d.title || '' };
  } catch (e) {
    console.log(`[${PROVIDER_NAME}] vidara err: ${e?.message || e}`);
    return null;
  }
}

// VidHide: embed page ships a p,a,c,k,e,d-packed player that contains the
// direct hls2/hls3 master URLs. Unpack and extract.
function unpackPackerJs(html) {
  const m = html.match(/\}\('(.+?)',(\d+),(\d+),'(.+?)'\.split\('\|'\)/s);
  if (!m) return null;
  const p = m[1], base = parseInt(m[2], 10), keywords = m[4].split('|');
  const chars = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const enc = (n) => { let s = ''; do { s = chars[n % base] + s; n = Math.floor(n / base); } while (n > 0); return s || '0'; };
  const table = new Map();
  for (let i = 0; i < keywords.length; i++) table.set(enc(i), keywords[i]);
  const unescaped = p.replace(/\\(.)/g, '$1');
  return unescaped.replace(/[0-9a-zA-Z]+/g, (t) => table.get(t) || t);
}

async function resolveVidHide(embedUrl) {
  try {
    const res = await fetch(embedUrl, {
      headers: { 'User-Agent': UA, 'Referer': BASE + '/' },
      signal: AbortSignal.timeout(12000),
      redirect: 'follow',
    });
    if (!res.ok) { console.log(`[${PROVIDER_NAME}] vidhide HTTP ${res.status}`); return null; }
    const finalUrl = res.url || embedUrl;
    const html = await res.text();
    const unpacked = unpackPackerJs(html);
    if (!unpacked) { console.log(`[${PROVIDER_NAME}] vidhide: no packed JS`); return null; }
    const urls = unpacked.match(/https?:\/\/[^\s"'\\]+master\.[a-z0-9]{2,4}[^\s"'\\]*/g) || [];
    if (!urls.length) { console.log(`[${PROVIDER_NAME}] vidhide: no master urls`); return null; }
    const origin = new URL(finalUrl).origin;
    // The packed JS ships multiple masters (hls2 *.m3u8 on acek-cdn and hls3
    // *.txt on the mirror CDN). The hls2 host intermittently 403s — probe up
    // to 3 candidates and ship the first that answers with an HLS playlist.
    const candidates = [...urls].sort((a, b) => (Number(/\.m3u8/i.test(b)) - Number(/\.m3u8/i.test(a))));
    for (const u of candidates.slice(0, 3)) {
      const ok = await probeHls(u, origin + '/');
      if (ok) {
        console.log(`[${PROVIDER_NAME}] vidhide: usable master (${/\.txt$/i.test(u) ? 'hls3-txt' : 'm3u8'})`);
        return { url: u, subtitles: [], headers: { Referer: origin + '/' } };
      }
    }
    console.log(`[${PROVIDER_NAME}] vidhide: all masters failed probe`);
    return null;
  } catch (e) {
    console.log(`[${PROVIDER_NAME}] vidhide err: ${e?.message || e}`);
    return null;
  }
}

async function probeHls(url, referer) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: referer },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return false;
    const head = (await res.text()).slice(0, 200);
    return head.includes('#EXTM3U');
  } catch { return false; }
}

async function resolveMegaPlay(streamUrl) {
  const html = await fetchText(streamUrl, { 'Referer': BASE + '/' }, 12000);
  if (!html) return null;
  const idMatch = html.match(/data-id="(\d+)"/);
  if (!idMatch) return null;
  const apiUrl = `https://megaplay.buzz/stream/getSourcesNew?id=${idMatch[1]}`;
  const data = await fetchJson(apiUrl, { 'Referer': streamUrl, 'X-Requested-With': 'XMLHttpRequest' }, 12000);
  if (!data) return null;
  let file = null, tracks = [];
  if (data.enc) {
    const dec = decryptMegaplayEnc(data.enc);
    if (dec) file = dec.file;
  } else if (data.sources) {
    file = typeof data.sources === 'object' ? data.sources.file : data.sources;
  }
  if (!file) return null;
  tracks = Array.isArray(data.tracks) ? data.tracks : [];
  return {
    url: file,
    subtitles: tracks.filter(t => t && t.file).map(t => ({ url: t.file, lang: t.label || t.language || 'en' })),
    label: '',
  };
}

// ─── Episode page → streams ─────────────────────────────────────────────────

const SKIP_HOSTS = [
  { re: /p2pplay\.pro|webtorrent|openwebtorrent/i, reason: 'WebTorrent/P2P — excluded (no-torrent rule)' },
  { re: /bysezoxexe\.com/i, reason: 'Moon uploader-SPA — unresolvable headlessly' },
  { re: /abyssplayer\.com|hydrax/i, reason: 'Hydrax AES-CTR obfuscated — unresolvable' },
  { re: /tryembed\.us\.cc/i, reason: 'server-side request signature — unresolvable' },
  { re: /vidnest\.fun/i, reason: 'VidNest SPA — unresolvable (chunked app)' },
  { re: /animotvslash\.ru/i, reason: 'site own-platform player — unresolvable' },
];

async function parseEpisodePage(epUrl) {
  const html = await fetchText(epUrl, { 'Referer': BASE + '/' }, 15000);
  if (!html) return [];
  const sel = html.match(/<select[^>]*class="[^"]*mirror[^"]*"[^>]*>([\s\S]*?)<\/select>/);
  if (!sel) { console.log(`[${PROVIDER_NAME}] no mirror select on ${epUrl.slice(0, 80)}`); return []; }
  const opts = [...sel[1].matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)</g)];
  console.log(`[${PROVIDER_NAME}] ${opts.filter(o => o[1]).length} server options on ${epUrl.slice(0, 70)}`);

  const entries = [];
  for (const [, val, rawLabel] of opts) {
    if (!val) continue;
    let embedHtml = '';
    try {
      embedHtml = Buffer.from(val + '='.repeat((4 - (val.length % 4)) % 4), 'base64').toString('utf8');
    } catch { continue; }
    const label = rawLabel.replace(/\s+/g, ' ').trim();
    // bucket from label: "Sub - X" | "SoftSub - X" | "Dub - X"
    let bucket = 'sub';
    if (/^softsub/i.test(label)) bucket = 'soft_sub';
    else if (/^dub/i.test(label)) bucket = 'dub';
    const serverName = label.replace(/^(sub|softsub|dub)\s*-\s*/i, '').trim() || 'mirror';
    entries.push({ label, bucket, serverName, embedHtml });
  }

  // classify + resolve in parallel
  const jobs = entries.map(async (e) => {
    try { return await resolveEntry(e); } catch (e2) { console.log(`[${PROVIDER_NAME}] ${e.serverName} resolve err: ${e2?.message || e2}`); return null; }
  });
  const settled = await Promise.all(jobs);
  // resolveEntry returns arrays (a div config can fan out to multiple quality
  // tiers) — flatten so callers always iterate over stream entries.
  return settled.filter(Boolean).flat(2);
}

async function resolveEntry(e) {
  const { embedHtml, bucket, serverName, label } = e;

  // 1. torrent/P2P exclusion FIRST (user rule)
  const skip = SKIP_HOSTS.find(s => s.re.test(embedHtml));
  if (skip) {
    console.log(`[${PROVIDER_NAME}] skip ${serverName}: ${skip.reason}`);
    return null;
  }

  // 2. site player-config DIVs (direct URLs)
  if (embedHtml.trimStart().startsWith('<div')) {
    const cfg = decodePlayerConfig(embedHtml);
    if (!cfg) {
      // aiovg player-embed variant: /player-embed/id/N/?mp4=<base64 url>
      // (ANIMO-O) — the mp4 param IS the direct videas MP4 URL. Trailing '.'
      // chars are padding placeholders; strip before decode.
      const mp4m = embedHtml.match(/[?&]mp4=([A-Za-z0-9+/=_-]+)/);
      if (mp4m) {
        const b64 = mp4m[1].replace(/\./g, '');
        const direct = Buffer.from(b64, 'base64').toString('utf8');
        if (direct.startsWith('http')) {
          const qm = direct.match(/(\d{3,4})p/);
          const quality = qm ? `${qm[1]}p` : '1080p';
          console.log(`[${PROVIDER_NAME}] ${serverName}: player-embed direct MP4 (${quality})`);
          return [{ url: direct, quality, headers: { Referer: BASE + '/' }, bucket, serverName, subtitles: [] }];
        }
      }
      console.log(`[${PROVIDER_NAME}] skip ${serverName}: unknown div player`);
      return null;
    }
    const out = [];
    if (cfg.kind === 'jw' && cfg.cfg && typeof cfg.cfg.url === 'string' && cfg.cfg.url.startsWith('http')) {
      out.push({ url: cfg.cfg.url, quality: '1080p', headers: { Referer: BASE + '/' } });
    } else if (cfg.kind === 'plyr' && cfg.cfg && typeof cfg.cfg.url === 'string' && cfg.cfg.url.startsWith('http')) {
      // videas hlsv1 has an INVERTED hotlink gate (verified live 2026-09-14):
      // 200 with `Origin: https://animotvslash.org` alone, 403 the moment a
      // Referer rides along (same class as *.vimeos.zip). Ship Origin only.
      out.push({ url: cfg.cfg.url, quality: '720p', headers: { Origin: BASE } });
    } else if (cfg.kind === 'vidstack' && cfg.cfg) {
      for (const k of ['url_1080', 'url_720', 'url_480', 'url']) {
        const u = cfg.cfg[k];
        if (u && typeof u === 'string' && u.startsWith('http')) {
          const q = k === 'url' ? '1080p' : k.replace('url_', '') + 'p';
          out.push({ url: u, quality: q, headers: { Referer: BASE + '/' } });
        }
      }
    }
    if (!out.length) { console.log(`[${PROVIDER_NAME}] skip ${serverName}: empty ${cfg.kind} config`); return null; }
    return out.map(o => ({ ...o, bucket, serverName, subtitles: [] }));
  }

  // 3. IFRAME embeds
  const src = embedHtml.match(/src="([^"]+)"/);
  if (!src) { console.log(`[${PROVIDER_NAME}] skip ${serverName}: no iframe src`); return null; }
  const iframeUrl = src[1].replace(/&#038;/g, '&').replace(/&amp;/g, '&');

  if (/vidara\.to/i.test(iframeUrl)) {
    const r = await resolveVidaraPost(iframeUrl);
    if (r) return [{ ...r, bucket, serverName, quality: '1080p' }];
    return null;
  }
  if (/minochinos\.com|vidhide|callistanise/i.test(iframeUrl)) {
    const r = await resolveVidHide(iframeUrl);
    if (r) return [{ url: r.url, quality: '1080p', headers: r.headers, bucket, serverName, subtitles: r.subtitles }];
    return null;
  }
  if (/megaplay\.buzz/i.test(iframeUrl)) {
    const r = await resolveMegaPlay(iframeUrl);
    if (r) return [{ url: r.url, quality: '1080p', headers: { Referer: 'https://megaplay.buzz/' }, bucket, serverName, subtitles: r.subtitles }];
    return null;
  }

  console.log(`[${PROVIDER_NAME}] skip ${serverName}: unhandled embed ${iframeUrl.slice(0, 60)}`);
  return null;
}

// ─── Stream object builder ──────────────────────────────────────────────────

function buildStream(res, animeTitle, episode) {
  const bucketLabel = res.bucket === 'dub' ? 'DUB' : res.bucket === 'soft_sub' ? 'SOFTSUB' : 'SUB';
  const isHls = /\.m3u8|master\.txt|/i.test(res.url) || /hls/i.test(res.ext || '');
  const audio = res.bucket === 'dub' ? 'english' : 'japanese';
  return {
    name: `AniMoTV\n${bucketLabel} ${res.quality} ${res.serverName}`,
    title: `${animeTitle}${episode ? ` - Episode ${episode}` : ''} (${bucketLabel} · ${res.serverName})`,
    url: res.url,
    quality: res.quality,
    headers: res.headers || {},
    subtitles: (res.subtitles || []).map(s => ({ url: s.url, lang: s.lang || 'en', name: s.lang || 'English' })),
    behaviorHints: {
      notWebReady: false,
      ...(res.headers && Object.keys(res.headers).length ? { headers: res.headers } : {}),
    },
    meta: {
      provider: PROVIDER_NAME,
      source: 'animotvslash.org',
      server: res.serverName,
      type: isHls ? 'hls' : 'mp4',
      quality: res.quality,
      audio,
      language: [res.bucket === 'dub' ? 'en' : 'ja'],
      category: res.bucket,
      title: animeTitle,
      episode,
      directStream: true,
    },
    // buildStreamResults maps this to country codes (Japanese → ja / English → en)
    audioTracks: [res.bucket === 'dub' ? 'English' : 'Japanese'],
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function getStreams(tmdbId, mediaType, season, episode) {
  console.log(`[${PROVIDER_NAME}] getStreams: ${tmdbId} ${mediaType} S${season || '?'}E${episode || '?'}`);
  try {
    // 1. TMDB title
    const info = await getTmdbInfo(tmdbId, mediaType);
    if (!info) return [];
    const rawTitle = mediaType === 'tv' ? info.name : info.title;
    const year = (mediaType === 'tv' ? info.first_air_date : info.release_date || '').slice(0, 4);
    console.log(`[${PROVIDER_NAME}] TMDB: "${rawTitle}" (${year}) S${season || '-'}E${episode || '-'}`);
    const cleanTitle = String(rawTitle || '').replace(/\s*\(.*?\)\s*$/, '').trim() || rawTitle;

    // 2. search (ladder) + rank series posts
    const results = await searchSeriesLadder(cleanTitle);
    if (!results.length) { console.log(`[${PROVIDER_NAME}] no search results`); return []; }
    const ranked = rankSeries(results, cleanTitle, year, season);
    if (!ranked.length) return [];

    // 3-5. Walk near-equal top candidates (within 5 points of the leader —
    // effectively sub/dub variants of the SAME season post) — ship the first
    // that yields resolvable (non-P2P) servers. The best-scoring post alone
    // loses when it only offers WebTorrent embeds while its sibling has real
    // players (Frieren S2: "-season-2-dub" = P2P-only, "-season-2" =
    // ANIMO-M/ANIMO-O). The narrow band also PREVENTS cross-season leakage:
    // an S1 request must never fall through to a lower-scoring S2 post.
    const topScore = ranked[0].score;
    const band = ranked.filter(r => r.score >= topScore - 5).slice(0, 3);
    for (const best of band) {
      const { url: epUrl, meta: detailMeta } = await findEpisodeUrl(best.url, episode);
      if (!epUrl) continue;
      const animeTitle = detailMeta.title || best.title;

      const resolved = await parseEpisodePage(epUrl);
      if (!resolved.length) {
        console.log(`[${PROVIDER_NAME}] post ${best.slug} → 0 resolvable servers, trying next candidate`);
        continue;
      }

      // dedupe by URL, build stream objects (sub first, then softsub, then dub)
      const seen = new Set();
      const order = { sub: 0, soft_sub: 1, dub: 2 };
      const streams = [];
      for (const r of resolved.sort((a, b) => (order[a.bucket] ?? 9) - (order[b.bucket] ?? 9))) {
        if (seen.has(r.url)) continue;
        seen.add(r.url);
        streams.push(buildStream(r, animeTitle, episode));
      }
      if (streams.length) {
        console.log(`[${PROVIDER_NAME}] post ${best.slug} → returning ${streams.length} stream(s)`);
        return streams;
      }
      console.log(`[${PROVIDER_NAME}] post ${best.slug} → 0 playable streams, trying next candidate`);
    }
    console.log(`[${PROVIDER_NAME}] all candidates exhausted`);
    return [];
  } catch (e) {
    console.error(`[${PROVIDER_NAME}] Error: ${e?.message || e}`);
    return [];
  }
}

module.exports = { getStreams, searchSeries, pickBestSeries, parseEpisodePage, PROVIDER_NAME };
