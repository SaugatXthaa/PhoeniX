#!/usr/bin/env node
// Task 100 — formatter engine v2 (AIOStreams-compatible grammar) unit suite.
// Covers: modifiers, conditionals, chains, groups (presence semantics),
// 3-branch booleans, quoted literals, tools/sentinels, nesting, escapes,
// case/whitespace tolerance, fail-open, and AUTHENTIC AIOStreams example
// templates (usenet scenarios stripped, per the user ask) against canonical
// value maps.
import { formatStream, renderTemplate, fieldsForStream } from '../src/utils/formatter.cjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};
const eq = (a, b) => a === b;
const V = (fields) => { const map = { stream: fields }; return map; };

console.log('── string modifiers ──');
ok('upper', eq(renderTemplate('{stream.title::upper}', V({ title: 'abc' })), 'ABC'));
ok('lower', eq(renderTemplate('{stream.title::lower}', V({ title: 'AbC' })), 'abc'));
ok('title', eq(renderTemplate('{stream.title::title}', V({ title: 'hello WORLD again' })), 'Hello World Again'));
ok('trim', eq(renderTemplate('{stream.title::trim}', V({ title: '  x  ' })), 'x'));
ok("trim('chars')", eq(renderTemplate("{stream.title::trim(' -')}", V({ title: ' - x- ' })), 'x'));
ok('length', eq(renderTemplate('{stream.title::length}', V({ title: 'abcd' })), '4'));
ok('reverse', eq(renderTemplate('{stream.title::reverse}', V({ title: 'abc' })), 'cba'));
ok('base64', eq(renderTemplate('{stream.title::base64}', V({ title: 'hi' })), Buffer.from('hi').toString('base64')));
ok('smallcaps', eq(renderTemplate('{stream.title::smallcaps}', V({ title: 'Ready' })), 'ʀᴇᴀᴅʏ'));
ok('subscript', eq(renderTemplate('{stream.title::subscript}', V({ title: 'S01' })), 'S₀₁'));
ok('superscript', eq(renderTemplate('{stream.title::superscript}', V({ title: 'S01' })), 'S⁰¹'));
ok('translate', eq(renderTemplate("{stream.title::translate('Bl','Яⅼ')}", V({ title: 'BluRay' })), 'ЯⅼuRay'));
ok('quoted literal operand', eq(renderTemplate("{'n/a'::upper}", {}), 'N/A'));
ok('unknown modifier → fail-open via formatStream', (() => {
  const o = formatStream({ nameTemplate: '{stream.title::noSuchMod}', meta: {}, stream: { name: 'orig', title: 't' }, addonName: 'P' });
  return eq(o.name, 'orig') && /invalid_expression/.test(renderTemplate('{stream.title::noSuchMod}', V({ title: 'x' })));
})());

