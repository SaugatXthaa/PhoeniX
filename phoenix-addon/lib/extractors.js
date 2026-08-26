/**
 * lib/extractors.js — Direct stream URL extractors for embed/locker hosts
 *
 * Faithful ports of working extractor logic from:
 *   - webstreamr (Voe, Streamtape, Uqload, DoodStream, Mixdrop, FileMoon, FileLions,
 *     SuperVideo, Dropload, Fastream, VidSrc, HubCloud)
 *   - stremify (Voe simplified, Streamtape regex, Uqload regex, Govid, Visioncine, EvalResolver)
 *
 * Each extractor: async function(url, meta) → array of stream objects
 * Returns: [{ url, label, sizeBytes, requestHeaders, height, format }]
 *
 * Then converted to Stremio stream format by the caller.
 */

const cheerio = require('cheerio');
const axios = require('axios');
const https = require('https');
const { fetch } = require('./fetcher');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function parseBytes(str) {
  if (!str) return null;
  const m = String(str).match(/([\d.]+)\s*(TB|GB|MB|KB)/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const u = m[2].toUpperCase();
  return u === 'TB' ? n * 1024 ** 4 : u === 'GB' ? n * 1024 ** 3 :
         u === 'MB' ? n * 1024 ** 2 : n * 1024;
}

function getResolution(name) {
  if (!name) return null;
  if (/2160p|4k|uhd/i.test(name)) return '2160p';
  if (/1080p|fhd/i.test(name)) return '1080p';
  if (/720p|hd/i.test(name)) return '720p';
  if (/480p|sd/i.test(name)) return '480p';
  return null;
}

// ============================================
// VOE — voe.sx and many mirror domains
// Pattern: window.location.href = '...'; then fetch page → find m3u8 in JSON config
// Source: webstreamr/src/extractor/Voe.ts + stremify/embeds/voe.ts
// ============================================
const VOE_MIRRORS = [
  'voe.sx', 'voe-unblock.com', 'v-o-e-unblock.com',
  '19turanosephantasia.com', '20demidistance9elongations.com',
  '30sensualizeexpression.com', '321naturelikefurfuroid.com',
  '35volitantplimsoles5.com', '449unceremoniousnasoseptal.com',
  '745mingiestblissfully.com', 'adrianmissionminute.com',
  'alleneconomicmatter.com', 'antecoxalbobbing1010.com',
  'apinchcaseation.com', 'audaciousdefaulthouse.com',
  'availedsmallest.com', 'bigclatterhomesguideservice.com',
  'boonlessbestselling244.com', 'bradleyviewdoctor.com',
  'brittneystandardwestern.com', 'brucevotewithin.com',
  'christopheruntilpoint.com', 'chromotypic.com',
  'chuckle-tube.com', 'cindyeyefinal.com',
  'counterclockwisejacky.com', 'crownmakermacaronicism.com',
  'crystaltreatmenteast.com', 'cyamidpulverulence530.com',
  'diananatureforeign.com', 'donaldlineelse.com',
  'edwardarriveoften.com', 'erikcoldperson.com',
  'figeterpiazine.com', 'fittingcentermondaysunday.com',
  'fraudclatterflyingcar.com', 'gamoneinterrupted.com',
  'generatesnitrosate.com', 'goofy-banana.com',
  'graceaddresscommunity.com', 'greaseball6eventual20.com',
  'guidon40hyporadius9.com', 'heatherdiscussionwhen.com',
  'housecardsummerbutton.com', 'jamessoundcost.com',
  'jamiesamewalk.com', 'jasminetesttry.com',
  'jayservicestuff.com', 'jennifercertaindevelopment.com',
  'jilliandescribecompany.com', 'johnalwayssame.com',
  'jonathansociallike.com', 'josephseveralconcern.com',
  'kathleenmemberhistory.com', 'kellywhatcould.com',
  'kennethofficialitem.com', 'kinoger.ru',
  'kristiesoundsimply.com', 'lancewhosedifficult.com',
  'launchreliantcleaverriver.com', 'lauradaydo.com',
  'lisatrialidea.com', 'loriwithinfamily.com',
  'lukecomparetwo.com', 'lukesitturn.com',
  'mariatheserepublican.com', 'matriculant401merited.com',
  'maxfinishseveral.com', 'metagnathtuggers.com',
  'michaelapplysome.com', 'mikaylaarealike.com',
  'nathanfromsubject.com', 'nectareousoverelate.com',
  'nonesnanking.com', 'paulkitchendark.com',
  'realfinanceblogcenter.com', 'rebeccaneverbase.com',
  'reputationsheriffkennethsand.com', 'richardsignfish.com',
  'roberteachfinal.com', 'robertordercharacter.com',
  'robertplacespace.com', 'sandratableother.com',
  'sandrataxeight.com', 'scatch176duplicities.com',
  'sethniceletter.com', 'shannonpersonalcost.com',
  'simpulumlamerop.com', 'smoki.cc',
  'stevenimaginelittle.com', 'strawberriesporail.com',
  'telyn610zoanthropy.com', 'timberwoodanotia.com',
  'toddpartneranimal.com', 'toxitabellaeatrebates306.com',
  'uptodatefinishconferenceroom.com', 'valeronevijao.com',
  'walterprettytheir.com', 'wolfdyslectic.com',
  'yodelswartlike.com'
];

async function extractVoe(url, meta = {}) {
  const headers = { Referer: meta.referer || url, 'User-Agent': DEFAULT_UA };
  try {
    const r = await axios.get(url, {
      httpsAgent, headers, timeout: 10000,
      maxRedirects: 5, validateStatus: () => true
    });
    if (r.status !== 200) return [];

    // Check for window.location redirect (webstreamr pattern)
    const redirectMatch = r.data.match(/window\.location\.href\s*=\s*'([^']+)/);
    if (redirectMatch && redirectMatch[1]) {
      return extractVoe(redirectMatch[1], meta);
    }

    // stremify pattern: let nodeDetails = prompt("Node", "https://...m3u8");
    const nodeMatch = r.data.match(/let nodeDetails\s*=\s*prompt\("Node",\s*"(.*?)"/);
    if (nodeMatch?.[1]) {
      return [{
        url: nodeMatch[1],
        label: 'Voe',
        format: 'hls',
        height: getResolution(r.data) || null,
        requestHeaders: { Referer: url }
      }];
    }

    // Fallback: look for m3u8 URLs in JSON config
    const m3u8Matches = r.data.match(/https:\/\/[^"'\s]+\.m3u8[^"'\s]*/gi) || [];
    if (m3u8Matches.length > 0) {
      return [{
        url: m3u8Matches[0],
        label: 'Voe',
        format: 'hls',
        requestHeaders: { Referer: url }
      }];
    }

    return [];
  } catch (e) { return []; }
}

// ============================================
// STREAMTAPE — streamtape.com and many adblock mirrors
// Pattern: script tag with ideoolink, parse JS to build mp4 URL
// Source: stremify/embeds/streamtape.ts (simpler) + webstreamr (full)
// ============================================
const STREAMTAPE_MIRRORS = [
  'streamtape.com', 'streamta.pe', 'strtape.cloud', 'strcloud.link',
  'strcloud.club', 'strtpe.link', 'scloud.online', 'stape.fun',
  'streamadblockplus.com', 'shavetape.cash', 'streamta.site',
  'streamadblocker.xyz', 'tapewithadblock.org', 'adblocktape.wiki',
  'antiadtape.com', 'tapeblocker.com', 'streamnoads.com',
  'tapeadvertisement.com', 'tapeadsenjoyer.com', 'watchadsontape.com'
];

async function extractStreamtape(url, meta = {}) {
  try {
    // Normalize /e/ → /v/ (webstreamr pattern)
    const normUrl = new URL(url);
    if (normUrl.pathname.includes('/e/')) {
      normUrl.pathname = normUrl.pathname.replace('/e/', '/v/');
    }
    const r = await axios.get(normUrl.toString(), {
      httpsAgent,
      headers: { 'User-Agent': DEFAULT_UA, Referer: meta.referer || normUrl.origin },
      timeout: 10000, validateStatus: () => true
    });
    if (r.status !== 200) return [];

    // stremify pattern: ideoolink script
    const $ = cheerio.load(r.data);
    let scriptContent = '';
    $('script').each((_, el) => {
      const t = $(el).html();
      if (t && t.includes("document.getElementById('ideoolink').innerHTML")) {
        scriptContent = t;
      }
    });

    if (scriptContent) {
      const rawLinkMatch = scriptContent.match(/document\.getElementById\('ideoolink'\)\.innerHTML\s*=\s*(.*);/);
      if (rawLinkMatch) {
        let rawLink = rawLinkMatch[1].replace(/["'+]/g, '');
        const rawLinkPart2Match = rawLink.match(/\((.*?)\)/);
        let rawLinkPart2 = '';
        if (rawLinkPart2Match) {
          rawLinkPart2 = rawLinkPart2Match[1].substring(4);
        }
        let rawLinkPart1 = rawLink.replace(/\(.*?\)/, '');
        let mp4Link = `http:/${rawLinkPart1 + rawLinkPart2}`.replace(' ', '');
        mp4Link = mp4Link.replace(`  .substring(1).substring(2)`, ``);
        // Convert to https
        if (mp4Link.startsWith('http:/')) mp4Link = mp4Link.replace('http:/', 'https://');
        return [{
          url: mp4Link,
          label: 'Streamtape',
          format: 'mp4',
          requestHeaders: { Referer: normUrl.origin + '/' }
        }];
      }
    }
    return [];
  } catch (e) { return []; }
}

// ============================================
// UQLOAD — uqload.net/cx/is
// Pattern: regex for .mp4 URLs in HTML
// Source: stremify/embeds/uqload.ts (simple regex)
// ============================================
async function extractUqload(url, meta = {}) {
  try {
    const r = await axios.get(url, {
      httpsAgent,
      headers: { 'User-Agent': DEFAULT_UA, Referer: meta.referer || url },
      timeout: 10000, validateStatus: () => true
    });
    if (r.status !== 200) return [];

    if (/File Not Found/.test(r.data)) return [];

    const regex = /\b(https?:\/\/(?:www\.)?[^ \n]+\/)([^ \n]+\.mp4)\b/g;
    const matches = r.data.match(regex);
    if (!matches || matches.length === 0) return [];

    const heightMatch = r.data.match(/\d{3,}x(\d{3,})/);
    const height = heightMatch ? parseInt(heightMatch[1], 10) : null;

    const $ = cheerio.load(r.data);
    const title = $('h1').first().text().trim();

    return matches.slice(0, 3).map(u => ({
      url: u,
      label: 'Uqload',
      format: 'mp4',
      height,
      requestHeaders: { Referer: url }
    }));
  } catch (e) { return []; }
}

// ============================================
// DOODSTREAM — dood.to/e/<id> → dood.so/d/<id> download page
// Pattern: parse /d/ page for direct mp4 link
// Source: webstreamr/src/extractor/DoodStream.ts
// ============================================
async function extractDoodstream(url, meta = {}) {
  try {
    // Normalize to /e/ form
    const normUrl = new URL(url);
    const videoId = normUrl.pathname.replace(/\/+$/, '').split('/').at(-1);
    const embedUrl = `https://dood.to/e/${videoId}`;

    const r = await axios.get(embedUrl, {
      httpsAgent,
      headers: { 'User-Agent': DEFAULT_UA, Referer: meta.referer || embedUrl },
      timeout: 10000, validateStatus: () => true
    });
    if (r.status !== 200 || /Video not found/.test(r.data)) return [];

    // Download page approach
    const dlUrl = embedUrl.replace('/e/', '/d/');
    const dlR = await axios.get(dlUrl, {
      httpsAgent,
      headers: { 'User-Agent': DEFAULT_UA, Referer: embedUrl },
      timeout: 10000, validateStatus: () => true
    });
    if (dlR.status !== 200) return [];

    // Look for direct download link
    const dlMatch = dlR.data.match(/href="([^"]+download[^"]*)"/i) ||
                   dlR.data.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/);
    if (dlMatch?.[1]) {
      const title = cheerio.load(r.data)('title').text().trim().replace(/ - DoodStream$/, '').trim();
      const sizeMatch = dlR.data.match(/([\d.]+ ?[GM]B)/);
      return [{
        url: dlMatch[1].startsWith('http') ? dlMatch[1] : new URL(dlMatch[1], dlUrl).toString(),
        label: 'DoodStream',
        format: 'mp4',
        sizeBytes: parseBytes(sizeMatch?.[1]),
        requestHeaders: { Referer: dlUrl }
      }];
    }
    return [];
  } catch (e) { return []; }
}

// ============================================
// MIXDROP — mixdrop.co / mixdroop.co
// Pattern: /e/ → /f/, extract from script
// Source: webstreamr/src/extractor/Mixdrop.ts
// ============================================
async function extractMixdrop(url, meta = {}) {
  try {
    const fileUrl = new URL(url);
    fileUrl.pathname = fileUrl.pathname.replace('/e/', '/f/');
    const r = await axios.get(fileUrl.toString(), {
      httpsAgent,
      headers: { 'User-Agent': DEFAULT_UA, Referer: meta.referer || fileUrl.origin },
      timeout: 10000, validateStatus: () => true
    });
    if (r.status !== 200) return [];
    if (/can't find the (file|video)/.test(r.data)) return [];

    // Mixdrop uses eval-packed JS to hide the video URL
    // Look for MDCore.__video_hosted_url or similar
    const urlMatch = r.data.match(/window\.location\.href\s*=\s*['"]([^'"]+\.mp4[^'"]*)['"]/) ||
                     r.data.match(/["'](https?:\/\/[^"']*mixdrop[^"']*\.mp4[^"']*)['"]/) ||
                     r.data.match(/video_url\s*=\s*['"]([^'"]+)['"]/);

    const $ = cheerio.load(r.data);
    const title = $('.title b').first().text().trim();
    const sizeMatch = r.data.match(/([\d.,]+ ?[GM]B)/);
    const sizeBytes = parseBytes(sizeMatch?.[1]?.replace(',', ''));

    if (urlMatch?.[1]) {
      return [{
        url: urlMatch[1],
        label: 'Mixdrop',
        format: 'mp4',
        sizeBytes,
        requestHeaders: { Referer: fileUrl.origin + '/' }
      }];
    }
    return [];
  } catch (e) { return []; }
}

// ============================================
// FILEMOON — filemoon.sx
// Pattern: unpack eval-packed JS to find m3u8 URL
// Source: webstreamr/src/extractor/FileMoon.ts (uses unpacker lib)
// ============================================
async function extractFilemoon(url, meta = {}) {
  try {
    const normUrl = new URL(url);
    normUrl.pathname = normUrl.pathname.replace('/e/', '/d/');
    const r = await axios.get(normUrl.toString(), {
      httpsAgent,
      headers: { 'User-Agent': DEFAULT_UA, Referer: meta.referer || normUrl.origin },
      timeout: 10000, validateStatus: () => true
    });
    if (r.status !== 200 || /Page not found/.test(r.data)) return [];

    // Look for iframe src to follow
    const iframeMatch = r.data.match(/iframe[^>]+src=["']([^"']+)["']/g);
    if (iframeMatch && iframeMatch.length > 0) {
      const lastSrc = iframeMatch[iframeMatch.length - 1].match(/src=["']([^"']+)["']/);
      if (lastSrc?.[1]) {
        return extractFilemoon(lastSrc[1], { ...meta, referer: normUrl.toString() });
      }
    }

    // Look for m3u8 in eval-packed script
    const evalMatch = r.data.match(/eval\(function\(p,a,c,k,e,d\).*\)\)/);
    if (evalMatch) {
      try {
        const unpacked = simpleUnpack(evalMatch[0]);
        const m3u8Match = unpacked.match(/sources:\[{file:"([^"]+)"/) ||
                          unpacked.match(/(https:\/\/[^"'\s]+\.m3u8[^"'\s]*)/);
        if (m3u8Match?.[1]) {
          const heightMatch = unpacked.match(/(\d{3,})p/);
          return [{
            url: m3u8Match[1],
            label: 'FileMoon',
            format: 'hls',
            height: heightMatch ? parseInt(heightMatch[1], 10) : null,
            requestHeaders: { Referer: normUrl.origin + '/' }
          }];
        }
      } catch (e) { /* fall through */ }
    }
    return [];
  } catch (e) { return []; }
}

// ============================================
// FILELIONS — filelions.to, vidhide.com (and many mirrors)
// Pattern: similar to FileMoon, uses eval-packed JS
// Source: webstreamr/src/extractor/FileLions.ts
// ============================================
const FILELIONS_MIRRORS = [
  'filelions', 'lions', 'vidhide.com', 'vidhide.fun', 'vidhidefast.com',
  'vidhidehub.com', 'vidhideplus.com', 'vidhidepre.com', 'vidhidepro.com',
  'vidhidevip.com', 'mivalyo.com', 'smoothpre.com', 'movearnpre.com',
  'peytonepre.com', 'ryderjet.com', 'taylorplayer.com', 'azipcdn.com',
  'callistanise.com', 'dingtezuni.com', 'dintezuvio.com'
];

async function extractFilelions(url, meta = {}) {
  try {
    const normUrl = new URL(url);
    normUrl.pathname = normUrl.pathname.replace('/v/', '/f/').replace('/download/', '/f/').replace('/file/', '/f/');

    const r = await axios.get(normUrl.toString(), {
      httpsAgent,
      headers: { 'User-Agent': DEFAULT_UA, Referer: meta.referer || normUrl.origin },
      timeout: 10000, validateStatus: () => true
    });
    if (r.status !== 200) return [];
    if (/File Not Found|deleted by administration/.test(r.data)) return [];

    const evalMatch = r.data.match(/eval\(function\(p,a,c,k,e,d\).*\)\)/);
    if (evalMatch) {
      try {
        const unpacked = simpleUnpack(evalMatch[0]);
        const m3u8Match = unpacked.match(/sources:\[{file:"([^"]+)"/) ||
                          unpacked.match(/(https:\/\/[^"'\s]+\.m3u8[^"'\s]*)/);
        if (m3u8Match?.[1]) {
          const heightMatch = unpacked.match(/(\d{3,})p/);
          const sizeMatch = r.data.match(/([\d.]+ ?[GM]B)/);
          const $ = cheerio.load(r.data);
          const title = $('meta[name="description"]').attr('content') || '';
          return [{
            url: m3u8Match[1],
            label: 'FileLions',
            format: 'hls',
            height: heightMatch ? parseInt(heightMatch[1], 10) : null,
            sizeBytes: parseBytes(sizeMatch?.[1]),
            title,
            requestHeaders: { Referer: normUrl.origin + '/' }
          }];
        }
      } catch (e) { /* fall through */ }
    }
    return [];
  } catch (e) { return []; }
}

// ============================================
// SUPERVIDEO — supervideo.cc
// Pattern: eval-packed JS with sources:[{file:"..."}]
// Source: webstreamr/src/extractor/SuperVideo.ts
// ============================================
async function extractSupervideo(url, meta = {}) {
  try {
    const normUrl = new URL(url);
    normUrl.pathname = normUrl.pathname.replace('/e/', '/').replace('/k/', '/').replace('/embed-', '/');

    const r = await axios.get(normUrl.toString(), {
      httpsAgent,
      headers: { 'User-Agent': DEFAULT_UA, Referer: meta.referer || normUrl.origin },
      timeout: 10000, validateStatus: () => true
    });
    if (r.status !== 200) return [];
    if (/'The file was deleted|The file expired|Video is processing/.test(r.data)) return [];

    const evalMatch = r.data.match(/eval\(function\(p,a,c,k,e,d\).*\)\)/);
    if (evalMatch) {
      try {
        const unpacked = simpleUnpack(evalMatch[0]);
        const m3u8Match = unpacked.match(/sources:\[{file:"(.*?)"/);
        if (m3u8Match?.[1]) {
          const heightAndSizeMatch = r.data.match(/\d{3,}x(\d{3,}),\s*([\d.]+ ?[GM]B)/);
          const $ = cheerio.load(r.data);
          const title = $('.download__title').first().text().trim();
          return [{
            url: m3u8Match[1],
            label: 'SuperVideo',
            format: 'hls',
            height: heightAndSizeMatch ? parseInt(heightAndSizeMatch[1], 10) : null,
            sizeBytes: parseBytes(heightAndSizeMatch?.[2]),
            title,
            requestHeaders: { Referer: 'https://supervideo.cc/' }
          }];
        }
      } catch (e) { /* fall through */ }
    }
    return [];
  } catch (e) { return []; }
}

// ============================================
// DROPLOAD — dropload.io
// Pattern: eval-packed JS, similar to SuperVideo
// Source: webstreamr/src/extractor/Dropload.ts
// ============================================
async function extractDropload(url, meta = {}) {
  try {
    const normUrl = new URL(url);
    normUrl.pathname = normUrl.pathname.replace('/d/', '/').replace('/e/', '/').replace('/embed-', '/');

    const r = await axios.get(normUrl.toString(), {
      httpsAgent,
      headers: { 'User-Agent': DEFAULT_UA, Referer: meta.referer || normUrl.origin },
      timeout: 10000, validateStatus: () => true
    });
    if (r.status !== 200) return [];
    if (r.data.includes('File Not Found') || r.data.includes('Pending in queue')) return [];

    const evalMatch = r.data.match(/eval\(function\(p,a,c,k,e,d\).*\)\)/);
    if (evalMatch) {
      try {
        const unpacked = simpleUnpack(evalMatch[0]);
        const m3u8Match = unpacked.match(/sources:\[{file:"(.*?)"/);
        if (m3u8Match?.[1]) {
          const heightMatch = r.data.match(/\d{3,}x(\d{3,}),/);
          const sizeMatch = r.data.match(/([\d.]+ ?[GM]B)/);
          const $ = cheerio.load(r.data);
          const title = $('.videoplayer h1').first().text().trim();
          return [{
            url: m3u8Match[1],
            label: 'Dropload',
            format: 'hls',
            height: heightMatch ? parseInt(heightMatch[1], 10) : null,
            sizeBytes: parseBytes(sizeMatch?.[1]),
            title,
            requestHeaders: { Referer: 'https://dr0pstream.com/' }
          }];
        }
      } catch (e) { /* fall through */ }
    }
    return [];
  } catch (e) { return []; }
}

// ============================================
// FASTREAM — fastream.to
// Pattern: /d/ page has direct m3u8 link
// Source: webstreamr/src/extractor/Fastream.ts
// ============================================
async function extractFastream(url, meta = {}) {
  try {
    const normUrl = new URL(url);
    normUrl.pathname = normUrl.pathname.replace('/e/', '/embed-').replace('/d/', '/embed-');

    const dlUrl = new URL(normUrl);
    dlUrl.pathname = dlUrl.pathname.replace('/embed-', '/d/');

    const r = await axios.get(dlUrl.toString(), {
      httpsAgent,
      headers: { 'User-Agent': DEFAULT_UA, Referer: meta.referer || dlUrl.origin },
      timeout: 10000, validateStatus: () => true
    });
    if (r.status !== 200 || /No such file/.test(r.data)) return [];

    // Look for m3u8 in the page
    const m3u8Match = r.data.match(/(https:\/\/[^"'\s]+\.m3u8[^"'\s]*)/i);
    if (m3u8Match?.[1]) {
      const heightAndSizeMatch = r.data.match(/\d{3,}x(\d{3,}),\s*([\d.]+ ?[GM]B)/);
      const titleMatch = r.data.match(/>Download (.*?)</);
      return [{
        url: m3u8Match[1],
        label: 'Fastream',
        format: 'hls',
        height: heightAndSizeMatch ? parseInt(heightAndSizeMatch[1], 10) : null,
        sizeBytes: parseBytes(heightAndSizeMatch?.[2]),
        title: titleMatch?.[1] || '',
        requestHeaders: { Referer: dlUrl.origin + '/' }
      }];
    }
    return [];
  } catch (e) { return []; }
}

// ============================================
// VIDSRC — vidsrc.me/embed/movie?imdb=tt123
// Pattern: parse iframe + CloudStream Pro server → m3u8
// Source: webstreamr/src/extractor/VidSrc.ts
// ============================================
async function extractVidsrc(url, meta = {}) {
  try {
    // Generate random IP for X-Forwarded-For (webstreamr trick)
    const randomIp = `${Math.floor(Math.random() * 223) + 1}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;
    const r = await axios.get(url, {
      httpsAgent,
      headers: {
        'User-Agent': DEFAULT_UA,
        'X-Forwarded-For': randomIp,
        'Referer': meta.referer || url
      },
      timeout: 10000, validateStatus: () => true
    });
    if (r.status !== 200) return [];

    // Server returns commented-out HTML
    const html = r.data.replace('<!--', '').replace('-->', '');
    const $ = cheerio.load(html);

    const iframeSrc = $('#player_iframe').attr('src');
    if (!iframeSrc) return [];

    const iframeUrl = new URL(iframeSrc.replace(/^\/\//, 'https://'));
    const title = $('title').text().trim();

    // Find CloudStream Pro server data-hash
    const servers = $('.server').map((_, el) => ({
      serverName: $(el).text().trim(),
      dataHash: $(el).data('hash')
    })).toArray();

    const cloudStream = servers.find(s => s.serverName === 'CloudStream Pro');
    if (!cloudStream?.dataHash) return [];

    const rcpUrl = new URL(`/rcp/${cloudStream.dataHash}`, iframeUrl.origin);
    const rcpR = await axios.get(rcpUrl.toString(), {
      httpsAgent,
      headers: { 'User-Agent': DEFAULT_UA, Referer: iframeUrl.origin },
      timeout: 10000, validateStatus: () => true
    });
    const srcMatch = rcpR.data.match(/src:\s?'([^']+)'/);
    if (!srcMatch?.[1]) return [];

    const playerUrl = new URL(srcMatch[1], iframeUrl.origin);
    const playerR = await axios.get(playerUrl.toString(), {
      httpsAgent,
      headers: { 'User-Agent': DEFAULT_UA, Referer: rcpUrl.toString() },
      timeout: 10000, validateStatus: () => true
    });

    const fileMatch = playerR.data.match(/(https:\/\/.*?{v\d}.*?)\s+or/);
    if (!fileMatch?.[1]) return [];

    const m3u8Url = fileMatch[1].replace(/{v\d}/, iframeUrl.host);
    return [{
      url: m3u8Url,
      label: 'VidSrc (CloudStream)',
      format: 'hls',
      title,
      requestHeaders: { Referer: iframeUrl.toString() }
    }];
  } catch (e) { return []; }
}

// ============================================
// HUBCLOUD — hubcloud.in / hubcloud.one / hubdrive.space
// Pattern: var url = '...' redirect → /u/<id> page → FSL/FSLv2/PixelServer links
// Source: webstreamr/src/extractor/HubCloud.ts + HubDrive.ts
// ============================================
async function extractHubcloud(url, meta = {}) {
  const headers = { Referer: meta.referer || url, 'User-Agent': DEFAULT_UA };
  let html;
  try {
    const r = await axios.get(url, { httpsAgent, headers, timeout: 10000, validateStatus: () => true });
    if (r.status !== 200) return [];
    html = r.data;
  } catch (e) { return []; }

  // Check for JS redirect
  const redirectMatch = html.match(/var\s+url\s*=\s*['"]([^'"]+)['"]/);
  let redirectUrl = null;
  if (redirectMatch?.[1]) {
    redirectUrl = redirectMatch[1];
    try {
      const r2 = await axios.get(redirectUrl, {
        httpsAgent,
        headers: { Referer: url, 'User-Agent': DEFAULT_UA },
        timeout: 10000, validateStatus: () => true
      });
      html = r2.data;
    } catch (e) { /* use original */ }
  }

  const $ = cheerio.load(html);
  const title = $('title').text().trim();
  const sizeText = $('#size').text() || $('td:contains("Size")').next().text() || '';
  const sizeBytes = parseBytes(sizeText);
  const res = getResolution(title + ' ' + sizeText);

  const results = [];

  $('a').each((_, el) => {
    const text = $(el).text().trim();
    const href = $(el).attr('href');
    if (!href || !text) return;

    if (/FSL/i.test(text) && !/FSLv2/i.test(text)) {
      results.push({
        url: href,
        label: 'HubCloud (FSL)',
        format: 'mp4',
        sizeBytes,
        height: res,
        requestHeaders: { Referer: redirectUrl || url }
      });
    } else if (/FSLv2/i.test(text)) {
      results.push({
        url: href,
        label: 'HubCloud (FSLv2)',
        format: 'mp4',
        sizeBytes,
        height: res,
        requestHeaders: { Referer: redirectUrl || url }
      });
    } else if (/PixelServer/i.test(text)) {
      // /u/<id> → /api/file/<id>?download=
      let dlUrl = href;
      try {
        const u = new URL(href);
        if (u.pathname.startsWith('/u/')) {
          dlUrl = u.href.replace('/u/', '/api/file/');
          dlUrl += (dlUrl.includes('?') ? '&' : '?') + 'download=';
        }
      } catch {}
      results.push({
        url: dlUrl,
        label: 'HubCloud (PixelServer)',
        format: 'mp4',
        sizeBytes,
        height: res,
        requestHeaders: { Referer: href }
      });
    } else if (/Fastream/i.test(text)) {
      results.push({
        url: href,
        label: 'HubCloud (Fastream)',
        format: 'hls',
        sizeBytes,
        height: res,
        requestHeaders: { Referer: redirectUrl || url }
      });
    } else if (/DoodStream|Dood/i.test(text)) {
      results.push({
        url: href,
        label: 'HubCloud (Dood)',
        format: 'mp4',
        sizeBytes,
        height: res,
        requestHeaders: {}
      });
    } else if (/G-Drive|GDrive|GDToot/i.test(text)) {
      results.push({
        url: href,
        label: 'HubCloud (GDrive)',
        format: 'mp4',
        sizeBytes,
        height: res,
        requestHeaders: {}
      });
    }
  });

  return results;
}

// ============================================
// GOVID — govid.co
// Pattern: regex for .mp4 URLs in page
// Source: stremify/embeds/govid.ts
// ============================================
async function extractGovid(url, meta = {}) {
  try {
    const r = await axios.get(url, {
      httpsAgent,
      headers: { 'User-Agent': DEFAULT_UA, Referer: meta.referer || 'https://wecima.show' },
      timeout: 10000, validateStatus: () => true
    });
    if (r.status !== 200) return [];

    const urlRegex = /\b((https?:\/\/(?:www\.)?[^ \n]+\/)([^ \n]+\.mp4))\b/g;
    const streams = [];
    let match;
    while ((match = urlRegex.exec(r.data)) !== null) {
      streams.push({
        url: match[1],
        label: 'Govid',
        format: 'mp4',
        requestHeaders: { Referer: url }
      });
    }
    return streams;
  } catch (e) { return []; }
}

// ============================================
// VISIONCINE — visioncine.cc
// Pattern: initializePlayer('https://...m3u8')
// Source: stremify/embeds/visioncine.ts
// ============================================
async function extractVisioncine(url, meta = {}) {
  try {
    const r = await axios.get(url, {
      httpsAgent,
      headers: { 'User-Agent': DEFAULT_UA, Referer: meta.referer || url },
      timeout: 10000, validateStatus: () => true
    });
    if (r.status !== 200) return [];

    const mediaRegex = /initializePlayer\('([^']*)/;
    const match = r.data.match(mediaRegex);
    if (match?.[1]) {
      return [{
        url: match[1],
        label: 'Visioncine',
        format: 'hls',
        requestHeaders: { Referer: url }
      }];
    }
    return [];
  } catch (e) { return []; }
}

// ============================================
// Simple p.a.c.k.e.d unpacker (lightweight, no external deps)
// Replaces unpacker library used by webstreamr
// ============================================
function simpleUnpack(packed) {
  // Match: eval(function(p,a,c,k,e,d){...}('...',base,count,'word1|word2|...',0,{}))
  const match = packed.match(/'([^']+)'\.split\(''\)\.reverse\(\)\.join\(''\)|'([^']+)'/);
  if (!match) return packed;

  // Extract params: packed string, base, count, words array
  const paramsMatch = packed.match(/\}\('([^']+)',(\d+),(\d+),'([^']+)'/);
  if (!paramsMatch) return packed;

  const p = paramsMatch[1];
  const a = parseInt(paramsMatch[2], 10);
  const c = parseInt(paramsMatch[3], 10);
  const k = paramsMatch[4].split('|');

  // Decode p (it can be encoded with custom base)
  let decoded = p;
  // Simple replacement: each word in k indexed by base-converted char
  for (let i = 0; i < c; i++) {
    if (k[i]) {
      // Replace both \b<i as base-a> and the word
      const idxInBase = i.toString(a).replace(/[^a-z0-9]/gi, '');
      const re1 = new RegExp(`\\b${idxInBase}\\b`, 'g');
      decoded = decoded.replace(re1, k[i]);
    }
  }
  return decoded;
}

// ============================================
// ROUTER — given a URL, dispatch to the right extractor
// ============================================
async function extractAny(url, meta = {}) {
  if (!url || typeof url !== 'string') return [];
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch { return []; }
  const host = parsedUrl.host.toLowerCase();

  // Dispatch
  if (VOE_MIRRORS.some(d => host.includes(d))) return extractVoe(url, meta);
  if (STREAMTAPE_MIRRORS.some(d => host.includes(d))) return extractStreamtape(url, meta);
  if (/uqload/.test(host)) return extractUqload(url, meta);
  if (/dood|do[0-9]go|doood|dooood|ds2play|ds2video|dsvplay|d0o0d|do0od|d0000d|d000d|myvidplay|vidply|all3do|doply|vide0|vvide0|d-s/.test(host)) return extractDoodstream(url, meta);
  if (/mixdrop|mixdrp|mixdroop|m1xdrop/.test(host)) return extractMixdrop(url, meta);
  if (/filemoon/.test(host)) return extractFilemoon(url, meta);
  if (FILELIONS_MIRRORS.some(d => host.includes(d))) return extractFilelions(url, meta);
  if (/supervideo/.test(host)) return extractSupervideo(url, meta);
  if (/dropload|dr0pstream/.test(host)) return extractDropload(url, meta);
  if (/fastream/.test(host)) return extractFastream(url, meta);
  if (/vidsrc|vsrc/.test(host)) return extractVidsrc(url, meta);
  if (/hubcloud|hubdrive/.test(host)) return extractHubcloud(url, meta);
  if (/govid|govid/.test(host)) return extractGovid(url, meta);
  if (/visioncine/.test(host)) return extractVisioncine(url, meta);

  // Unknown host — try generic mp4/m3u8 URL extraction
  return extractGeneric(url, meta);
}

async function extractGeneric(url, meta = {}) {
  try {
    const r = await axios.get(url, {
      httpsAgent,
      headers: { 'User-Agent': DEFAULT_UA, Referer: meta.referer || url },
      timeout: 10000, validateStatus: () => true
    });
    if (r.status !== 200 || typeof r.data !== 'string') return [];

    const urls = new Set();
    const m3u8Matches = r.data.match(/https:\/\/[^"'\s<>]+\.m3u8[^"'\s<>]*/gi) || [];
    const mp4Matches = r.data.match(/https:\/\/[^"'\s<>]+\.mp4[^"'\s<>]*/gi) || [];

    m3u8Matches.forEach(u => urls.add(u));
    mp4Matches.forEach(u => urls.add(u));

    return Array.from(urls).slice(0, 5).map(u => ({
      url: u,
      label: 'Generic',
      format: u.endsWith('.m3u8') ? 'hls' : 'mp4',
      requestHeaders: { Referer: url }
    }));
  } catch (e) { return []; }
}

module.exports = {
  extractVoe, extractStreamtape, extractUqload, extractDoodstream,
  extractMixdrop, extractFilemoon, extractFilelions, extractSupervideo,
  extractDropload, extractFastream, extractVidsrc, extractHubcloud,
  extractGovid, extractVisioncine, extractGeneric, extractAny,
  VOE_MIRRORS, STREAMTAPE_MIRRORS, FILELIONS_MIRRORS,
  parseBytes, getResolution, simpleUnpack
};
