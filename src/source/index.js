// src/source/index.js
// Ported from research/webstreamr-mbg/src/source/index.ts

import { CineHDPlus } from './CineHDPlus.js';
import { CineWave } from './CineWave.js';
import { AnimeFlix } from './AnimeFlix.js';
import { AnimeWorld } from './AnimeWorld.js';
import { AniDB } from './AniDB.js';
import { AniNeko } from './AniNeko.js';
import { AcerMovies } from './AcerMovies.js';
import { Cuevana } from './Cuevana.js';
import { Einschalten } from './Einschalten.js';
import { Eurostreaming } from './Eurostreaming.js';
import { FilmpalastTO } from './FilmpalastTO.js';
import { Fmovies } from './Fmovies.js';
import { FourKHDHub } from './FourKHDHub.js';
import { Frembed } from './Frembed.js';
import { FrenchCloud } from './FrenchCloud.js';
import { HDHub4u } from './HDHub4u.js';
import { HDHub4uNew } from './HDHub4uNew.js';
import { HomeCine } from './HomeCine.js';
import { KinoGer } from './KinoGer.js';
import { Kokoshka } from './Kokoshka.js';
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
import { VidSpark } from './VidSpark.js';
import { VidSrcSbs } from './VidSrcSbs.js';
import { WatchSeries } from './WatchSeries.js';
import { ZinkMovies } from './ZinkMovies.js';
import { VidKing } from './VidKing.js';
import { VidFast } from './VidFast.js';
import { VidLink } from './VidLink.js';
import { VidSrcTo } from './VidSrcTo.js';
import { VegaMovies } from './VegaMovies.js';
import { Vidzee } from './Vidzee.js';
import { VixSrc } from './VixSrc.js';
// Cinepro-org/core ports (additive — no existing source modified)
import { CineSu } from './CineSu.js';
import { Fshare } from './Fshare.js';
// New sources (additive — no existing source modified)
import { StreamDuck } from './StreamDuck.js';
import { StreamXTV } from './StreamXTV.js';
import { Anikoto } from './Anikoto.js';
import { AniKage } from './AniKage.js';
import { AniBD } from './AniBD.js';
import { TwoDhive } from './TwoDhive.js';
import { AllWish } from './AllWish.js';
import { AniDoor } from './AniDoor.js';
import { NowHDTime } from './NowHDTime.js';
import { FilmeOnlineHD } from './FilmeOnlineHD.js';
import { CineFreak } from './CineFreak.js';
import { VegaCatering } from './VegaCatering.js';
import { AniVault } from './AniVault.js';
import { AniPriv8 } from './AniPriv8.js';
import { ZXCStream } from './ZXCStream.js';
import { HDGharTV } from './HDGharTV.js';
import { Cinejoy } from './Cinejoy.js';
import { Pantyflix } from './Pantyflix.js';
import { AnimeGG } from './AnimeGG.js';
import { Peckle } from './Peckle.js';
import { HiAnime } from './HiAnime.js';
import { AnimeKai } from './AnimeKai.js';
// Nuvio provider sources (additive — each has its own dedicated source file)
import { Cineby } from './Cineby.js';
import { DesiFlix } from './DesiFlix.js';
import { Goated } from './Goated.js';
import { HindMoviez } from './HindMoviez.js';
import { MovieBlast } from './MovieBlast.js';
import { Movies4u } from './Movies4u.js';
import { DahmerMovies } from './DahmerMovies.js';
import { DahmerMovies4k } from './DahmerMovies4k.js';
import { PlayImdb } from './PlayImdb.js';
import { AnimeZeY } from './AnimeZeY.js';
// Nuvio provider sources — Batch 2 (each has its own dedicated source file)
import { UHDMovies } from './UHDMovies.js';
import { VidLove } from './VidLove.js';
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
    new HDHub4u(fetcher),
    new HDHub4uNew(fetcher),
    new VixSrc(fetcher),
    new VidSrc(),
    new VidSpark(fetcher),
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
    new CineSu(fetcher),
    new Fshare(fetcher),
    // anime
    new NineAnime(fetcher),
    new AnimeWorld(fetcher),
    new AnimeFlix(fetcher),
    new AniDB(fetcher),
    new AniNeko(fetcher),
    // AL
    new Kokoshka(fetcher),
    // ES / MX
    new CineHDPlus(fetcher),
    new Cuevana(fetcher),
    new HomeCine(fetcher),
    new VerHdLink(fetcher),
    // DE
    new Einschalten(fetcher),
    new KinoGer(fetcher),
    new MegaKino(fetcher),
    new MeineCloud(fetcher),
    new FilmpalastTO(fetcher),
    // FR
    new Frembed(fetcher),
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
    new AllWish(fetcher),
    // anidoor.me — public sources.json templates + AniList GraphQL (sub/dub)
    new AniDoor(fetcher),
    // nowhdtime.to — movies/series/anime/kdrama via nhdapi.com HLS proxy API
    new NowHDTime(fetcher),
    // filmeonlinehd.digital — Hindi movies/series via linksdrive → HubCloud/GDFlix
    new FilmeOnlineHD(fetcher),
    // cinefreak.net — movies/series/anime/kdrama → generate.php → r2.dev direct MKV
    new CineFreak(fetcher),
    // vegamovies.catering — WP REST API → nexdrive.fit → file hosts
    new VegaCatering(fetcher),
    // anivault.co — anime sub/dub via AniVault API (AnimeHeaven MP4 + Anikoto HLS)
    new AniVault(fetcher),
    // anipriv8.online — anime sub/dub via AniPriv8 pipeline API (5 providers)
    new AniPriv8(fetcher),
    // zxcstream.xyz — movies/series/anime/kdrama via 7 ZXC backend servers (sub/dub)
    new ZXCStream(fetcher),
    // hdghartv.cc — movies/series/anime with multi-audio HLS (Hindi/English/Tamil/Telugu)
    new HDGharTV(fetcher),
    // cinejoy.to — movies/series via shegu.st encrypted API + scrypt PoW (4K/1080p/720p/360p)
    new Cinejoy(fetcher),
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
    // goated.cx — movies/TV HLS (cdn.reallyfast.xyz)
    new Goated(fetcher),
    // hindmoviez — movies/TV MKV (hshare.ink → workers.dev, 4K/1080p)
    new HindMoviez(fetcher),
    // movieblast — movies/TV HLS (mblinkmove.mycdn-mb.xyz, 1080p)
    new MovieBlast(fetcher),
    // movies4u — movies-only MKV (r2.dev + googleusercontent, 4K/1080p)
    new Movies4u(fetcher),
    // dahmermovies — movies/TV (p.111477.xyz bulk proxy, 4K/1080p)
    new DahmerMovies(fetcher),
    // dahmermovies-4k — movies/TV 4K-focused (p.111477.xyz bulk proxy)
    new DahmerMovies4k(fetcher),
    // playimdb — movies/TV HLS (scalableimpactgroup.site, 1080p)
    new PlayImdb(fetcher),
    // animezey — anime-only sub+dub (workers.dev, movies don't work)
    new AnimeZeY(fetcher),
    // ─── Nuvio provider sources — Batch 2 ───
    // uhdmovies — movies-only (googleusercontent, 4K/1080p, Referer: driveseed.org)
    new UHDMovies(fetcher),
    // vidlove — movies/TV HLS (ballerinacappuccino..., 1080p, Referer: player.vidlove.cc)
    new VidLove(fetcher),
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
  ].filter(source => !disabledSources.includes(source.id));
};