console.log('── number / byte modifiers ──');
ok('bytes (base-10)', eq(renderTemplate('{stream.size::bytes}', V({ size: 2400000000 })), '2.4 GB'));
ok('bytes2 (base-2)', eq(renderTemplate('{stream.size::bytes2}', V({ size: 2400000000 })), parseFloat((2400000000 / 1024 ** 3).toFixed(2)) + ' GiB'));
ok('sbytes smart', eq(renderTemplate('{stream.size::sbytes}', V({ size: 69700000000 })), formatSmartExpected(69700000000, 1000)));
function formatSmartExpected(bytes, k) {
  const sizes = k === 1024 ? ['B', 'KiB', 'MiB', 'GiB', 'TiB'] : ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const raw = bytes / Math.pow(k, i);
  const ip = Math.floor(raw);
  let fv;
  if (ip >= 100) fv = String(Math.round(raw));
  else if (ip >= 10) fv = raw % 1 === 0 ? raw.toFixed(0) : raw.toFixed(1);
  else fv = String(parseFloat(raw.toFixed(2)));
  return `${fv} ${sizes[i]}`;
}
ok('sbytes2', eq(renderTemplate('{stream.size::sbytes2}', V({ size: 69700000000 })), formatSmartExpected(69700000000, 1024)));
ok('rbytes rounded', eq(renderTemplate('{stream.size::rbytes}', V({ size: 2400000000 })), Math.round(2.4) + ' GB'));
ok('bitrate', eq(renderTemplate('{stream.bitrate::sbitrate}', V({ bitrate: 5200000 })), '5.2 Mbps'));
ok('star', eq(renderTemplate('{stream.seScore::star}', V({ seScore: 80 })), '★★★★'));
ok('pstar', eq(renderTemplate('{stream.seScore::pstar}', V({ seScore: 80 })), '★★★★☆'));
ok('hex/octal/binary', eq(renderTemplate('{stream.seeders::hex} {stream.seeders::octal} {stream.seeders::binary}', V({ seeders: 10 })), 'a 12 1010'));
ok('comma', eq(renderTemplate('{stream.seeders::comma}', V({ seeders: 12345 })), (12345).toLocaleString()));
ok('time default', eq(renderTemplate('{stream.duration::time}', V({ duration: 5025000 })), '1h:23m:45s'));
ok("time('pattern')", eq(renderTemplate("{stream.duration::time('[%-Hh ]%-Mm')}", V({ duration: 5025000 })), '1h 23m'));
ok('time overflow to minutes', eq(renderTemplate("{stream.duration::time('%-M min')}", V({ duration: 5025000 })), '83 min'));

console.log('── date modifier ──');
ok("date('%Y-%m-%d')", eq(renderTemplate("{stream.date::date('%Y-%m-%d')}", V({ date: '2023-07-04' })), '2023-07-04'));
ok("date('%-d %b %Y')", eq(renderTemplate("{stream.date::date('%-d %b %Y')}", V({ date: '2023-07-04' })), '4 Jul 2023'));
ok("date('%B %o, %Y')::upper", eq(renderTemplate("{stream.date::date('%B %o, %Y')::upper}", V({ date: '2023-07-04' })), 'JULY 4TH, 2023'));
ok('bad date passes through', eq(renderTemplate("{stream.date::date('%Y')}", V({ date: 'not-a-date' })), 'not-a-date'));

console.log('── array modifiers ──');
ok('join default', eq(renderTemplate('{stream.visualTags}', V({ visualTags: ['HDR', 'DV'] })), 'HDR,DV'));
ok("join(' | ')", eq(renderTemplate("{stream.visualTags::join(' | ')}", V({ visualTags: ['HDR', 'DV'] })), 'HDR | DV'));
ok('unique', eq(renderTemplate("{stream.visualTags::unique::join('|')}", V({ visualTags: ['HDR', 'hdr', 'DV'] })), 'HDR|DV'));
ok('sort/rsort/lsort', eq(renderTemplate('{stream.visualTags::sort::join(",")} {stream.visualTags::rsort::join(",")}', V({ visualTags: ['b', 'c', 'a'] })), 'a,b,c c,b,a'));
ok('first/last', eq(renderTemplate('{stream.visualTags::first} {stream.visualTags::last}', V({ visualTags: ['HDR', 'DV'] })), 'HDR DV'));
ok('slice', eq(renderTemplate("{stream.visualTags::slice(1)::join(',')}", V({ visualTags: ['a', 'b', 'c'] })), 'b,c'));
ok('keep', eq(renderTemplate("{stream.visualTags::keep('HDR')::join(',')}", V({ visualTags: ['HDR', 'DV'] })), 'HDR'));
ok('remove', eq(renderTemplate("{stream.visualTags::remove('DV')::join(',')}", V({ visualTags: ['HDR', 'DV'] })), 'HDR'));
ok('replace on array', eq(renderTemplate("{stream.visualTags::replace('HDR10+','HDR')::unique::join(' | ')}", V({ visualTags: ['HDR10+', 'DV', 'HDR'] })), 'HDR | DV'));
ok('languageEmoji', eq(renderTemplate('{stream.languages::languageEmoji::join("")}', V({ languages: ['Japanese', 'English'] })), '🇯🇵🇺🇸'));
ok('languageCode', eq(renderTemplate('{stream.languages::languageCode::join(",")}', V({ languages: ['Japanese', 'English'] })), 'JA,EN'));
ok('smallcaps on string (arrays reject smallcaps → error → renderTemplate empty)', eq(renderTemplate('{stream.languageCodes::smallcaps}', V({ languageCodes: ['JA'] })), '') && eq(renderTemplate('{stream.languageCodes::first::smallcaps}', V({ languageCodes: ['JA', 'EN'] })), 'ᴊᴀ'));

