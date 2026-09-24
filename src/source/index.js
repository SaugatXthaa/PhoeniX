// src/source/index.js
// Ported from research/webstreamr-mbg/src/source/index.ts

import { CineWave } from './CineWave.js';
import { AnimeFlix } from './AnimeFlix.js';
import { AcerMovies } from './AcerMovies.js';
import { FrameX } from './FrameX.js';
import { CineJoyAllInOne } from './CineJoyAllInOne.js';
// nikastream.blog — anime sub+dub via Anivexa API (multi-language subtitles)
import { NikaStream } from './NikaStream.js';
// cineby.rocks — movies/TV/anime via VidRock API (8 servers, up to 4K)
import { CinebyRocks } from './CinebyRocks.js';
// atlantic.st — movies/TV/anime via Aphrodite (signed CDN) + Artemis (Orbit 4K
//   / Nova anime) with granite+natsuki subtitles (Task 48 reverse engineering)
import { Atlantic } from './Atlantic.js';
// stellar.gdn — movies/TV/anime via PoW + AES-GCM API (direct HLS, up to 4K)
import { Stellar } from './Stellar.js';
// HDHub4u v2 — movies/TV via new5.hdhub4u.cl sitemap search (up to 4K)
import { HDHub4uV2 } from './HDHub4uV2.js';
// MoviesHunt v2 — movies/TV via movieshunt.casa (up to 4K)
import { MoviesHuntV2 } from './MoviesHuntV2.js';
// MoviesDrive v2 — movies/TV via new3.moviesdrive.christmas WP API (up to 4K)
import { MoviesDriveV2 } from './MoviesDriveV2.js';
import { Eurostreaming } from './Eurostreaming.js';
import { FourKHDHub } from './FourKHDHub.js';
import { CineFreak } from './CineFreak.js';
import { MeineCloud } from './MeineCloud.js';
import { MostraGuarda } from './MostraGuarda.js';
import { MovieBox } from './MovieBox.js';
import { Necro } from './Necro.js';
import { Movix } from './Movix.js';
import { Netlio } from './Netlio.js';
import { PrimeShows } from './PrimeShows.js';
import { VerHdLink } from './VerHdLink.js';
import { VidSrcSbs } from './VidSrcSbs.js';
import { WatchSeries } from './WatchSeries.js';
import { VidKing } from './VidKing.js';
import { VidFast } from './VidFast.js';
import { VidLink } from './VidLink.js';
import { VegaMovies } from './VegaMovies.js';
import { VegaMoviesNew } from './VegaMoviesNew.js';
// New sources (additive — no existing source modified)
// streamxtv — streamxtv.sbs direct playable HLS via api.framextv.tech
//   (20 providers, up to 4K, multi-language subtitles) + streamxtv.tech
//   TMDB/AniList aggregator with megaplay anime (sub/dub) as fallback
import { StreamXTV } from './StreamXTV.js';
import { Anikoto } from './Anikoto.js';
import { AniKage } from './AniKage.js';
import { AniBD } from './AniBD.js';
import { TwoDhive } from './TwoDhive.js';
import { AniDoor } from './AniDoor.js';
import { NowHDTime } from './NowHDTime.js';
import { Pantyflix } from './Pantyflix.js';
import { AnimeGG } from './AnimeGG.js';
import { Peckle } from './Peckle.js';
import { HiAnime } from './HiAnime.js';
import { AnimeKai } from './AnimeKai.js';
import { AniChan } from './AniChan.js';
import { AnimeSuge } from './AnimeSuge.js';
import { AniMoTVSlash } from './AniMoTVSlash.js';
// BollyFlix — movies/TV download links via bollyflix.free (up to 4K)
import { BollyFlix } from './BollyFlix.js';
// 4KHDHub.one — movies/TV via 4khdhub.one (separate from existing 4KHDHub.link)
import { FourKHDHubOne } from './FourKHDHubOne.js';
// Nuvio provider sources (additive — each has its own dedicated source file)
import { Cineby } from './Cineby.js';
// hindmoviez — movies/TV MKV (hshare.ink → workers.dev, 4K/1080p)
import { HindMoviez } from './HindMoviez.js';
import { PlayImdb } from './PlayImdb.js';
// Task 66: ported from the original repo (phoenix-hgs3 parity) — app.cloud-mb.xyz
// signed-URL API, 1080p HLS; delivered 4 cards in the orig-vs-mine A/B.
import { MovieBlast } from './MovieBlast.js';
// Re-added sources (from uploaded Nuvio scrapers — each with dedicated source file)
import { ZXCStream } from './ZXCStream.js';
import { AnimeZeY } from './AnimeZeY.js';
import { UHDMovies } from './UHDMovies.js';
// Nuvio provider sources — Batch 2 (each has its own dedicated source file)
import { VidEasy } from './VidEasy.js';
import { AnikotoTV } from './AnikotoTV.js';
import { AnimesDigital } from './AnimesDigital.js';
// itachi.tv — anime-only sub+dub via VidHawk REST API + MegaPlay fallback
//   VidHawk: 3 servers × 2 audio = 6 HLS streams + English VTT subtitles
//   MegaPlay: 2 fallback URLs (sub + dub) — resolved by Megaplay extractor
import { Itachi } from './Itachi.js';
// imdbplay.tech — movies/TV/anime via vidsrc.me backend (up to 4K)
//   Returns external embed URLs with enriched metadata from vidsrc.me API
import { IMDBPlay } from './IMDBPlay.js';
// raflixx.vercel.app — movies/TV/anime via multiple embed providers (8+17 sources)
//   Movies/TV: 8 servers | Anime: 17 servers (sub + dub) via /api/media/sources + /api/anime/sources
import { Raflix } from './Raflix.js';
// hindmovie.fit — movies/TV/anime via GDShine API (direct MKV, up to 4K)
import { HindMovie } from './HindMovie.js';
// rivestream.ru — multi-server direct HLS (11 providers, up to 4K)
import { RiveStream } from './RiveStream.js';
// reanime.to — anime sub+dub via FlixCloud CDN (XOR-encrypted HLS, /reanime-proxy)
import { ReAnime } from './ReAnime.js';
// desiflix — movies/TV/anime via manifest.desitvhub.eu.org Stremio addon
//   Aggregates multiple upstream providers (flixsix.com MP4, vcdnx.com HLS,
//   peakstorm.top 4K). Scraper has built-in retry for cold-start 504s.
import { DesiFlix } from './DesiFlix.js';
// persianstremio — Persian-language movies/TV with dual-audio (🇺🇸|🇮🇷)
//   Direct MP4/MKV from cinamadownload.top, aslmd.sbs, abrtech.top
import { PersianStremio } from './PersianStremio.js';
// videasy.to — movies/TV via Playwright headless browser (speedracelight API)
//   9 providers, direct playable HLS/MP4 up to 4K with subtitles
//   SEPARATE from 'videasy' (which uses player.videasy.net without Playwright)
import { VideasyTo } from './VideasyTo.js';
// kmmovies.pics — movies/TV with direct playable MKV (up to 4K) via R2 + Pixeldrain
import { KMMovies } from './KMMovies.js';
// movielinkbd.net — movies/series/kdrama/animes/cartoons via WP REST API +
//   KiteCloud host resolved to DIRECT googleusercontent MKV (up to 1080p
//   upstream, dual/multi embedded audio, Task 58 reverse engineering)
import { MovieLinkBD } from './MovieLinkBD.js';
// antarctica REMOVED 2026-09 (user request) — comet.feels.legal + TorBox
//   debrid source deleted entirely (see git history, Task 85).
// ─── Orphan sources (complete but never registered — batch add) ───
// All verified as complete with unique source IDs. Some use Nuvio scrapers,
// others use got-scraping or this.fetcher directly.
import { CineHDPlus } from './CineHDPlus.js';
import { Vidzee } from './Vidzee.js';
import { VixSrc } from './VixSrc.js';
import { AllWish } from './AllWish.js';

