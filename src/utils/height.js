// src/utils/height.js

export const guessHeightFromPlaylist = async (fetcher, ctx, playlistUrl, init) => {
  try {
    const m3u8Data = await fetcher.text(ctx, playlistUrl, init);
    const heights = Array.from(m3u8Data.matchAll(/\d+x(\d+)|(\d+)p/g))
      .map(m => m[1] || m[2])
      .filter(h => h !== undefined)
      .map(h => parseInt(h));
    return heights.length ? Math.max(...heights) : undefined;
  } catch {
    return undefined;
  }
};