console.log('── conditionals ──');
ok('exists true/false', eq(renderTemplate('{stream.quality::exists["Q"||"N"]}', V({ quality: 'BluRay' })), 'Q') && eq(renderTemplate('{stream.quality::exists["Q"||"N"]}', V({ quality: null })), 'N'));
ok('exists on empty string', eq(renderTemplate('{stream.quality::exists["Q"||"N"]}', V({ quality: '' })), 'N'));
ok('istrue/isfalse', eq(renderTemplate('{stream.proxied::istrue["Y"||"N"]}{stream.proxied::isfalse["f"||"t"]}', V({ proxied: true })), 'Yt'));
ok('absent → 3rd branch', eq(renderTemplate('{stream.proxied["Y"||"N"||"U"]}', V({ proxied: null })), 'U'));
ok('absent → nothing without 3rd', eq(renderTemplate('{stream.proxied["Y"||"N"]}', V({ proxied: null })), ''));
ok('boolean direct branch', eq(renderTemplate('{stream.proxied["Y"||"N"]}', V({ proxied: true })), 'Y'));
ok('=X case-insensitive', eq(renderTemplate('{stream.type::=p2p["[P2P] "||""]}', V({ type: 'P2P' })), '[P2P] '));
ok('in()', eq(renderTemplate("{service.id::in('torbox','realdebrid')[\"🟩\"||\"⬜\"]}", { service: { id: 'realdebrid' } }), '🟩'));
ok('in() on array', eq(renderTemplate("{stream.languages::in('english')[\"🇬🇧\"||\"\"]}", V({ languages: ['English'] })), '🇬🇧'));
ok('>0 numeric', eq(renderTemplate('{stream.size::>0["S"||""]}', V({ size: 5 })), 'S') && eq(renderTemplate('{stream.size::>0["S"||""]}', V({ size: 0 })), ''));
ok('>=0', eq(renderTemplate('{stream.seeders::>=0["S"||"N"]}', V({ seeders: 0 })), 'S'));
ok('$ starts-with', eq(renderTemplate('{stream.title::$Dup["D"||"n"]}', V({ title: 'Duplex' })), 'D'));
ok('^ ends-with', eq(renderTemplate('{stream.title::^mkv["M"||"n"]}', V({ title: 'movie.mkv' })), 'M'));
ok('~ contains', eq(renderTemplate('{stream.title::~GB["G"||"n"]}', V({ title: '17.5 GB' })), 'G'));
ok('~= on string compare', eq(renderTemplate('{stream.quality::=bluray["B"||"n"]}', V({ quality: 'BluRay' })), 'B'));

console.log('── condition chains ──');
ok('and', eq(renderTemplate('{stream.subtitles::exists::and::stream.languages::exists[" "||""]}', V({ subtitles: ['en'], languages: ['en'] })), ' '));
ok('and false', eq(renderTemplate('{stream.subtitles::exists::and::stream.languages::exists[" "||""]}', V({ subtitles: null, languages: ['en'] })), ''));
ok('or', eq(renderTemplate('{stream.seadex::or::stream.message::length::>0["X"||""]}', V({ seadex: null, message: 'm' })), 'X'));
ok('xor both true', eq(renderTemplate('{stream.proxied::istrue::xor::stream.private::istrue["X"||""]}', V({ proxied: true, private: true })), ''));
ok('xor one true', eq(renderTemplate('{stream.proxied::istrue::xor::stream.private::istrue["X"||""]}', V({ proxied: true, private: false })), 'X'));
ok('mixed chain (left-to-right)', eq(renderTemplate('{stream.title::exists::and::stream.quality::exists::or::stream.encode::exists["T"||"F"]}', V({ title: 'x', quality: null, encode: 'HEVC' })), 'T'));
ok('long or-chain with ::string (gdrive rse pattern)', eq(renderTemplate('{stream.rseMatched::exists::and::stream.seadex::isfalse::and::stream.rseMatched::string::~T1::or::stream.rseMatched::string::~T2[" (M)"||""]}', V({ rseMatched: ['T2 x'], seadex: false })), ' (M)'));

