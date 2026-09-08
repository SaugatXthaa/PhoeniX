// src/source/index.js
// Ported from research/webstreamr-mbg/src/source/index.ts

import { CineWave } from './CineWave.js';
import { AnimeFlix } from './AnimeFlix.js';
import { AniDB } from './AniDB.js';
import { AniNeko } from './AniNeko.js';
import { AcerMovies } from './AcerMovies.js';
import { FrameX } from './FrameX.js';
import { FlyStream } from './FlyStream.js';
import { CineJoyAllInOne } from './CineJoyAllInOne.js';
// nikastream.blog — anime sub+dub via Anivexa API (multi-language subtitles)
import { NikaStream } from './NikaStream.js';
// cineby.rocks — movies/TV/anime via VidRock API (8 servers, up to 4K)
import { CinebyRocks } from './CinebyRocks.js';
// stellar.rip — movies/TV/anime via 19-server PoW API (direct HLS, up to 4K)
import { StellarRip } from './StellarRip.js';
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
// New sources (additive — no existing source modified)
import { StreamXTV } from './StreamXTV.js';
import { Anikoto } from './Anikoto.js';
import { AniKage } from './AniKage.js';
import { AniBD } from './AniBD.js';
import { TwoDhive } from './TwoDhive.js';
import { AniDoor } from './AniDoor.js';
import { NowHDTime } from './NowHDTime.js';
import { CineFreak } from './CineFreak.js';
import { Pantyflix } from './Pantyflix.js';
import { AnimeGG } from './AnimeGG.js';
import { Peckle } from './Peckle.js';
import { HiAnime } from './HiAnime.js';
import { AnimeKai } from './AnimeKai.js';
import { AniChan } from './AniChan.js';
import { AnimeSuge } from './AnimeSuge.js';
// BollyFlix — movies/TV download links via bollyflix.free (up to 4K)
import { BollyFlix } from './BollyFlix.js';
// 4KHDHub.one — movies/TV via 4khdhub.one (separate from existing 4KHDHub.link)
import { FourKHDHubOne } from './FourKHDHubOne.js';
// Nuvio provider sources (additive — each has its own dedicated source file)
import { Cineby } from './Cineby.js';
// hindmoviez — movies/TV MKV (hshare.ink → workers.dev, 4K/1080p)
import { HindMoviez } from './HindMoviez.js';
import { MovieBlast } from './MovieBlast.js';
import { PlayImdb } from './PlayImdb.js';
// Re-added sources (from uploaded Nuvio scrapers — each with dedicated source file)
import { ZXCStream } from './ZXCStream.js';
import { AnimeZeY } from './AnimeZeY.js';
import { UHDMovies } from './UHDMovies.js';
// Nuvio provider sources — Batch 2 (each has its own dedicated source file)
import { VidEasy } from './VidEasy.js';
import { AnikotoTV } from './AnikotoTV.js';
import { AnimeWorldIN } from './AnimeWorldIN.js';
import { AnimesDigital } from './AnimesDigital.js';
// itachi.tv — anime-only sub+dub via VidHawk REST API + MegaPlay fallback
//   VidHawk: 3 servers × 2 audio = 6 HLS streams + English VTT subtitles
//   MegaPlay: 2 fallback URLs (sub + dub) — resolved by Megaplay extractor
import { Itachi } from './Itachi.js';
// cinevood.love — movies/TV/anime download links (up to 4K) via mobilejsr.rest
//   Returns external URLs with enriched metadata (quality, codec, size from titles)
import { Cinevood } from './Cinevood.js';
// imdbplay.tech — movies/TV/anime via vidsrc.me backend (up to 4K)
//   Returns external embed URLs with enriched metadata from vidsrc.me API
import { IMDBPlay } from './IMDBPlay.js';
// raflixx.vercel.app — movies/TV/anime via multiple embed providers (8+17 sources)
//   Movies/TV: 8 servers | Anime: 17 servers (sub + dub) via /api/media/sources + /api/anime/sources
import { Raflix } from './Raflix.js';

export { Source } from './Source.js';

