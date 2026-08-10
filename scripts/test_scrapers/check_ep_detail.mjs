import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';
const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'] });

// Check the episode detail endpoint
const r = await gotScraping.get('https://anilibria.top/api/v1/anime/releases/episodes/95d6e739-789e-11ec-ae92-0242ac120002', {
  headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': 'application/json' },
  timeout: { request: 10000 }, throwHttpErrors: false,
});
console.log('Episode detail:', r.statusCode);
console.log(r.body.slice(0, 800));