export { Source } from './Source.js';

export const createSources = (fetcher) => {
  const disabledSources = (process.env.DISABLED_SOURCES || '').split(',').filter(Boolean);

  return [
    // multi
    new FourKHDHub(fetcher),
    // cinefreak.net — movies/series with direct googleusercontent MKV
    // (revived Task 38: search-api.php JSON + cinecloud /w/ direct URL)
    new CineFreak(fetcher),
    new MovieBox(fetcher),
    new CineWave(fetcher),
    new WatchSeries(fetcher),
    new Necro(fetcher),
    new VidSrcSbs(fetcher),
    new VidLink(fetcher),
    new VidKing(fetcher),
    new VidFast(fetcher),
    new VegaMovies(fetcher),
    new PrimeShows(fetcher),
    // Netlio (netlio.vercel.app — HLS streams with Hindi + English audio)
    new Netlio(fetcher),
    // anime
    new AnimeFlix(fetcher),
    // anineko REMOVED 2026-09 (user request): upstream platform dead —
    // nekovault.online DB routes refuse all connections (Task 83/84 evidence).
    // AL
    // ES / MX
    new VerHdLink(fetcher),
    // DE
    new MeineCloud(fetcher),
    // IT — Eurostreaming and MostraGuarda removed (DNS dead)
    // Multi-region (acermovies.fun API — GDrive CDN movies)
    new AcerMovies(fetcher),
    // New sources (additive — no existing source modified)
    // streamxtv — streamxtv.sbs direct streams (api.framextv.tech, 20
    // providers, up to 4K, multi-language subs) + megaplay anime (sub/dub)
    new StreamXTV(fetcher),
    // anikoto.cz — anime-only with sub/dub via megaplay.buzz
    new Anikoto(fetcher),
    // anikage.cc — anime-only with clean JSON API + prox.anicore.tv direct HLS (sub/dub)
    new AniKage(fetcher),
    // anibd.app — anime BD with animeapps.top API → playeng.animeapps.top HLS (SUB-only)
    new AniBD(fetcher),
    // 2dhive.com — MAL-ID-keyed anime archive via megaplay.buzz (sub/dub)
    new TwoDhive(fetcher),
    // all-wish.me — Animesuge clone with Laravel AJAX → megaplay.buzz (sub/dub)
    // anidoor.me — public sources.json templates + AniList GraphQL (sub/dub)
    new AniDoor(fetcher),
    // nowhdtime.to — movies/series/anime/kdrama via nhdapi.com HLS proxy API
    new NowHDTime(fetcher),
    // pantyflix.org — movies/series/anime via /api/streamrip/download (direct MP4/MKV)
    new Pantyflix(fetcher),
    // animegg.org — anime sub+dub direct MP4 (720p/1080p)
    new AnimeGG(fetcher),
    // 2peckle / ShowBox — movies/series via FebBox (requires FEBBOX_COOKIE)
    new Peckle(fetcher),
    // hianime.at — anime sub+dub HLS (pure JS, no Playwright)
    new HiAnime(fetcher),
    // animekai.at — anime sub+dub HLS via zokoanime.video (pure JS, uses curl)
    new AnimeKai(fetcher),
    // ─── Nuvio provider sources (each has its own dedicated source file) ───
    // All purely additive — no existing source modified. Each loads a CommonJS
    // provider module from src/nuvio/*.cjs and returns URL results with proper
    // meta for enriched metadata (quality, codec, sourceType, audioCodec, etc.)
    // Routing: HLS+Referer → /proxy, MP4+Referer → requestHeaders, direct → direct
    // cineby.at — movies/TV HLS (4K, speedracelight API + XOR encryption)
    new Cineby(fetcher),
    // hindmoviez — movies/TV MKV (hshare.ink → workers.dev, 4K/1080p)
    new HindMoviez(fetcher),
    // playimdb — movies/TV HLS (scalableimpactgroup.site, 1080p)
    new PlayImdb(fetcher),
    // movieblast — movies/TV HLS (app.cloud-mb.xyz, 1080p) — Task 66 orig parity
    new MovieBlast(fetcher),
    // ─── Re-added sources (from uploaded Nuvio scrapers) ───
    // zxcstream — movies/series/anime via player.zxcstream.xyz embed URLs
    new ZXCStream(fetcher),
    // animezey — anime-only sub+dub (workers.dev)
    new AnimeZeY(fetcher),
    // uhdmovies — movies-only (googleusercontent, 4K/1080p)
    new UHDMovies(fetcher),
    // ─── Nuvio provider sources — Batch 2 ───
    // videasy — movies/TV HLS (moon.ironwallnet.net, 10 speedracelight servers, Referer: vidking.net, up to 4K)
    new VidEasy(fetcher),
    // anikototv — anime-only sub+dub (megap.akirax.buzz, Referer: megaplay.buzz)
    new AnikotoTV(fetcher),
    // animeworldindia REMOVED 2026-09 (user request): infrastructure closed to
    // every reachable egress (sandbox 522 / Render 403 / zephyrix dead / no mirror).
    // animesdigital — anime-only (cdn.imagesskill.com, Portuguese sub/dub)
    new AnimesDigital(fetcher),
    // itachi.tv — anime-only sub+dub via VidHawk REST API + MegaPlay fallback
    new Itachi(fetcher),
    // imdbplay.tech — movies/TV/anime via vidsrc.me backend (up to 4K)
    new IMDBPlay(fetcher),
    // raflixx.vercel.app — movies/TV/anime via multiple embed providers (8+17 sources)
    new Raflix(fetcher),
    // hindmovie.fit — movies/TV/anime via GDShine API (direct MKV, up to 4K)
    new HindMovie(fetcher),
    // rivestream.ru — multi-server direct HLS (11 providers, up to 4K)
    new RiveStream(fetcher),
    // reanime.to — anime sub+dub via FlixCloud CDN (XOR-encrypted HLS, /reanime-proxy)
    new ReAnime(fetcher),
    // desiflix — movies/TV/anime via manifest.desitvhub.eu.org (multi-provider aggregation)
    new DesiFlix(fetcher),
    // persianstremio — Persian dual-audio movies/TV (cinamadownload.top, aslmd.sbs)
    new PersianStremio(fetcher),
    // anichan.net — anime sub+dub HLS (AniList ID, /api/watch/m3u8, 1080p)
    new AniChan(fetcher),
    // animesuge.at — anime sub+dub HLS via megaplay.buzz (1080p)
    new AnimeSuge(fetcher),
    new AniMoTVSlash(fetcher),
    // bollyflix.free — movies/TV download links (up to 4K, Hindi-English)
    new BollyFlix(fetcher),
    // 4khdhub.one — movies/TV via HubCloud/HubDrive (up to 4K, separate from 4KHDHub.link)
    new FourKHDHubOne(fetcher),
    // framextv.tech — movies/TV/anime (sub+dub) via FrameX API (up to 4K HLS)
    new FrameX(fetcher),
    // cinejoy.pk (was cinejoy.to) — movies/TV/anime via Noise protocol, up to 4K
    new CineJoyAllInOne(fetcher),
    // nikastream.blog — anime sub+dub HLS via Anivexa API (multi-language subtitles)
    new NikaStream(fetcher),
    // cineby.rocks — movies/TV/anime via VidRock API (8 servers, direct m3u8/mp4, up to 4K)
    new CinebyRocks(fetcher),
    // stellarrip REMOVED 2026-09 (user request): stellar.rip gates the
    // stream-encrypted step by egress-IP class incl. every prod-reachable exit
    // (Task 82/83 A/B evidence: relay PoW-session-bound to issuing IP).
    // stellar.gdn — movies/TV/anime via PoW + AES-GCM (direct HLS, up to 4K)
    new Stellar(fetcher),
    // HDHub4u v2 — movies/TV via new5.hdhub4u.cl sitemap search (up to 4K)
    new HDHub4uV2(fetcher),
    // MoviesHunt v2 — movies/TV via movieshunt.casa (up to 4K)
    new MoviesHuntV2(fetcher),
    // MoviesDrive v2 — movies/TV via new3.moviesdrive.christmas WP API (up to 4K)
    new MoviesDriveV2(fetcher),
    // VegaMovies Direct — movies/TV/anime via new2.vegamovies.futbol nexdrive→fastdl (up to 4K)
    new VegaMoviesNew(fetcher),
    // ─── Orphan sources (registered in batch — all additive) ───
    // cinehdplus — ES/MX series via cinehdplus.com
    new CineHDPlus(fetcher),
    // dahmermovies + dahmermovies4k REMOVED (Task 50, user request)
    // vidzee — 8 servers, multi-language embeds
    new Vidzee(fetcher),
    // vixsrc — VixSrc embed (requires MediaFlowProxy)
    new VixSrc(fetcher),
    // allwish — anime via all-wish.me (AnimeSuge-like, megaplay.buzz backend)
    new AllWish(fetcher),
    // videasy.to — movies/TV via speedracelight API (9 providers, up to 4K, subtitles)
    new VideasyTo(fetcher),
    // kmmovies.pics — movies/TV with direct playable MKV (up to 4K) via R2 + Pixeldrain
    new KMMovies(fetcher),
    // atlantic.st — movies/TV/anime via Aphrodite (4K, signed) + Artemis
    // (Orbit 4K multi-audio / Nova muxed), granite+natsuki subtitles, all
    // cards live-validated before shipping (Task 48)
    new Atlantic(fetcher),
    // movielinkbd.net — movies/series/kdrama/animes/cartoons, direct
    // googleusercontent MKV via KiteCloud (dual/multi embedded audio,
    // embedded ESub, up to 1080p upstream — Task 58)
    new MovieLinkBD(fetcher),
    // antarctica REMOVED 2026-09 (user request) — source + provider deleted.
  ].filter(source => !disabledSources.includes(source.id));
};
