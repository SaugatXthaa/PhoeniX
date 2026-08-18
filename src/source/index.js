// src/source/index.js
// Ported from research/webstreamr-mbg/src/source/index.ts

import { CineWave } from './CineWave.js';
import { AnimeFlix } from './AnimeFlix.js';
import { AnimeWorld } from './AnimeWorld.js';
import { AniDB } from './AniDB.js';
import { AniNeko } from './AniNeko.js';
import { AcerMovies } from './AcerMovies.js';
import { Cuevana } from './Cuevana.js';
import { Einschalten } from './Einschalten.js';
import { Eurostreaming } from './Eurostreaming.js';
import { Fmovies } from './Fmovies.js';
import { FourKHDHub } from './FourKHDHub.js';
import { FrenchCloud } from './FrenchCloud.js';
import { MegaKino } from './MegaKino.js';
import { MeineCloud } from './MeineCloud.js';
import { MostraGuarda } from './MostraGuarda.js';
import { MoviesDrive } from './MoviesDrive.js';
import { MoviesHunt } from './MoviesHunt.js';
import { MovieBox } from './MovieBox.js';
import { Movie4kTo } from './Movie4kTo.js';
import { Necro } from './Necro.js';
import { Movix } from './Movix.js';
import { Netlio } from './Netlio.js';
import { NineAnime } from './NineAnime.js';
import { PrimeShows } from './PrimeShows.js';
import { VerHdLink } from './VerHdLink.js';
import { VidSrc } from './VidSrc.js';
import { VidSrcSbs } from './VidSrcSbs.js';
import { WatchSeries } from './WatchSeries.js';
import { ZinkMovies } from './ZinkMovies.js';
import { VidKing } from './VidKing.js';
import { VidFast } from './VidFast.js';
import { VidLink } from './VidLink.js';
import { VidSrcTo } from './VidSrcTo.js';
import { VegaMovies } from './VegaMovies.js';
import { Vidzee } from './Vidzee.js';
// Cinepro-org/core ports (additive — no existing source modified)
import { Fshare } from './Fshare.js';
// New sources (additive — no existing source modified)
import { StreamDuck } from './StreamDuck.js';
import { StreamXTV } from './StreamXTV.js';
import { Anikoto } from './Anikoto.js';
import { AniKage } from './AniKage.js';
import { AniBD } from './AniBD.js';
import { TwoDhive } from './TwoDhive.js';
import { AniDoor } from './AniDoor.js';
import { NowHDTime } from './NowHDTime.js';
import { CineFreak } from './CineFreak.js';
import { AniVault } from './AniVault.js';
import { AniPriv8 } from './AniPriv8.js';
import { HDGharTV } from './HDGharTV.js';
import { Pantyflix } from './Pantyflix.js';
import { AnimeGG } from './AnimeGG.js';
import { Peckle } from './Peckle.js';
import { HiAnime } from './HiAnime.js';
import { AnimeKai } from './AnimeKai.js';
import { AniChan } from './AniChan.js';
import { AnimeSuge } from './AnimeSuge.js';
// 1Embed — movies/TV HLS via 1embed.cc API (up to 4K)
import { OneEmbed } from './OneEmbed.js';
// BollyFlix — movies/TV download links via bollyflix.free (up to 4K)
import { BollyFlix } from './BollyFlix.js';
// 1Shows — movies/TV direct download via PixelDrain
import { OneShows } from './OneShows.js';
// 1DesireMovies — movies/TV download links via 1desiremovies.wales
import { OneDesireMovies } from './OneDesireMovies.js';
// 4KHDHub.one — movies/TV via 4khdhub.one (separate from existing 4KHDHub.link)
import { FourKHDHubOne } from './FourKHDHubOne.js';
// Nuvio provider sources (additive — each has its own dedicated source file)
import { Cineby } from './Cineby.js';
import { DesiFlix } from './DesiFlix.js';
import { MovieBlast } from './MovieBlast.js';
import { Movies4u } from './Movies4u.js';
import { PlayImdb } from './PlayImdb.js';
// Re-added sources (from uploaded Nuvio scrapers — each with dedicated source file)
import { ZXCStream } from './ZXCStream.js';
import { Cinejoy } from './Cinejoy.js';
import { AnimeZeY } from './AnimeZeY.js';
import { UHDMovies } from './UHDMovies.js';
import { HDHub4u } from './HDHub4u.js';
// Nuvio provider sources — Batch 2 (each has its own dedicated source file)
import { VidEasy } from './VidEasy.js';
import { AnikotoTV } from './AnikotoTV.js';
import { VixSrc2 } from './VixSrc2.js';
import { AnimeSalt } from './AnimeSalt.js';
import { AnimeWorldIN } from './AnimeWorldIN.js';
import { AnimesDigital } from './AnimesDigital.js';

export { Source } from './Source.js';

