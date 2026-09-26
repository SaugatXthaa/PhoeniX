#!/usr/bin/env node
// Task 101: scenario-driven formatter preview verification.
// 1) Legacy mode (no samples) still returns the 4 built-ins.
// 2) Scenario mode renders a client-sent sample through the REAL engine.
// 3) Malformed samples fail open to the built-ins.
// 4) Empty templates behave as before.

const BASE = process.env.BASE || "http://localhost:7100";
let pass = 0, fail = 0;
const ok = (cond, label, extra = "") => {
  if (cond) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; console.log(`  FAIL ${label} ${extra}`); }
};

const NAME_TPL = '{stream.resolution::exists["{stream.resolution}"||"?res"]}{stream.proxied[" · proxied"||""]}{stream.source::exists[" · {stream.source}"||""]}';
const DESC_TPL = '{stream.title} · {stream.size::bytes} · {stream.encode::exists["{stream.encode}"||"?codec"]} · {metadata.type}{metadata.season::exists[" s{metadata.season}"||""]}{metadata.episode::exists["e{metadata.episode}"||""]}';

const REMUX = {
  label: "Scenario · movie",
  meta: {
    height: 2160, bytes: 48.1 * 1024 ** 3, bandwidth: 0,
    title: "Dune Part Two", sourceLabel: "4KHDHub", serverName: "10Gbps",
    streamingPlatform: "", sourceType: "BluRay Remux", format: "mkv",
    codec: "HEVC", audioCodec: "TrueHD", audioChannels: "5.1", hdr: "DV,HDR10",
    releaseGroup: "FRAM", countryCodes: ["en", "hi"], subtitles: [{ lang: "en" }],
  },
  stream: { name: "🐦‍🔥 PhoeniX · 4K · 4KHDHub · 10Gbps", title: "Dune Part Two · 2024 · HDR · DTS-HD MA 5.1 · 48.1 GB" },
  url: "https://dl.example.com/Dune.Part.Two.2024.2160p.BluRay.Remux.HEVC.mkv",
  requestType: "movie", requestId: "tt15239678",
};
const ANIME = {
  label: "Scenario · episode",
  meta: {
    height: 1080, bytes: 0, bandwidth: 0,
    title: "Sousou no Frieren", sourceLabel: "HiAnime", serverName: "MegaPlay",
    streamingPlatform: "", sourceType: "Web-DL", format: "hls",
    codec: "HEVC", audioCodec: "AAC", audioChannels: "", hdr: "",
    releaseGroup: "SubsPlease", countryCodes: ["ja", "en"], subtitles: [{ lang: "en" }],
  },
  stream: { name: "🐦‍🔥 PhoeniX · 1080p · HiAnime · MegaPlay", title: "Sousou no Frieren · S2E1 · Sub+Dub" },
  url: "https://addon.example/proxy?url=https%3A%2F%2Fcdn.example%2Ffrieren.m3u8",
  requestType: "series", requestId: "tt209867:2:1",
};

async function post(body) {
  const r = await fetch(`${BASE}/api/formatter-preview`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

console.log("== 1. legacy mode (no samples key) ==");
{
  const out = await post({ name: NAME_TPL, description: DESC_TPL });
  ok(out.ok === true, "ok:true");
  ok(Array.isArray(out.samples) && out.samples.length === 4, "4 built-in samples", `got ${out.samples?.length}`);
  ok(typeof out.defaults?.name === "string", "defaults present");
}

console.log("== 2. scenario mode: movie remux through the real engine ==");
{
  const out = await post({ name: NAME_TPL, description: DESC_TPL, samples: [REMUX] });
  ok(out.ok === true, "ok:true");
  ok(out.samples?.length === 1, "1 sample");
  const s = out.samples?.[0];
  ok(s?.name?.includes("2160p") === true, "resolution token rendered as 2160p (AIOStreams form)", s?.name);
  ok(s?.name?.includes("4KHDHub") === true, "{stream.source} = sourceLabel", s?.name);
  ok(s?.description?.includes("51.65 GB") === true, "size bytes modifier rendered (48.1 GiB = 51.65 GB base-10)", s?.description);
  ok(s?.description?.includes("HEVC") === true, "{stream.encode} rendered", s?.description);
  ok(s?.description?.includes("movie") === true, "metadata.type rendered", s?.description);
  ok(!/\{(?:stream|addon|metadata|user|config|debug|tools)\./.test(s?.name + s?.description), "no token leakage");
}

console.log("== 3. scenario mode: series episode + proxied ==");
{
  const out = await post({ name: NAME_TPL, description: DESC_TPL, samples: [ANIME] });
  const s = out.samples?.[0];
  ok(s?.name?.includes("1080p") === true, "1080p rendered", s?.name);
  ok(s?.name?.includes("proxied") === true, "/proxy url marks proxied", s?.name);
  ok(s?.description?.includes("series s2e1") === true, "series + season/episode from requestId", s?.description);
}

console.log("== 4. fail-open on malformed samples ==");
{
  const out = await post({
    name: NAME_TPL, description: DESC_TPL,
    samples: [null, "junk", 42, { label: "no meta at all" }, { meta: { height: "x" } }, REMUX],
  });
  ok(out.samples?.length === 1, "all malformed dropped → only the valid one renders", `got ${out.samples?.length}`);
  ok(out.samples?.[0]?.name?.includes("2160p"), "valid sample intact");
}
{
  const out = await post({ name: NAME_TPL, description: DESC_TPL, samples: [null, "junk", { label: "no meta at all" }] });
  ok(out.samples?.length === 4, "nothing valid → built-ins render (fail-open)", `got ${out.samples?.length}`);
}
{
  // oversized / hostile values get capped, not rejected
  const hostile = JSON.parse(JSON.stringify(REMUX));
  hostile.meta.title = "X".repeat(5000);
  hostile.meta.countryCodes = ["en", "<script>", "ja", {}, "en"];
  hostile.url = "javascript:alert(1)".padEnd(3000, "a");
  const out = await post({ name: "{stream.title}", description: "{stream.title}", samples: [hostile] });
  const s = out.samples?.[0];
  ok(s && s.name.length <= 300, "hostile title capped", `${s?.name?.length}`);
  ok(s && !s.name.includes("<script>"), "bad language code dropped");
}

console.log("== 5. >8 samples capped; empty templates = native default look ==");
{
  const out = await post({ name: NAME_TPL, description: DESC_TPL, samples: Array(12).fill(REMUX) });
  ok(out.samples?.length === 8, "capped at 8", `got ${out.samples?.length}`);
  // Task 102: empty templates = the Default preset = the native pre-UI
  // format. The endpoint renders each sample through the REAL native
  // builder (StreamResolver.buildName/buildTitle), so the card shows the
  // classic look: '🐦‍🔥 PhoeniX · …' name + multi-line native description.
  const empty = await post({ name: "", description: "", samples: [REMUX] });
  ok(empty.ok === true && empty.defaults && typeof empty.defaults.name === "string" && empty.defaults.description === "", "empty templates → defaults present (empty preset)");
  const s = empty.samples?.[0];
  ok(s && typeof s.name === "string" && s.name.startsWith("🐦‍🔥 PhoeniX"), "empty templates → native builder name", JSON.stringify(s?.name));
  ok(s && typeof s.description === "string" && s.description.includes("\n") && s.description.includes("🔗"), "empty templates → native multi-line description", JSON.stringify(s?.description?.slice(0, 80)));
}

console.log(`\nRESULT: ${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
