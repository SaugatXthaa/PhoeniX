// Test the XML-RPC parser with a minimal sample
'use strict';
const path = require('path');
const { pathToFileURL } = require('url');

async function main() {
  const projectRoot = path.resolve(__dirname, '..');

  // Sample XML-RPC response with nested struct + array (simplified)
  const sample1 = `<?xml version="1.0" encoding="utf-8"?>
<methodResponse>
<params>
<param>
<value>
<struct>
<member><name>status</name><value><string>200 OK</string></value></member>
<member><name>data</name><value><array><data>
<value><struct>
<member><name>SubLanguageID</name><value><string>eng</string></value></member>
<member><name>SubDownloadLink</name><value><string>https://example.com/sub1.gz</string></value></member>
<member><name>SubDownloadsCnt</name><value><string>100</string></value></member>
</struct></value>
<value><struct>
<member><name>SubLanguageID</name><value><string>spa</string></value></member>
<member><name>SubDownloadLink</name><value><string>https://example.com/sub2.gz</string></value></member>
<member><name>SubDownloadsCnt</name><value><string>50</string></value></member>
</struct></value>
</data></array></value></member>
</struct>
</value>
</param>
</params>
</methodResponse>`;

  // Use the SubtitleFetcher's parser by importing its parseXmlRpcResponse
  // function. It's not exported, so we'll re-implement the same parsing
  // logic here to test it.
  // Actually, let's just directly eval the file's parseXmlRpcResponse by
  // loading the source as text and extracting the functions.
  const fs = require('fs');
  const source = fs.readFileSync(path.join(projectRoot, 'src', 'utils', 'SubtitleFetcher.js'), 'utf8');

  // Extract the parser function bodies
  const startIdx = source.indexOf('// Minimal XML-RPC response parser');
  const endIdx = source.indexOf('export const SubtitleFetcher');
  const parserSource = source.slice(startIdx, endIdx);

  // Wrap in a module that exports the functions
  const wrappedSource = parserSource + '\nmodule.exports = { parseXmlRpcResponse, parseValueAt };\n';
  const tmpFile = path.join('/tmp', 'parser_test.cjs');
  fs.writeFileSync(tmpFile, wrappedSource);

  const { parseXmlRpcResponse } = require(tmpFile);

  try {
    const result = parseXmlRpcResponse(sample1);
    console.log('Status:', result.status);
    console.log('Data is array:', Array.isArray(result.data));
    console.log('Data length:', result.data?.length);
    if (Array.isArray(result.data)) {
      for (const item of result.data) {
        console.log('  -', item.SubLanguageID, item.SubDownloadLink, 'cnt:', item.SubDownloadsCnt);
      }
    }
  } catch (e) {
    console.error('Parse error:', e.message);
    // Walk through manually
    const valueStart = sample1.indexOf('<params>');
    const innerValueStart = sample1.indexOf('<value>', valueStart) + 7;
    console.log('innerValueStart at:', innerValueStart, 'char:', JSON.stringify(sample1.slice(innerValueStart, innerValueStart + 30)));
    // Skip whitespace
    let i = innerValueStart;
    while (i < sample1.length && /\s/.test(sample1[i])) i++;
    console.log('After whitespace, at:', i, 'char:', JSON.stringify(sample1.slice(i, i + 30)));
    // Check for <struct>
    if (sample1.slice(i, i + 8) === '<struct>') {
      console.log('Found <struct> at', i);
      let pos = i + 8;
      while (pos < sample1.length && /\s/.test(sample1[pos])) pos++;
      console.log('After struct whitespace, at:', pos, 'char:', JSON.stringify(sample1.slice(pos, pos + 30)));
      // Loop members
      let memberCount = 0;
      while (sample1.slice(pos, pos + 8) === '<member>') {
        memberCount++;
        pos += 8;
        while (pos < sample1.length && /\s/.test(sample1[pos])) pos++;
        if (sample1.slice(pos, pos + 6) !== '<name>') {
          console.error('Expected <name> at', pos, 'but got:', JSON.stringify(sample1.slice(pos, pos + 30)));
          break;
        }
        const nameEnd = sample1.indexOf('</name>', pos + 6);
        const name = sample1.slice(pos + 6, nameEnd);
        console.log(`  Member ${memberCount}: name="${name}"`);
        pos = nameEnd + 7;
        while (pos < sample1.length && /\s/.test(sample1[pos])) pos++;
        if (sample1.slice(pos, pos + 7) !== '<value>') {
          console.error('Expected <value> at', pos);
          break;
        }
        console.log('    <value> at', pos);
        // Skip past value
        const endValueIdx = sample1.indexOf('</value>', pos + 7);
        console.log('    </value> at', endValueIdx);
        pos = endValueIdx + 8;
        while (pos < sample1.length && /\s/.test(sample1[pos])) pos++;
        console.log('    After </value>, at:', pos, 'char:', JSON.stringify(sample1.slice(pos, pos + 20)));
        if (sample1.slice(pos, pos + 9) === '</member>') {
          console.log('    </member> found');
          pos += 9;
        } else {
          console.error('Expected </member> at', pos, 'but got:', JSON.stringify(sample1.slice(pos, pos + 30)));
          break;
        }
        while (pos < sample1.length && /\s/.test(sample1[pos])) pos++;
      }
      console.log('After member loop, at:', pos, 'char:', JSON.stringify(sample1.slice(pos, pos + 20)));
      console.log('Expect </struct>:', sample1.slice(pos, pos + 9) === '</struct>');
    }
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
