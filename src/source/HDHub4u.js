// src/source/HDHub4u.js
// Ported from research/webstreamr-mbg/src/source/HDHub4u.ts

import * as cheerio from 'cheerio';
import { CountryCode } from '../types.js';
import { DEAD_HUBCLOUD_HOSTS, findCountryCodes, getImdbId, HUB_HOST_PATTERN } from '../utils/index.js';
import { resolveRedirectUrl } from './hd-hub-helper.js';
import { Source } from './Source.js';

const CDN_HOST_URL = 'https://cdn.hdhub4u.glass/host/';
const CDN_HOST_TTL = 4 * 60 * 60 * 1000;

let cdnDiscoveredUrl = null;
let cdnDiscoveryTs = 0;
let cdnVerifiedAliveAt = 0;
export const CDN_VERIFY_INTERVAL = 5 * 60 * 1000;

export function resetCdnCache() {
  let evictedHost;
  if (cdnDiscoveredUrl) {
    try {
      evictedHost = new URL(cdnDiscoveredUrl).hostname;
    } catch { /* invalid CDN URL */ }
  }
  cdnDiscoveredUrl = null;
  cdnDiscoveryTs = 0;
  cdnVerifiedAliveAt = 0;
  return evictedHost;
}

Source.evictionCallbacks.set('hdhub', resetCdnCache);

const EXCLUDED_HREF_PATTERNS = ['gadgetsweb', '4khdhub', 'linksly', 'shareus', 'dood', 'desiupload', 'megaup', 'filepress', 'mediashore', 'ninjastream', 'hubstream'];

/** Canonical identity key — strips ephemeral query params for HubCloud (keeps from_ac), keeps full href otherwise. */
const getCanonicalKey = (url) => {
  if (/hubcloud/.test(url.hostname)) {
    const u = new URL(url);
    const fromAc = u.searchParams.get('from_ac');
    u.search = '';
    if (fromAc) u.searchParams.set('from_ac', fromAc);
    return u.href;
  }
  return url.href;
};

