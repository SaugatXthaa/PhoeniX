import json, re

d = json.load(open('/tmp/flare_test.json'))
body = d.get('solution', {}).get('response', '')

packed_match = re.search(r'eval\(function\(p,a,c,k,e,d\).*?\)\)', body, re.DOTALL)
if packed_match:
    packed = packed_match.group(0)
    print('Packed length:', len(packed))
else:
    print('No packed JS found')

sources = re.findall(r'sources:\s*\[\s*\{[^}]*file:\s*["\x27]([^"\x27]+)["\x27]', body, re.I)
print('Sources:', sources[:3] if sources else 'NONE')

m3u8 = re.findall(r'https?://[^"\x27\s]*\.m3u8[^"\x27\s]*', body)
print('M3U8:', m3u8[:3] if m3u8 else 'NONE')

file_match = re.findall(r'file:\s*["\x27]([^"\x27]+)["\x27]', body)
print('File matches:', [f[:80] for f in file_match[:5]])

for m in re.finditer(r'sources', body):
    start = max(0, m.start() - 20)
    end = min(len(body), m.end() + 100)
    print(f'Context: ...{body[start:end]}...')
