import { Movie4kTo } from '../src/source/Movie4kTo.js';

const mockFetcher = {
  text: async () => '',
  json: async () => ({}),
};

const source = new Movie4kTo(mockFetcher);
console.log('Source ID:', source.id);
console.log('Source Label:', source.label);
console.log('Content Types:', source.contentTypes);
console.log('Base URL:', source.baseUrl);
console.log('✓ Movie4kTo source loaded successfully');

// Verify the EMBED_SOURCES list indirectly by checking handleInternal signature
console.log('handleInternal exists:', typeof source.handleInternal === 'function');