export const createSources = (fetcher) => {
  const disabledSources = (process.env.DISABLED_SOURCES || '').split(',').filter(Boolean);

  return [
    // multi
    new FourKHDHub(fetcher),
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
    new AniDB(fetcher),
    new AniNeko(fetcher),
    // AL
    // ES / MX
    new VerHdLink(fetcher),
    // DE
    new MeineCloud(fetcher),
    // IT — Eurostreaming and MostraGuarda removed (DNS dead)
    // Multi-region (acermovies.fun API — GDrive CDN movies)
    new AcerMovies(fetcher),
    // New sources (additive — no existing source modified)
    // streamxtv.tech — TMDB + AniList aggregator with megaplay anime (sub/dub)
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
    // filmeonlinehd.digital — Hindi movies/series via linksdrive → HubCloud/GDFlix
    // cinefreak.net — movies/series/anime/kdrama → generate.php → r2.dev direct MKV
    new CineFreak(fetcher),
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
    // movieblast — movies/TV HLS (mblinkmove.mycdn-mb.xyz, 1080p)
    new MovieBlast(fetcher),
    // playimdb — movies/TV HLS (scalableimpactgroup.site, 1080p)
    new PlayImdb(fetcher),
    // ─── Re-added sources (from uploaded Nuvio scrapers) ───
    // zxcstream — movies/series/anime via player.zxcstream.xyz embed URLs
    new ZXCStream(fetcher),
    // animezey — anime-only sub+dub (workers.dev)
    new AnimeZeY(fetcher),
    // uhdmovies — movies-only (googleusercontent, 4K/1080p)
    new UHDMovies(fetcher),
    // ─── Nuvio provider sources — Batch 2 ───
    // videasy — movies/TV HLS (moon.ironwallnet.net, 10 speedracelight servers, Referer: vidking.net)
    new VidEasy(fetcher),
    // anikototv — anime-only sub+dub (megap.akirax.buzz, Referer: megaplay.buzz)
    new AnikotoTV(fetcher),
    // animeworldindia — anime-only (play.zephyrix.top, 1080p, watchanimeworld.top)
    new AnimeWorldIN(fetcher),
    // animesdigital — anime-only (cdn.imagesskill.com, Portuguese sub/dub)
    new AnimesDigital(fetcher),
    // itachi.tv — anime-only sub+dub via VidHawk REST API + MegaPlay fallback
    new Itachi(fetcher),
    // cinevood.love — movies/TV/anime download links (up to 4K) via mobilejsr.rest
    new Cinevood(fetcher),
    // imdbplay.tech — movies/TV/anime via vidsrc.me backend (up to 4K)
    new IMDBPlay(fetcher),
    // raflixx.vercel.app — movies/TV/anime via multiple embed providers (8+17 sources)
    new Raflix(fetcher),
    // anichan.net — anime sub+dub HLS (AniList ID, /api/watch/m3u8, 1080p)
    new AniChan(fetcher),
    // animesuge.at — anime sub+dub HLS via megaplay.buzz (1080p)
    new AnimeSuge(fetcher),
    // bollyflix.free — movies/TV download links (up to 4K, Hindi-English)
    new BollyFlix(fetcher),
    // 4khdhub.one — movies/TV via HubCloud/HubDrive (up to 4K, separate from 4KHDHub.link)
    new FourKHDHubOne(fetcher),
    // framextv.tech — movies/TV/anime (sub+dub) via FrameX API (up to 4K HLS)
    new FrameX(fetcher),
    // flystream.net — movies/TV/anime (sub+dub) via FlyStream API (up to 4K HLS)
    new FlyStream(fetcher),
    // cinejoy.to — movies/TV/anime via Noise protocol (7 servers, up to 4K)
    new CineJoyAllInOne(fetcher),
    // nikastream.blog — anime sub+dub HLS via Anivexa API (multi-language subtitles)
    new NikaStream(fetcher),
    // cineby.rocks — movies/TV/anime via VidRock API (8 servers, direct m3u8/mp4, up to 4K)
    new CinebyRocks(fetcher),
    // stellar.rip — movies/TV/anime via 19-server PoW API (direct HLS, up to 4K)
    new StellarRip(fetcher),
    // stellar.gdn — movies/TV/anime via PoW + AES-GCM (direct HLS, up to 4K)
    new Stellar(fetcher),
    // HDHub4u v2 — movies/TV via new5.hdhub4u.cl sitemap search (up to 4K)
    new HDHub4uV2(fetcher),
    // MoviesHunt v2 — movies/TV via movieshunt.casa (up to 4K)
    new MoviesHuntV2(fetcher),
    // MoviesDrive v2 — movies/TV via new3.moviesdrive.christmas WP API (up to 4K)
    new MoviesDriveV2(fetcher),
  ].filter(source => !disabledSources.includes(source.id));
};