console.log('── groups (presence semantics) ──');
ok('group dropped when field absent', eq(renderTemplate('{?📅 {stream.age} ?}', V({ age: null })), ''));
ok('group renders when field present', eq(renderTemplate('{?📅 {stream.age} ?}', V({ age: '30d' })), '📅 30d '));
ok("group renders even when text empties ({stream.type::replace('debrid','')})", eq(renderTemplate("{?{stream.type::replace('debrid','')}?}", V({ type: 'debrid' })), ''));
ok('nested group separators', eq(renderTemplate('{?[{stream.resolution}{? · {stream.quality}?}]?}', V({ resolution: '2160p', quality: null })), '[2160p]'));
ok('nested group both present', eq(renderTemplate('{?[{stream.resolution}{? · {stream.quality}?}]?}', V({ resolution: '2160p', quality: 'BluRay' })), '[2160p · BluRay]'));

console.log('── tools / sentinels ──');
ok('tools.newLine', eq(renderTemplate('A{tools.newLine}B', {}), 'A\nB'));
ok('tools.removeLine drops its line', eq(renderTemplate('keep\n{tools.removeLine}\ndrop-me{tools.removeLine}\nend', {}), 'keep\nend'));
ok('data cannot forge sentinels', eq(renderTemplate('{stream.title}', V({ title: 'a\u0012b' })), 'ab'));
ok('join with tools separator', eq(renderTemplate("{stream.visualTags::join('{tools.newLine}- ')}", V({ visualTags: ['HDR', 'DV'] })), 'HDR\n- DV'));

console.log('── parser robustness ──');
ok('case-insensitive field+modifier', eq(renderTemplate('{ Stream.RESOLUTION :: UPPER }', V({ resolution: 'abc' })), 'ABC'));
ok('unknown field → engine marker, formatStream fails open', (() => {
  const raw = renderTemplate('{stream.nope}', V({ resolution: 'x' }));
  const o = formatStream({ nameTemplate: '{stream.nope}', meta: {}, stream: { name: 'orig', title: 't' }, addonName: 'P' });
  return /invalid_expression/.test(raw) && eq(o.name, 'orig');
})());
ok('nested conditional quotes (docs example)', eq(renderTemplate('{stream.resolution::exists["{stream.quality::exists["{stream.resolution} {stream.quality}"||"{stream.resolution}"]}"||"Unknown"]}', V({ resolution: '2160p', quality: null })), '2160p'));
ok('nested both present', eq(renderTemplate('{stream.resolution::exists["{stream.quality::exists["{stream.resolution} {stream.quality}"||"{stream.resolution}"]}"||"Unknown"]}', V({ resolution: '2160p', quality: 'BluRay' })), '2160p BluRay'));
ok('escaped quote in branch', eq(renderTemplate('{stream.title::exists["say \\"hi\\""||""]}', V({ title: 'x' })), 'say "hi"'));
ok('non-boolean check fails open via formatStream', (() => {
  const o = formatStream({ nameTemplate: '{stream.title["A"||"B"]}', meta: { title: 'str not bool' }, stream: { name: 'orig', title: 'origT' }, addonName: 'P' });
  return eq(o.name, 'orig');
})());
{
  const deep = '{stream.a::exists["'.repeat(4) + 'deep' + '"||""]}'.repeat(4);
  ok('depth limit does not hang', eq(typeof renderTemplate(deep, V({ a: 'x' })), 'string'));
}

