// src/utils/resolution.js

export const RESOLUTIONS = ['2160p', '1440p', '1080p', '720p', '576p', '480p', '360p', '240p', '144p'];

export const getClosestResolution = (height) => {
  if (!height) return 'Unknown';
  const nums = RESOLUTIONS.map(r => Number(r.replace('p', '')));
  const closest = nums.reduce((prev, curr) => Math.abs(curr - height) < Math.abs(prev - height) ? curr : prev);
  return `${closest}p`;
};

export const findHeight = (value) => {
  if (!value) return undefined;
  const height = parseInt(RESOLUTIONS.find(res => value.toLowerCase().includes(res))?.replace('p', '') ?? '', 10);
  return isNaN(height) ? undefined : height;
};