/** Deduplicate SourceResults by canonical URL. */
const deduplicateSourceResults = (results) => {
  const seen = new Set();
  return results.filter((r) => {
    const key = getCanonicalKey(r.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export class HDHub4u extends Source {
  constructor(fetcher) {
    super();
    this.id = 'hdhub4u';
    this.label = 'HDHub4u';
    this.contentTypes = ['movie', 'series'];
    this.countryCodes = [CountryCode.multi, CountryCode.gu, CountryCode.hi, CountryCode.ml, CountryCode.pa, CountryCode.ta, CountryCode.te];
    this.baseUrl = 'https://new1.hdhub4u.limo';
    this.domainKey = 'hdhub';
    this.fetcher = fetcher;
    this.FALLBACK_CANDIDATES = [
      'https://new1.hdhub4u.limo',
      'https://new1.hdhub4u.fo',
      'https://new2.hdhub4u.fo',
      'https://new3.hdhub4u.fo',
      'https://new4.hdhub4u.fo',
      'https://new5.hdhub4u.fo',
      'https://new6.hdhub4u.fo',
      'https://new7.hdhub4u.fo',
      'https://new8.hdhub4u.fo',
      'https://new9.hdhub4u.fo',
      'https://new10.hdhub4u.fo',
    ];
    this.searchUrl = 'https://search.hdhub4u.glass';
  }

  async handleInternal(ctx, _type, id) {
    const imdbId = await getImdbId(this.fetcher, ctx, id);

    const pageUrls = await this.fetchPageUrls(ctx, imdbId);

    return deduplicateSourceResults(
      (await Promise.all(
        pageUrls.map(async (pageUrl) => {
          return await this.handlePage(ctx, pageUrl, imdbId);
        }),
      )).flat(),
    );
  }

  async handlePage(ctx, pageUrl, imdbId) {
    const html = await this.fetcher.text(ctx, pageUrl);

    const $ = cheerio.load(html);

    const meta = {
      countryCodes: [CountryCode.multi, ...findCountryCodes($('div:contains("Language"):not(:has(div)):first').text())],
    };

    if (!imdbId.episode) {
      return [
        ...this.extractHubDriveUrlResults(html, meta),
        ...(await Promise.all(
          $('a[href*="gadgetsweb"]').map((_i, el) => this.handleHubLinks(ctx, new URL($(el).attr('href')), pageUrl, meta)),
        )).flat(),
      ];
    }

    const ep = imdbId.episode;
    const epPadded = String(ep).padStart(2, '0');
    const episodeSelector = [
      `h3:contains("EP-${epPadded}")`,
      `h3:contains("EPiSODE ${ep}")`,
      `h3:contains("EPiSODE ${epPadded}")`,
      `h3:contains("Episode ${ep}")`,
      `h3:contains("Episode ${epPadded}")`,
      `h4:contains("EP-${epPadded}")`,
      `h4:contains("EPiSODE ${ep}")`,
      `h4:contains("E${epPadded} ")`,
      `h4:contains("E${ep} ")`,
      `h4:contains("EPiSODE ${epPadded}")`,
      `h4:contains("Episode ${ep}")`,
      `h4:contains("Episode ${epPadded}")`,
      `h2:contains("EPiSODE ${ep}")`,
      `h2:contains("EPiSODE ${epPadded}")`,
      `h2:contains("Episode ${ep}")`,
      `h2:contains("Episode ${epPadded}")`,
    ].join(', ');

    const heading = $(episodeSelector).first();
    const headingAndAfterHtml = $.html(heading)
      + heading.nextUntil('hr').map((_i, el) => $.html(el)).get().join('');

    // Episode-scoped gadgetsweb links
    const episodeSection$ = cheerio.load(headingAndAfterHtml);
    const episodeGadgetHrefs = episodeSection$('a[href*="gadgetsweb"]')
      .map((_i, el) => episodeSection$(el).attr('href'))
      .toArray()
      .filter((h) => !!h);

    // Pack-level gadgetsweb links: inside headings that don't mention any episode
    const packGadgetHrefs = $('h2:has(a[href*="gadgetsweb"]), h3:has(a[href*="gadgetsweb"]), h4:has(a[href*="gadgetsweb"]), h5:has(a[href*="gadgetsweb"])')
      .filter((_i, el) => !/EPiSODE\s+\d|EP-\d+|E\d{2}\s|Episode\s+\d/i.test($(el).text()))
      .find('a[href*="gadgetsweb"]')
      .map((_i, el) => $(el).attr('href'))
      .toArray()
      .filter((h) => !!h);

    const allGadgetHrefs = [...new Set([...episodeGadgetHrefs, ...packGadgetHrefs])];

    return [
      ...this.extractHubDriveUrlResults(headingAndAfterHtml, meta),
      ...(await Promise.all(
        allGadgetHrefs.map(href => this.handleHubLinks(ctx, new URL(href), pageUrl, meta)),
      )).flat(),
    ];
  }

  async handleHubLinks(ctx, redirectUrl, refererUrl, meta) {
    let resolvedUrl;
    try {
      resolvedUrl = await resolveRedirectUrl(ctx, this.fetcher, redirectUrl);
    } catch {
      return [];
    }

    if (!resolvedUrl) {
      return [];
    }

    if (HUB_HOST_PATTERN.test(resolvedUrl.hostname)) {
      if (!DEAD_HUBCLOUD_HOSTS.has(resolvedUrl.hostname)) {
        return [{ url: resolvedUrl, meta: { ...meta, referer: refererUrl.href } }];
      }
      return [];
    }

    const hubLinksHtml = await this.fetcher.text(ctx, resolvedUrl, { headers: { Referer: refererUrl.href } });

    return [
      ...this.extractHubDriveUrlResults(hubLinksHtml, { ...meta, referer: resolvedUrl.href }),
    ];
  }

  extractHubDriveUrlResults(html, meta) {
    const $ = cheerio.load(html);
    const allLinks = $('a').filter((_i, el) => {
      const href = ($(el).attr('href') ?? '').toLowerCase();
      if (!href) return false;
      if (EXCLUDED_HREF_PATTERNS.some(p => href.includes(p))) return false;
      return HUB_HOST_PATTERN.test(href);
    });
    const filteredLinks = allLinks.not(':contains("⚡")');

    return filteredLinks
      .map((_i, el) => {
        try {
          const url = new URL($(el).attr('href'));
          if (DEAD_HUBCLOUD_HOSTS.has(url.hostname)) return null;
          return { url, meta };
        } catch {
          return null;
        }
      })
      .toArray()
      .filter((r) => r !== null);
  }

  async fetchPageUrls(ctx, imdbId) {
    const baseUrl = await this.getBaseUrl(ctx);

    const results = await this.fetchPageUrlsFromSearch(ctx, imdbId, baseUrl);
    if (results.length > 0) {
      return results;
    }

    return this.fetchPageUrlsFromSiteSearch(ctx, imdbId, baseUrl);
  }

  async fetchPageUrlsFromSearch(ctx, imdbId, baseUrl) {
    try {
      const searchUrl = new URL(`/collections/post/documents/search?query_by=imdb_id&q=${encodeURIComponent(imdbId.id)}`, this.searchUrl);
      const searchResponse = await this.fetcher.json(ctx, searchUrl, { headers: { Referer: baseUrl.href } });

      return searchResponse.hits
        .filter(hit =>
          hit.document.imdb_id === imdbId.id
          && (
            !imdbId.season
            || hit.document.post_title.includes(`Season ${imdbId.season}`)
            || hit.document.post_title.includes(`S${String(imdbId.season)}`)
            || hit.document.post_title.includes(`S${String(imdbId.season).padStart(2, '0')}`)
          ),
        )
        .map(hit => new URL(hit.document.permalink, baseUrl));
    } catch {
      return [];
    }
  }

  async fetchPageUrlsFromSiteSearch(ctx, imdbId, baseUrl) {
    try {
      const siteSearchUrl = new URL(`/?s=${encodeURIComponent(imdbId.id)}`, baseUrl);
      const html = await this.fetcher.text(ctx, siteSearchUrl);
      const $ = cheerio.load(html);

      return $('a')
        .filter((_i, el) => {
          const href = $(el).attr('href') ?? '';
          const text = $(el).text();
          return href.startsWith(baseUrl.origin)
            && (text.includes(imdbId.id) || href.includes(imdbId.id));
        })
        .map((_i, el) => new URL($(el).attr('href')))
        .toArray();
    } catch {
      return [];
    }
  }

  async discoverFromCdn(ctx) {
    if (cdnDiscoveredUrl && Date.now() - cdnDiscoveryTs < CDN_HOST_TTL) {
      return cdnDiscoveredUrl;
    }

    try {
      const d = new Date();
      const seed = (d.getFullYear() * 1000000) + ((d.getMonth() + 1) * 10000) + (d.getDate() * 100) + d.getHours() + 1;
      const url = new URL(`?v=${seed}`, CDN_HOST_URL);
      const response = await this.fetcher.json(ctx, url);

      if (response.c) {
        const decoded = atob(response.c.replace(/\/$/, ''));
        const baseUrl = decoded.replace(/[?&]utm=[^&]*/, '').replace(/\/$/, '');
        cdnDiscoveredUrl = baseUrl;
        cdnDiscoveryTs = Date.now();
        return baseUrl;
      }
    } catch { /* CDN endpoint unreachable */ }

    return null;
  }

  async getBaseUrl(ctx) {
    const cdnUrl = await this.discoverFromCdn(ctx);
    if (cdnUrl) {
      const hostname = (() => {
        try {
          return new URL(cdnUrl).hostname;
        } catch {
          return '';
        }
      })();
      const diedAt = hostname ? Source.deadDomains.get(hostname) : undefined;
      const isKnownDead = diedAt && Date.now() - diedAt < Source.DEAD_DOMAIN_TTL;

      if (!isKnownDead) {
        const needsVerify = Date.now() - cdnVerifiedAliveAt >= CDN_VERIFY_INTERVAL;
        if (Source.isFailing(this.domainKey) || needsVerify) {
          if (await this.isDomainAlive(ctx, this.fetcher, cdnUrl)) {
            Source.recordSuccess(this.domainKey);
            cdnVerifiedAliveAt = Date.now();
          } else {
            if (hostname) Source.deadDomains.set(hostname, Date.now());
            resetCdnCache();
            return this.probeBaseUrl(ctx, this.fetcher, this.domainKey, this.FALLBACK_CANDIDATES);
          }
        }
        try {
          return new URL(cdnUrl);
        } catch {
          // invalid CDN URL, fall through to probeBaseUrl
        }
      }
    }

    return this.probeBaseUrl(ctx, this.fetcher, this.domainKey, this.FALLBACK_CANDIDATES);
  }
}