console.log('── fieldsForStream mapping ──');
{
  const meta = { height: 2160, bytes: 2.4e9, sourceLabel: '4KHDHub', sourceType: 'BluRay Remux', hdr: 'DV,HDR10', codec: 'HEVC', audioCodec: 'TrueHD', audioChannels: '7.1', countryCodes: ['ja', 'en'], format: 'hls', bandwidth: 20000000, title: 'Inception', releaseGroup: 'FRAM' };
  const v = fieldsForStream(meta, { name: 'card-name', title: 'card-title' }, 'PhoeniX', { url: 'https://host/path/movie.mkv', requestType: 'series', requestId: 'tt0903747:2:5' });
  ok('resolution AIOStreams form', eq(v.stream.resolution, '2160p'));
  ok('size numeric bytes', eq(v.stream.size, 2.4e9));
  ok('quality from sourceType', eq(v.stream.quality, 'BluRay Remux'));
  ok('visualTags split', JSON.stringify(v.stream.visualTags) === '["DV","HDR10"]');
  ok('encode', eq(v.stream.encode, 'HEVC'));
  ok('audioTags/channels', eq(v.stream.audioTags[0], 'TrueHD') && eq(v.stream.audioChannels[0], '7.1'));
  ok('languages names', JSON.stringify(v.stream.languages) === '["Japanese","English"]');
  ok('languageCodes uppercase', JSON.stringify(v.stream.languageCodes) === '["JA","EN"]');
  ok('smallLanguageCodes', eq(v.stream.smallLanguageCodes.join('·'), 'ᴊᴀ·ᴇɴ'));
  ok('filename/container/extension', eq(v.stream.filename, 'movie.mkv') && eq(v.stream.container, 'mkv') && eq(v.stream.extension, '.mkv'));
  ok('bitrate', eq(v.stream.bitrate, 20000000));
  ok('metadata season/episode', eq(v.metadata.season, 2) && eq(v.metadata.episode, 5));
  ok('type http + proxied false', eq(v.stream.type, 'http') && v.stream.proxied === false);
  ok('provider/fullTitle/source extensions', eq(v.stream.provider, 'card-name') && eq(v.stream.fullTitle, 'card-title') && eq(v.stream.source, '4KHDHub'));
  ok('service section all-null', eq(v.service.cached, null) && eq(v.service.shortName, null));
  ok('user.resolutions null when unset', eq(v.user.resolutions, null));
  ok('user.resolutions from config', eq(JSON.stringify(fieldsForStream(meta, {}, 'P', { config: { res_2160: 'on', res_1080: 'on' } }).user.resolutions), '["2160p","1080p"]'));
  ok('mp4 container from format', eq(fieldsForStream({ height: 1080, bytes: 1, format: 'mp4' }, {}, 'P').stream.container, 'mp4'));
  ok('proxied detection', eq(fieldsForStream({ height: 1080 }, {}, 'P', { url: 'https://addon.example/proxy?url=https%3A%2F%2Fx' }).stream.proxied, true));
  ok('multi language filtered from names', eq(fieldsForStream({ height: 1080, countryCodes: ['multi', 'hi'] }, {}, 'P').stream.languages.join(','), 'Hindi') && eq(fieldsForStream({ height: 1080, countryCodes: ['multi'] }, {}, 'P').stream.languages, null));
}

console.log('── fail-open contract ──');
{
  const o = formatStream({ nameTemplate: '{stream.resolution::exists["unterminated', meta: {}, stream: { name: 'orig-name', title: 'orig-title' }, addonName: 'P' });
  ok('malformed template falls back to original name', eq(o.name, 'orig-name'));
  const o2 = formatStream({ descriptionTemplate: '', meta: {}, stream: { name: 'n', title: 't' }, addonName: 'P' });
  ok('empty template falls back', eq(o2.description, 't'));
  const o3 = formatStream({ nameTemplate: '', meta: {}, stream: { name: '', title: '' }, addonName: 'P' });
  ok('empty template + empty name → PhoeniX', eq(o3.name, 'PhoeniX'));
}

console.log(`\n═══ UNIT: ${pass} PASS / ${fail} FAIL ═══`);
process.exit(fail ? 1 : 0);
