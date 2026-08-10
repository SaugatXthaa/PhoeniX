// Investigate pengu.uk stream URLs to understand the source
import { gotScraping } from 'got-scraping';
import { HeaderGenerator } from 'header-generator';

const hg = new HeaderGenerator({ browsers: ['chrome'], devices: ['desktop'], operatingSystems: ['windows'] });

const URLS = [
  // Japanese original
  'https://pengu.uk/direct/external/YT6_aTRtg_LEm306hGGnboIFr3Iyz3dlnHvj2u9SKamG6ZLa_DoxvHr4URXQD7Tr8Jfh12uE3STk4-HWTBW7Wpn5zBmJYHpKKRPapY_80gCvUe-YZTejLPLcDOjSUqHaaWQdWWoECmyRyT12_D0Q1nPBTuRaS7I3EwQ-rGWWcYDyA7XaexGk09jYL1TLDxt09nvcK9YHhilkZP_troP8K3aB6NprpPAlg8wA-Vz-ux_PASkMRTK_LKHEQ9rWT_XXrq-czKZq1pAf1qMStOrMzN8zyw0Z8oMomreZVJb6W_PkPL2UaTx2DLASTvJzAR28CDJIV_6Y0EoyqPBEXiFj8PCduxOhzDqPt5yArbAf4pYZHKozjHBwyq5c7-yit9tv_xS1q9xoW-CBHvBiPxP7y5ulIEWjtK7ZNprszw_bHiN03Au86yR5N8UMnn1E2ebTqzhbJBd-XNSAsVhoPE8Hq9V1jZ66i-1UWPta9fo8UV3vw-cIG9lrUcf1eZ77GKWnTboDwkZW9qt-RlIfcqfDKGJQmNbF6EDRSaSHFWPRXhb6_VmLrUe0oX2Tj_Six1_f9ADLaU-pg0nJOl4AIW4-mdNjnQegeZ6x_YtGE9H9rQ/f6f0bb7deeb1f63423324e2d462f710efixs.m3u8?psig=1786420398.N4MOQArPIQyZwCPk9cmfk_Ll6nTSm23stDPPHwh69I4:lQk9Q5VddejTd6cixWRzhVTUwTjdVJh5l-wG8M67FlA',
  // English dub
  'https://pengu.uk/direct/external/mQoWUc9VyKfr5f1jmT4HAhqWx9V4KUAYsj4-uxoyBGljWSVHbB3Y55ORt4UMs7qQkgJPF9f9MHw2xf3BXIRhgKU3K8GtglNZIvvKWCvC8Tw2pyYgSJQEpDzjJn1bY2cYoH_i65FCVpTuq6IlO4Pd8rQodUHRpYpOaZvUCyuDRTREgbtN2dwDq95iZ0fRq9ylD03__uAsQby3tuNcH5rYI3nnHi4Yd8k40-Dn9nmsJ7eqb2k3Rlr01OVeKUlKSttxm9Xdcb-DnSSpGZmDtUidI1Haq7xVeaWEtAz_ol0k0kgbjVjCZ9s82rCjA2DdIzegGV8tajApZugRc5Y41dVBQBz0APm3-PthbD5SFC8xmRr9jlxYH48b-YlR-BtaMmdOezyCffdJOz_KTvIfED9JOWYKlRlzHNa9eE9xm6z93n90xzH7vQdqQRdSVBYWhbNHIt6IJmWuOmHJ_vFjs5Yyxg4kYU4ic8fa6ExeIfCXVrwkwICAvEFml6a7c5gYMkd9JrMfYeXTOVEETFFtImvQFPCPRAGu_AsiKSpFQBAlnogUkR0KAfIRAIS5LtOo7jurCys1ZYsnoyxxA6oHve3hFMjjzougtHI-N3MnGPE/f6f0bb7deeb1f63423324e2d462f710efix.m3u8?psig=1786420398.sRyLKhvFBJ1kbPyuu1IsLuCsxxKimAF6OyHxGD-VnWM:n6j86jeKIVvvbuESuCXcbcnjHUUOnXXjrlEkZfISGIM',
  // Spanish dub
  'https://pengu.uk/direct/external/mQwm3WQo2P-w8-oEDz7t7bggSigdb46_p5LnGvazkzGUi07TE1_WV-kOltOlAI7pV2WhboQTR8jZgye9eXkSpczyA9r64N1v3rKYLndvjoog6lQk4WSFMcsL4-uOFMTUsgQEd06ef8tmLENvueqTxQZGIVxFQp5q0gRNJxSUVdDsJ4X6GK6L9CWVcTFmd7PiVdX8TCv1_m23tJMx3TUVVKhsP13z41rpvttnpRhrHW6rnkWGstXEHi_kBFX6Rzncm-rIsmRFKcwnFcWVIABOvmXrXXjzRUS2Yt1y2kPIjO-AlGBK1T0q1fUoMbi2zkHtpjf2jtbnsltDe41kJdkEfgChGrnE8XreIb4p9mHa5wBfoIo4hmESzzi4D7Ze6cF7D7-ZFbA1enB-Vs8Zx8GpG8XyND6E6eTu98-bLC6NZ-oTuVaFNFDHsBpOFTOIh7-FKQ-EM2Xp69wMpi8DNsXg5-i4EDzRIqxF7toVh-43Og-MxOwd5WIpcUgHSZm1xia4A2REp7JHwBJK9N2Rmxp11bWJI-XX00uXWQcUY6XoyTQ2UD7F_xNh92s6tfHO7Hu5XFEwQnih5jnIqkQsTiTKz6_UyVlAl-E/ba9aad01d1ad5d414d7773bb1120770a.m3u8?psig=1786420398.Lxhmh64PqZ8Mzpxr6AjnXHIsSBNY82niij6lYWZBpaQ:_rrd66coJe5VLOxmoqFspf2Rhqcgkq0aM27Imp1Ruas',
];

for (const url of URLS) {
  console.log(`\n=== ${url.slice(0, 80)}... ===`);
  const urlObj = new URL(url);
  console.log(`Host: ${urlObj.hostname}`);
  console.log(`Path: ${urlObj.pathname}`);
  console.log(`Path segments: ${urlObj.pathname.split('/').filter(Boolean).map(s => s.slice(0, 30)).join(' | ')}`);

  // Try to fetch the m3u8
  try {
    const r = await gotScraping.get(url, {
      headers: { ...hg.getHeaders({ httpVersion: '2' }), 'Accept': '*/*' },
      timeout: { request: 15000 }, throwHttpErrors: false, http2: true, followRedirect: true,
    });
    console.log(`Status: ${r.statusCode} | CT: ${r.headers['content-type']} | Body len: ${r.body?.length || 0}`);
    if (r.statusCode === 200) {
      console.log(`First 500 chars:\n${r.body.slice(0, 500)}`);
    } else {
      console.log(`Body: ${r.body?.slice(0, 300)}`);
      console.log(`Headers: ${JSON.stringify(Object.fromEntries(Object.entries(r.headers).filter(([k]) => !k.startsWith(':'))))}`);
    }
  } catch (e) {
    console.log(`ERR: ${e.message}`);
  }
}