export const createSources = (fetcher) => {
  const disabledSources = (process.env.DISABLED_SOURCES || '').split(',').filter(Boolean);

  return [
    // multi
    new FourKHDHub(fetcher),
    new VidSrc(),
    new Vidzee(fetcher),
    new MovieBox(fetcher),
    new Movie4kTo(fetcher),
    new Fmovies(fetcher),
    new CineWave(fetcher),
    new MoviesDrive(fetcher),
    new MoviesHunt(fetcher),
    new ZinkMovies(fetcher),
    new WatchSeries(fetcher),
    new Necro(fetcher),
    new VidSrcSbs(fetcher),
    new VidLink(fetcher),
    new VidSrcTo(fetcher),
    new VidKing(fetcher),
    new VidFast(fetcher),
    new VegaMovies(fetcher),
    new PrimeShows(fetcher),
    // Netlio (netlio.vercel.app — HLS streams with Hindi + English audio)
    new Netlio(fetcher),
    // cinepro-org/core ports (additive)
    new Fshare(fetcher),
    // anime
    new NineAnime(fetcher),
    new AnimeWorld(fetcher),
    new AnimeFlix(fetcher),
    new AniDB(fetcher),
    new AniNeko(fetcher),
    // AL
    // ES / MX
    new Cuevana(fetcher),
    new VerHdLink(fetcher),
    // DE
    new Einschalten(fetcher),
    new MegaKino(fetcher),
    new MeineCloud(fetcher),
    // FR
    new FrenchCloud(fetcher),
    new Movix(fetcher),
    // IT — Eurostreaming and MostraGuarda removed (DNS dead)
    // Multi-region (acermovies.fun API — GDrive CDN movies)
    new AcerMovies(fetcher),
    // New sources (additive — no existing source modified)
    // streamduck.site — TMDB-based aggregator (vidsrc.me + vidsrc.to)
    new StreamDuck(fetcher),
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
    // anivault.co — anime sub/dub via AniVault API (AnimeHeaven MP4 + Anikoto HLS)
    new AniVault(fetcher),
    // anipriv8.online — anime sub/dub via AniPriv8 pipeline API (5 providers)
    new AniPriv8(fetcher),
    // hdghartv.cc — movies/series/anime with multi-audio HLS (Hindi/English/Tamil/Telugu)
    new HDGharTV(fetcher),
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
    // desiflix — movies/TV/anime HLS (multi-audio, manifest.desitvhub.eu.org)
    new DesiFlix(fetcher),
    // hindmoviez — movies/TV MKV (hshare.ink → workers.dev, 4K/1080p)
    // movieblast — movies/TV HLS (mblinkmove.mycdn-mb.xyz, 1080p)
    new MovieBlast(fetcher),
    // movies4u — movies-only MKV (r2.dev + googleusercontent, 4K/1080p)
    new Movies4u(fetcher),
    // playimdb — movies/TV HLS (scalableimpactgroup.site, 1080p)
    new PlayImdb(fetcher),
    // ─── Re-added sources (from uploaded Nuvio scrapers) ───
    // zxcstream — movies/series/anime via player.zxcstream.xyz embed URLs
    new ZXCStream(fetcher),
    // cinejoy — movies/series via HdHub addon resolve endpoint (HLS m3u8)
    new Cinejoy(fetcher),
    // animezey — anime-only sub+dub (workers.dev)
    new AnimeZeY(fetcher),
    // uhdmovies — movies-only (googleusercontent, 4K/1080p)
    new UHDMovies(fetcher),
    // hdhub4u — movies/series via hubcdn/hubcloud/pixeldrain download links
    new HDHub4u(fetcher),
    // ─── Nuvio provider sources — Batch 2 ───
    // videasy — movies/TV HLS (moon.ironwallnet.net, 10 speedracelight servers, Referer: vidking.net)
    new VidEasy(fetcher),
    // anikototv — anime-only sub+dub (megap.akirax.buzz, Referer: megaplay.buzz)
    new AnikotoTV(fetcher),
    // vixsrc2 — movies/TV HLS (komiknostalgia.id, direct provider — no MediaFlowProxy needed)
    new VixSrc2(fetcher),
    // animesalt — anime-only (as-cdn21.top, 720p, Referer: as-cdn21.top)
    new AnimeSalt(fetcher),
    // animeworldindia — anime-only (play.zephyrix.top, 1080p, watchanimeworld.top)
    new AnimeWorldIN(fetcher),
    // animesdigital — anime-only (cdn.imagesskill.com, Portuguese sub/dub)
    new AnimesDigital(fetcher),
    // anichan.net — anime sub+dub HLS (AniList ID, /api/watch/m3u8, 1080p)
    new AniChan(fetcher),
    // animesuge.at — anime sub+dub HLS via megaplay.buzz (1080p)
    new AnimeSuge(fetcher),
    // 1embed.cc — movies/TV HLS via 1embed.cc API (up to 4K)
    new OneEmbed(fetcher),
    // bollyflix.free — movies/TV download links (up to 4K, Hindi-English)
    new BollyFlix(fetcher),
    // 1shows.cc — movies/TV direct download via PixelDrain
    new OneShows(fetcher),
    // 1desiremovies.wales — movies/TV download links (1080p/720p/480p)
    new OneDesireMovies(fetcher),
    // 4khdhub.one — movies/TV via HubCloud/HubDrive (up to 4K, separate from 4KHDHub.link)
    new FourKHDHubOne(fetcher),
  ].filter(source => !disabledSources.includes(source.id));
};
