// Debug SubtitleFetcher step by step
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const logger = { info: (...a) => console.log('[INFO]', ...a), warn: (...a) => console.log('[WARN]', ...a), error: (...a) => console.log('[ERR]', ...a), debug: (...a) => console.log('[DBG]', ...a) };
  const { Fetcher } = await import(pathToFileURL(path.join(projectRoot, 'src', 'utils', 'Fetcher.js')).href);
  const fetcher = new Fetcher(logger);
  const ctx = { type: 'movie', hostUrl: new URL('https://example.com/') };

  // Step 1: TMDB → IMDB ID
  console.log('\n=== Step 1: TMDB → IMDB ID (Inception tmdb=27205) ===');
  const { getImdbIdFromTmdbId } = await import(pathToFileURL(path.join(projectRoot, 'src', 'utils', 'tmdb.js')).href);
  const imdbObj = await getImdbIdFromTmdbId(fetcher, ctx, { id: 27205 });
  console.log('IMDB ID:', imdbObj);

  // Step 2: XML-RPC login via got-scraping
  console.log('\n=== Step 2: XML-RPC LogIn via got-scraping ===');
  const { gotScraping } = await import('got-scraping');
  const loginBody = '<?xml version="1.0"?><methodCall><methodName>LogIn</methodName><params><param><value><string></string></value></param><param><value><string></string></value></param><param><value><string>en</string></value></param><param><value><string>PhoeniXStremio v1.0</string></value></param></params></methodCall>';
  const loginRes = await gotScraping.post('https://api.opensubtitles.org/xml-rpc', {
    headers: { 'Content-Type': 'text/xml', 'User-Agent': 'PhoeniXStremio v1.0' },
    body: loginBody,
    timeout: { request: 9000 },
    throwHttpErrors: false,
    http2: false,
  });
  console.log('Login HTTP:', loginRes.statusCode, 'body length:', loginRes.body.length);
  console.log('Body preview (first 200):', loginRes.body.slice(0, 200));

  const tokenMatch = loginRes.body.match(/<name>token<\/name><value><string>([^<]+)<\/string>/);
  if (!tokenMatch) { console.error('No token!'); return; }
  const token = tokenMatch[1];
  console.log('Token:', token);

  // Step 3: SearchSubtitles
  console.log('\n=== Step 3: SearchSubtitles imdbid=1375666 (Inception) ===');
  const imdbNum = '1375666';
  const searchBody = `<?xml version="1.0"?><methodCall><methodName>SearchSubtitles</methodName><params><param><value><string>${token}</string></value></param><param><value><array><data><value><struct><member><name>imdbid</name><value><string>${imdbNum}</string></value></member><member><name>sublanguageid</name><value><string>eng,spa,fre,ger,ita,por,rus,dut,pol,tur,ara,hin,chi,jpn,kor</string></value></member></struct></value></data></array></value></param></params></methodCall>`;
  const searchRes = await gotScraping.post('https://api.opensubtitles.org/xml-rpc', {
    headers: { 'Content-Type': 'text/xml', 'User-Agent': 'PhoeniXStremio v1.0' },
    body: searchBody,
    timeout: { request: 12000 },
    throwHttpErrors: false,
    http2: false,
  });
  console.log('Search HTTP:', searchRes.statusCode, 'body length:', searchRes.body.length);
  console.log('Body preview (first 800):');
  console.log(searchRes.body.slice(0, 800));

  // Step 4: parse the response using our parser
  console.log('\n=== Step 4: Parse XML-RPC response ===');
  const { SubtitleFetcher } = await import(pathToFileURL(path.join(projectRoot, 'src', 'utils', 'SubtitleFetcher.js')).href);
  // Use the cached fetcher + ctx, force a fresh call
  SubtitleFetcher.clearCache();
  const subs = await SubtitleFetcher.fetchByTmdbId(fetcher, ctx, 27205, 'movie');
  console.log('Returned subtitles:', subs.length);
  for (const s of subs) console.log('  -', s.id, s.lang, s.url);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
