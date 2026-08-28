// Debug subtitle scoring for English specifically
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const { Fetcher } = await import(pathToFileURL(path.join(projectRoot, 'src', 'utils', 'Fetcher.js')).href);
  const fetcher = new Fetcher(logger);
  const ctx = { type: 'movie', hostUrl: new URL('https://example.com/') };

  // Read the SubtitleFetcher source to get internal functions
  const fs = require('fs');
  const source = fs.readFileSync(path.join(projectRoot, 'src', 'utils', 'SubtitleFetcher.js'), 'utf8');

  // Extract the scoreSubtitle function for testing
  const scoreStart = source.indexOf('function scoreSubtitle(');
  const scoreEnd = source.indexOf('\n}\n\n// Convert OpenSubtitles');
  const scoreSource = source.slice(scoreStart, scoreEnd + 2);

  // Also extract ISO_639_2B_TO_1 and LANG_PRIORITY
  const isoStart = source.indexOf('const ISO_639_2B_TO_1 = {');
  const isoEnd = source.indexOf('};', isoStart) + 2;
  const isoSource = source.slice(isoStart, isoEnd);

  // Create a temp module with the extracted functions
  const tmpModule = `
${isoSource}
${scoreSource}
module.exports = { scoreSubtitle };
`;
  const tmpFile = path.join('/tmp', 'score_test.cjs');
  fs.writeFileSync(tmpFile, tmpModule);
  const { scoreSubtitle } = require(tmpFile);

  // Now query OpenSubtitles directly for English subs for Inception
  // and score each one
  const { SubtitleFetcher } = await import(pathToFileURL(path.join(projectRoot, 'src', 'utils', 'SubtitleFetcher.js')).href);
  SubtitleFetcher.clearCache();

  // Get the token + make a direct API call for English subs
  const { getImdbIdFromTmdbId } = await import(pathToFileURL(path.join(projectRoot, 'src', 'utils', 'tmdb.js')).href);
  const imdbObj = await getImdbIdFromTmdbId(fetcher, ctx, { id: 27205 });
  console.log('IMDB ID:', imdbObj.id);
  const imdbNum = imdbObj.id.replace(/^tt/, '');

  // Login
  const { gotScraping } = await import('got-scraping');
  const loginRes = await gotScraping.post('https://api.opensubtitles.org/xml-rpc', {
    headers: { 'Content-Type': 'text/xml', 'User-Agent': 'PhoeniXStremio v1.0' },
    body: '<?xml version="1.0"?><methodCall><methodName>LogIn</methodName><params><param><value><string></string></value></param><param><value><string></string></value></param><param><value><string>en</string></value></param><param><value><string>PhoeniXStremio v1.0</string></value></param></params></methodCall>',
    timeout: { request: 10000 }, throwHttpErrors: false, http2: false,
  });
  const token = loginRes.body.match(/<name>token<\/name><value><string>([^<]+)<\/string>/)?.[1];
  console.log('Token:', token);

  // Search English subs for Inception
  const searchBody = `<?xml version="1.0"?><methodCall><methodName>SearchSubtitles</methodName><params><param><value><string>${token}</string></value></param><param><value><array><data><value><struct><member><name>imdbid</name><value><string>${imdbNum}</string></value></member><member><name>sublanguageid</name><value><string>eng</string></value></member></struct></value></data></array></value></param></params></methodCall>`;
  const searchRes = await gotScraping.post('https://api.opensubtitles.org/xml-rpc', {
    headers: { 'Content-Type': 'text/xml', 'User-Agent': 'PhoeniXStremio v1.0' },
    body: searchBody,
    timeout: { request: 12000 }, throwHttpErrors: false, http2: false,
  });

  // Parse the response using our XML parser
  const parserSource = source.slice(
    source.indexOf('// Minimal XML-RPC response parser'),
    source.indexOf('export const SubtitleFetcher')
  );
  const parserFile = path.join('/tmp', 'parser_extract.cjs');
  fs.writeFileSync(parserFile, parserSource + '\nmodule.exports = { parseXmlRpcResponse };');
  const { parseXmlRpcResponse } = require(parserFile);
  const result = parseXmlRpcResponse(searchRes.body);
  const items = result?.data || [];

  console.log(`\nGot ${items.length} English subtitles for Inception`);
  console.log('\nScoring each:');
  for (const item of items.slice(0, 10)) {
    const score = scoreSubtitle(item);
    console.log(`  score=${score} | lang=${item.SubLanguageID} | rel="${(item.MovieReleaseName || '').slice(0, 50)}" | fps=${item.MovieFPS} | bad=${item.SubBad} | HI=${item.SubHearingImpaired} | enc=${item.SubEncoding} | trusted=${item.SubFromTrusted} | rating=${item.SubRating} | dl=${item.SubDownloadsCnt}`);
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
