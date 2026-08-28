// Debug XML-RPC parser in isolation
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  const { Fetcher } = await import(pathToFileURL(path.join(projectRoot, 'src', 'utils', 'Fetcher.js')).href);
  const fetcher = new Fetcher(logger);

  // Step 1: login
  const body1 = '<?xml version="1.0"?><methodCall><methodName>LogIn</methodName><params><param><value><string></string></value></param><param><value><string></string></value></param><param><value><string>en</string></value></param><param><value><string>PhoeniXStremio v1.0</string></value></param></params></methodCall>';
  const r1 = await fetch('https://api.opensubtitles.org/xml-rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml', 'User-Agent': 'PhoeniXStremio v1.0' },
    body: body1,
  });
  const t1 = await r1.text();
  console.log('LogIn response (first 500 chars):');
  console.log(t1.slice(0, 500));

  const tokenMatch = t1.match(/<name>token<\/name><value><string>([^<]+)<\/string>/);
  if (!tokenMatch) { console.error('No token found'); process.exit(1); }
  const token = tokenMatch[1];
  console.log('\nToken:', token);

  // Step 2: SearchSubtitles
  const body2 = `<?xml version="1.0"?><methodCall><methodName>SearchSubtitles</methodName><params><param><value><string>${token}</string></value></param><param><value><array><data><value><struct><member><name>imdbid</name><value><string>1375666</string></value></member><member><name>sublanguageid</name><value><string>eng,spa,fre,ger,ita</string></value></member></struct></value></data></array></value></param></params></methodCall>`;
  const r2 = await fetch('https://api.opensubtitles.org/xml-rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml', 'User-Agent': 'PhoeniXStremio v1.0' },
    body: body2,
  });
  const t2 = await r2.text();
  console.log('\nSearchSubtitles response (first 1500 chars):');
  console.log(t2.slice(0, 1500));
  console.log('\nResponse length:', t2.length);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
