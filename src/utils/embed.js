// src/utils/embed.js

import { unpack } from 'unpacker';

export const unpackEval = (html) => {
  const evalMatch = html.match(/eval\(function\(p,a,c,k,e,d\).*\)\)/);
  if (!evalMatch) throw new Error('No p.a.c.k.e.d string found');
  return unpack(evalMatch[0]);
};

export const extractUrlFromPacked = (html, linkRegExps) => {
  const unpacked = unpackEval(html);
  for (const re of linkRegExps) {
    const m = unpacked.match(re);
    if (m && m[1]) return new URL(`https://${m[1].replace(/^(https:)?\/\//, '')}`);
  }
  throw new Error('Could not find a stream link in embed');
};
