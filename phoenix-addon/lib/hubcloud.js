/**
 * lib/hubcloud.js — HubCloud / PixelServer / FSL direct stream extractor
 *
 * Pattern (from webstreamr): Many DDL sites (4KHDHub, HDHub4u, etc.) link to
 * hubcloud.in / hubcloud.one / gadgetsweb.xyz redirectors which then point to
 * HubCloud locker pages. Those pages expose FSL / FSLv2 / PixelServer direct
 * download URLs that play in Nuvio (with Referer header).
 *
 * Resolves:
 *   gadgetsweb.xyz?id=<base64>  →  hubcloud.in|one/drive/<id>  →  /u/<id>
 *   /u/<id> page contains: var url = 'https://hubcloud.../api/file/...'
 */

const cheerio = require('cheerio');
const { fetchHtml } = require('./fetcher');
const bytes = require('bytes'); // optional — fallback if not installed

function parseBytes(str) {
  if (!str) return null;
  if (typeof bytes === 'function') {
    try { return bytes(str); } catch { /* fall through */ }
  }
  const m = String(str).match(/([\d.]+)\s*(TB|GB|MB|KB)/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const u = m[2].toUpperCase();
  return u === 'TB' ? n * 1024 ** 4 : u === 'GB' ? n * 1024 ** 3 :
         u === 'MB' ? n * 1024 ** 2 : n * 1024;
}

function getResolution(name) {
  if (/2160p|4k|uhd/i.test(name)) return '2160p';
  if (/1080p|fhd/i.test(name)) return '1080p';
  if (/720p|hd/i.test(name)) return '720p';
  if (/480p|sd/i.test(name)) return '480p';
  return 'auto';
}

/**
 * Resolve a gadgetsweb.xyz?id=<base64> URL to its hubcloud.in|one equivalent.
 */
async function resolveGadgetsweb(url) {
  try {
    const html = await fetchHtml(url, { timeout: 10000 });
    // gadgetsweb.xyz returns JS redirect: window.location = "https://hubcloud..."
    const m = html.match(/(?:window\.location|location\.href|var\s+url)\s*=\s*['"]([^'"]+)['"]/);
    if (m) return m[1];
    // Or meta refresh
    const meta = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+url=([^"']+)/i);
    if (meta) return meta[1];
    // Or there's an <a> link to hubcloud
    const $ = cheerio.load(html);
    const a = $('a[href*="hubcloud"]').first().attr('href');
    if (a) return a;
  } catch (e) { /* fall through */ }
  return null;
}

/**
 * Extract direct video URLs from a hubcloud locker page.
 * Returns array of { url, label, sizeBytes, sourceLabel, requestHeaders }
 */
async function extractHubCloud(url, referer = null) {
  const headers = referer ? { Referer: referer } : {};
  let html;
  try {
    html = await fetchHtml(url, { headers, timeout: 12000 });
  } catch (e) {
    return [];
  }

  // Some hubcloud pages do a JS redirect to another URL
  const m = html.match(/var\s+url\s*=\s*['"]([^'"]+)['"]/);
  let redirectUrl = null;
  if (m) {
    redirectUrl = m[1];
    try {
      html = await fetchHtml(redirectUrl, {
        headers: { Referer: url }, timeout: 12000
      });
    } catch (e) { /* use original html */ }
  }

  const $ = cheerio.load(html);
  const title = $('title').text().trim();
  const sizeText = $('#size').text() || $('td:contains("Size")').next().text() || '';
  const sizeBytes = parseBytes(sizeText);
  const res = getResolution(title + ' ' + sizeText);

  const results = [];

  // FSL / FSLv2 / PixelServer / Fastream / DoodStream links
  $('a').each((_, el) => {
    const text = $(el).text().trim();
    const href = $(el).attr('href');
    if (!href || !text) return;

    if (/FSL/i.test(text) && !/FSLv2/i.test(text)) {
      results.push({
        url: href,
        label: `HubCloud (FSL)`,
        sizeBytes,
        sourceLabel: 'hubcloud-fsl',
        requestHeaders: { Referer: redirectUrl || url }
      });
    } else if (/FSLv2/i.test(text)) {
      results.push({
        url: href,
        label: `HubCloud (FSLv2)`,
        sizeBytes,
        sourceLabel: 'hubcloud-fslv2',
        requestHeaders: { Referer: redirectUrl || url }
      });
    } else if (/PixelServer/i.test(text)) {
      // PixelServer: /api/file/<id> → needs ?download
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
        label: `HubCloud (PixelServer)`,
        sizeBytes,
        sourceLabel: 'hubcloud-pixelserver',
        requestHeaders: { Referer: href }
      });
    } else if (/Fastream/i.test(text)) {
      results.push({
        url: href,
        label: `HubCloud (Fastream)`,
        sizeBytes,
        sourceLabel: 'hubcloud-fastream',
        requestHeaders: { Referer: redirectUrl || url }
      });
    } else if (/DoodStream|Dood/i.test(text)) {
      results.push({
        url: href,
        label: `HubCloud (Dood)`,
        sizeBytes,
        sourceLabel: 'hubcloud-dood',
        requestHeaders: {}
      });
    } else if (/G-Drive|GDrive|GDToot/i.test(text)) {
      results.push({
        url: href,
        label: `HubCloud (GDrive)`,
        sizeBytes,
        sourceLabel: 'hubcloud-gdrive',
        requestHeaders: {}
      });
    }
  });

  return { title, res, sizeBytes, results };
}

/**
 * Convert HubCloud results to Stremio streams.
 */
function hubCloudToStreams(extracted) {
  if (!extracted?.results?.length) return [];
  return extracted.results.map(r => ({
    name: `PhoeniX\n${extracted.res || 'auto'}`,
    title: `${extracted.title || 'Unknown'}\n🔗 ${r.label}${extracted.sizeBytes ? ' | 💾 ' + formatSize(extracted.sizeBytes) : ''}`,
    url: r.url,
    behaviorHints: {
      notWebReady: true,
      bingeGroup: `phoenix-${r.sourceLabel}`,
      ...(extracted.sizeBytes && { videoSize: extracted.sizeBytes }),
      ...(Object.keys(r.requestHeaders || {}).length > 0 && {
        proxyHeaders: { request: r.requestHeaders }
      })
    }
  }));
}

function formatSize(b) {
  if (!b) return '';
  if (b >= 1024 ** 4) return (b / 1024 ** 4).toFixed(2) + ' TB';
  if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(2) + ' GB';
  if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(0) + ' MB';
  return b + ' B';
}

module.exports = { extractHubCloud, hubCloudToStreams, resolveGadgetsweb, getResolution };
