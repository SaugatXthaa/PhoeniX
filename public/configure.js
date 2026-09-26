// public/configure.js — PhoeniX configuration UI (Task 98).
//
// Same-to-same dashboard adaptation of the reference configure UI: sidebar
// navigation, Overview / Sources / Filtering / Playback / Status / Account
// tabs, live per-source status dots, per-source quality caps, filesize
// bounds, grouping/sorting/timeout, custom formatter with live preview, and
// a local config-versions store. React via esm.sh — no build step, exactly
// like the reference page.
//
// PhoeniX-specific deltas (all deliberate, all functional):
//   - No donations anywhere (button, banner, donor tokens — removed).
//   - No external community links, no third-party service references.
//   - No account server: config autosaves to THIS browser (localStorage);
//     the Account tab's "Config versions" snapshots are local and every
//     button on them works (copy link / install / activate / delete).
//   - No Jellyfin tab: this addon is a Stremio stream addon, not a Jellyfin
//     server — a dead tab would be fake functionality.
//   - Real-time status for every source from /api/status (background
//     monitor + passive telemetry), polled every 30s.

import React, { useEffect, useState, useCallback, useRef, useMemo } from "https://esm.sh/react@18.3.1";
import { createRoot } from "https://esm.sh/react-dom@18.3.1/client";

const h = React.createElement;

// ── inline SVG icon components (no external dependency) ──
const _ic = (paths, { size = 24, fill = "none", strokeWidth = 2, ...rest } = {}) =>
  h("svg", { viewBox: "0 0 24 24", width: size, height: size, fill, stroke: "currentColor", strokeWidth, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", ...rest }, ...paths.map(d => typeof d === "string" ? h("path", { d }) : h("path", { d: d.d || "" })));
const Check = (p) => _ic(["M20 6 9 17l-5-5"], p);
const ChevronDown = (p) => _ic(["M6 9l6 6 6-6"], p);
const Clipboard = (p) => _ic(["M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2", "M9 2h6a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"], p);
const Gauge = (p) => _ic(["M12 12m-9 0a9 9 0 1 0 18 0 9 9 0 1 0-18 0", "M12 8v4", "M12 12l3.5 3.5"], p);
const MonitorPlay = (p) => _ic(["M2 3h20a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z", "M8 21h8", "M12 17v4", "M10 9l5 3-5 3V9z"], p);
const Moon = (p) => _ic(["M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"], p);
const Play = (p) => _ic(["M5 3l14 9-14 9V3z"], p);
const SlidersHorizontal = (p) => _ic(["M21 4H14", "M10 4H3", "M21 12H12", "M8 12H3", "M21 20H16", "M12 20H3", "M12 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4z", "M10 12a2 2 0 1 0 0 4 2 2 0 0 0 0-4z", "M14 18a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"], p);
const Sun = (p) => _ic(["M12 12m-5 0a5 5 0 1 0 10 0 5 5 0 1 0-10 0", "M12 1v2", "M12 21v2", "M4.22 4.22l1.42 1.42", "M18.36 18.36l1.42 1.42", "M1 12h2", "M21 12h2", "M4.22 19.78l1.42-1.42", "M18.36 5.64l1.42-1.42"], p);
const Menu = (p) => _ic(["M4 6h16", "M4 12h16", "M4 18h16"], p);
const LayoutDashboard = (p) => _ic(["M3 3h7v9H3z", "M14 3h7v5h-7z", "M14 12h7v9h-7z", "M3 16h7v5H3z"], p);
const Film = (p) => _ic(["M7 2v20", "M17 2v20", "M2 12h20", "M2 7h5", "M2 17h5", "M17 7h5", "M17 17h5", "M2 2h20v20H2z"], p);
const FilterIcon = (p) => _ic(["M22 3H2l8 9.46V19l4 2v-8.54L22 3z"], p);
const Settings2 = (p) => _ic(["M20 7H4", "M20 12H4", "M20 17H4"], p);
const Zap = (p) => _ic(["M13 2 3 14h9l-1 8 10-12h-9l1-8z"], p);

const ICON = "public/logo.png";
const LS = {
  theme: "phoenix-theme",
  config: "phoenix-config",
  sidebar: "phoenix-sidebar",
  versions: "phoenix-versions",
};

// ── source registry (fetched from /sources.json at load) ──
// providers: [{ id, name, tags, animeOnly, contentTypes, key }]
let REGISTRY = [];
const providers = () => REGISTRY;
const providerKey = (id) => `source_${id}`;

// ── presets (curated for this addon's registry) ──
const PRESETS_BY_ID = {
  dev: { id: "dev", label: "Developer's Choice", ids: ["4khdhub", "moviebox", "cinebyrocks", "hdhub4uv2", "cinewave"] },
  "4k": { id: "4k", label: "4K Cinema", ids: ["4khdhub", "fourkhdhubone", "cinefreak", "moviesdrivev2", "bollyflix"] },
  fast: { id: "fast", label: "Fast & Light", ids: ["moviebox", "vidfast", "vidlink2", "videasyto"] },
  regional: { id: "regional", label: "Regional / South Asian", ids: ["vegamovies2", "hdhub4uv2", "desiflix", "hindmoviez", "bollyflix", "persianstremio"] },
  anime: { id: "anime", label: "Anime", ids: ["hianime", "anikoto", "animekai", "animegg", "reanime", "4khdhub"] },
};
// "Everything" is registry-complete at render time.
const presets = () => [
  ...Object.values(PRESETS_BY_ID),
  { id: "all", label: "Everything", ids: REGISTRY.map((p) => p.id) },
];

const qualities = [
  { key: "res_2160", rank: 2160, label: "4K", hint: "2160p" },
  { key: "res_1080", rank: 1080, label: "1080p", hint: "Full HD" },
  { key: "res_720", rank: 720, label: "720p", hint: "HD" },
  { key: "res_480", rank: 480, label: "480p", hint: "SD" },
  { key: "res_360", rank: 360, label: "360p", hint: "Low data" },
];

const timeoutOptions = [
  { value: 5, label: "5s", hint: "Speedy" },
  { value: 10, label: "10s", hint: "Fast" },
  { value: 15, label: "15s", hint: "Balanced" },
  { value: 30, label: "30s", hint: "Thorough" },
  { value: 45, label: "45s", hint: "Patient" },
];

// Community formatter templates — written for the fields this addon's
// resolver actually provides (see /api/formatter-preview for live truth).
const FORMATTER_PRESETS = {
  prism: {
    label: "Prism",
    name: `{stream.resolution::exists["{stream.resolution::replace('2160p','🔥 4K UHD')::replace('1080p','🚀 FHD')::replace('720p','💿 HD')::replace('480p','💩 SD')::replace('360p','💩 SD')}"||"🎞️ Stream"]}`,
    description: `{stream.title::exists["{stream.title::title}"||""]}{stream.size::exists["\n📦 {stream.size}"||""]}{stream.languages::exists["\n🗣️ {stream.languages}"||""]}\n📡 {stream.source}{stream.server::exists[" · {stream.server}"||""]} · {addon.name}`,
  },
  tamtaro: {
    label: "TamTaro",
    name: `{stream.resolution::exists["{stream.resolution::replace('2160p','  4K ')::replace('1080p','  FHD ')::replace('720p','  HD ')}"||""]}`,
    description: `{stream.title}\n{stream.size::exists["📦 {stream.size} "||""]}📡 {stream.source} · {addon.name}`,
  },
  "light-google-drive": {
    label: "Light Google Drive",
    name: `{?{addon.name}?}{stream.resolution::exists[" {stream.resolution}"||""]}`,
    description: `{stream.title::exists["📁 {stream.title::title}"||""]}{stream.size::exists["\n📦 {stream.size}"||""]}{stream.languages::exists["\n🌐 {stream.languages}"||""]}`,
  },
  minimalistic: {
    label: "Minimalistic",
    name: `{stream.resolution::exists["{stream.resolution::replace('2160p','✨ 4K')::replace('1080p','🧿 1080p')::replace('720p','💿 720p')}"||"N/A"]}`,
    description: `{stream.title}{stream.size::exists[" · {stream.size}"||""]}`,
  },
};

function detectFormatterPreset(name, description) {
  for (const [presetKey, preset] of Object.entries(FORMATTER_PRESETS)) {
    if (preset.name === name && preset.description === description) return presetKey;
  }
  return null;
}

const initialSelectedQualities = Object.fromEntries(qualities.map(({ key }) => [key, true]));

// ── clipboard helpers (identical fallback chain to the reference page) ──
function legacyCopy(text) {
  const input = document.createElement("textarea");
  input.value = text;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  const ok = document.execCommand("copy");
  input.remove();
  if (!ok) throw new Error("Copy command failed");
}

async function copyUrlWhenReady(urlPromise) {
  if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": urlPromise.then((url) => new Blob([url], { type: "text/plain" })),
        }),
      ]);
      return;
    } catch {
      // fall through
    }
  }
  const url = await urlPromise;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(url);
      return;
    } catch {
      // fall through to legacy
    }
  }
  legacyCopy(url);
}

// ── config → URL segment (identical scheme to the reference page) ──
async function compactConfigSegment(json) {
  if (typeof CompressionStream !== "function") return null;
  try {
    const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const base64url = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `z${base64url}`;
  } catch {
    return null;
  }
}

async function manifestPath(config) {
  const json = JSON.stringify(config);
  const plain = encodeURIComponent(json);
  const compact = await compactConfigSegment(json);
  const segment = compact && compact.length < plain.length ? encodeURIComponent(compact) : plain;
  return `/${segment}/manifest.json`;
}

// ── shared components ──
function IconButton({ children, label, onClick }) {
  return h("button", { className: "icon-button", type: "button", onClick, "aria-label": label, title: label }, children);
}

function StatusDot({ status, name }) {
  const kind = status === "up" || status === "down" ? status : "unknown";
  const label = kind === "up" ? "Working" : kind === "down" ? "Down" : "Not checked yet";
  return h("span", { className: `provider-status-dot is-${kind}`, title: `${name}: ${label}`, "aria-label": label });
}

// Pick one lead tag (quality preferred, then speed); the rest collapse.
function providerTagLead(provider) {
  if (!provider.tags || !provider.tags.length) return { lead: null, rest: "" };
  const qualityTag = provider.tags.find((t) => /^[0-9]+K$|^[0-9]+p$/.test(t));
  const speedTag = provider.tags.find((t) => t === "Very Fast" || t === "Fast" || t === "Slow");
  const lead = qualityTag || speedTag || null;
  const restList = provider.tags.filter((t) => t !== lead);
  const rest = restList.join(" · ");
  return { lead, rest };
}

function ProviderCard({ provider, selected, status, onToggle }) {
  const { lead, rest } = providerTagLead(provider);
  return h(
    "button",
    { type: "button", className: `provider-card${selected ? " is-selected" : ""}`, onClick: onToggle, "aria-pressed": selected },
    h(
      "span",
      { className: "provider-card-top" },
      h("span", { className: "provider-name" }, provider.name),
      h("span", { className: "provider-card-top-right", style: { display: "flex", alignItems: "center", gap: "6px" } },
        h(StatusDot, { status, name: provider.name }),
        h("span", { className: "check-dot" }, h(Check, { size: 12, strokeWidth: 3 })),
      ),
    ),
    (lead || rest)
      ? h(
          "span",
          { className: "provider-tags" },
          lead ? h("span", { className: "provider-tag-lead" }, lead) : null,
          (lead && rest) ? h("span", { "aria-hidden": "true" }, " · ") : null,
          h("span", { className: "provider-tag-rest" }, rest),
        )
      : null,
  );
}

function QualityOption({ quality, selected, onToggle }) {
  return h(
    "button",
    { className: `quality-pill${selected ? " is-selected" : ""}`, onClick: onToggle, "aria-pressed": selected, style: { alignItems: "center", justifyContent: "space-between" } },
    h("span", { className: "provider-name" }, quality.label),
    h("span", { className: "check-dot", "aria-hidden": "true" }, h(Check, { size: 12, strokeWidth: 3 })),
  );
}

function QualityLimitRow({ quality, providerId, providerName, mode, onChange }) {
  // Undefined/absent = included, no cap. 0 = explicit block. >0 = cap.
  const enabled = mode !== 0;
  const currentLimit = enabled ? (mode || "") : "";
  return h(
    "div",
    { className: "quality-limit-item" },
    h("span", { className: "cap-label" }, quality.label),
    h(
      "span",
      { className: "quality-limit-field" },
      h("input", {
        type: "number", min: "1", max: "20", step: "1", inputMode: "numeric",
        value: currentLimit, placeholder: "", disabled: !enabled,
        "aria-label": `Max ${quality.label} streams from ${providerName}`,
        onChange: (e) => {
          const digits = e.target.value.replace(/[^0-9]/g, "");
          if (digits === "") { onChange(`${providerId}_${quality.rank}`, ""); return; }
          let n = parseInt(digits, 10);
          if (n > 20) n = 20;
          onChange(`${providerId}_${quality.rank}`, n > 0 ? n : "");
        },
      }),
      h("span", { className: "inf-badge", "aria-hidden": "true" }, "∞"),
    ),
    h("button", {
      type: "button", role: "switch", "aria-checked": enabled,
      "aria-label": `${enabled ? "Block" : "Allow"} ${quality.label} from ${providerName}`,
      className: `toggle-switch${enabled ? " is-on" : ""}`,
      onClick: () => onChange(`${providerId}_${quality.rank}`, enabled ? 0 : ""),
    }),
  );
}

function QualityDrawer({ open, providers: selectedProviders, qualityLimits, onChange }) {
  if (!open || !selectedProviders.length) return null;
  return h(
    "div",
    { className: "quality-drawer" },
    selectedProviders.map((provider) =>
      h(
        "div",
        { key: provider.id, className: "quality-drawer-section" },
        h("div", { className: "quality-drawer-heading" }, provider.name),
        h(
          "div",
          { className: "quality-limits-grid" },
          qualities.map((quality) =>
            h(QualityLimitRow, {
              key: quality.rank, quality,
              providerId: provider.id, providerName: provider.name,
              mode: qualityLimits[`${provider.id}_${quality.rank}`],
              onChange,
            }),
          ),
        ),
      ),
    ),
  );
}

// ═══════════════════════════ App ═══════════════════════════
function App() {
  const [theme, setTheme] = useState(() => localStorage.getItem(LS.theme) || "dark");
  const [sourcesReady, setSourcesReady] = useState(false);

  // Restore the last saved state from this browser (same autosave contract
  // as the reference page's signed-out mode — here it is the ONLY store).
  const savedConfig = (() => {
    try {
      const raw = localStorage.getItem(LS.config);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch { return null; }
  })();

  const [selectedSources, setSelectedSources] = useState(savedConfig?.selectedSources || null);
  const [selectedQualities, setSelectedQualities] = useState(savedConfig?.selectedQualities || initialSelectedQualities);
  const [subtitlesDisabled, setSubtitlesDisabled] = useState(savedConfig?.subtitlesDisabled ?? false);
  const [disableDirect, setDisableDirect] = useState(savedConfig?.disableDirect ?? false);
  const [qualityLimits, setQualityLimits] = useState(savedConfig?.qualityLimits || {});
  const [groupBy, setGroupBy] = useState(savedConfig?.groupBy || "none");
  const [sortBy, setSortBy] = useState(savedConfig?.sortBy || "quality");
  const [providerOrder, setProviderOrder] = useState(Array.isArray(savedConfig?.providerOrder) ? savedConfig.providerOrder : []);
  const [maxTimeout, setMaxTimeout] = useState(savedConfig?.maxTimeout || 15);
  const [minSizeGb, setMinSizeGb] = useState(savedConfig?.minSizeGb ?? "");
  const [maxSizeGb, setMaxSizeGb] = useState(savedConfig?.maxSizeGb ?? "");
  const [formatterName, setFormatterName] = useState(savedConfig?.formatter_name || "");
  const [formatterDescription, setFormatterDescription] = useState(savedConfig?.formatter_description || "");
  const [formatterPreset, setFormatterPreset] = useState(() => detectFormatterPreset(savedConfig?.formatter_name || "", savedConfig?.formatter_description || ""));
  const [formatterPreview, setFormatterPreview] = useState(null);
  const formatterPreviewTimerRef = useRef(null);
  const [formatterJsonOpen, setFormatterJsonOpen] = useState(false);
  const [formatterJsonText, setFormatterJsonText] = useState("");
  const [formatterJsonError, setFormatterJsonError] = useState("");

  const [copyState, setCopyState] = useState("Copy Addon URL");
  const [qualityDrawerOpen, setQualityDrawerOpen] = useState(false);
  const [installModalOpen, setInstallModalOpen] = useState(false);
  const installModalRef = useRef(null);
  const [activeTab, setActiveTab] = useState("overview");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem(LS.sidebar) === "collapsed");
  const [mobileOpen, setMobileOpen] = useState(false);

  // Real-time status for every source (monitor + passive telemetry), 30s poll
  const [statusData, setStatusData] = useState(null);
  const [statusRefreshing, setStatusRefreshing] = useState(false);

  // Local config versions (Account tab) — real snapshots, real links.
  const [localVersions, setLocalVersions] = useState(() => {
    try {
      const raw = localStorage.getItem(LS.versions);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  });
  const [copiedVersion, setCopiedVersion] = useState(null);
  const [versionError, setVersionError] = useState("");

  // ── data loads ──
  useEffect(() => {
    let cancelled = false;
    fetch("/sources.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("registry"))))
      .then((entries) => {
        if (cancelled) return;
        REGISTRY = (Array.isArray(entries) ? entries : []).map((s) => ({
          id: s.id,
          name: s.label || s.id,
          tags: Array.isArray(s.tags) ? s.tags : [],
          animeOnly: Boolean(s.animeOnly),
          contentTypes: Array.isArray(s.contentTypes) ? s.contentTypes : [],
          key: providerKey(s.id),
        }));
        // First visit: everything selected (the addon's fail-open default).
        setSelectedSources((prev) => {
          if (prev) return prev;
          return Object.fromEntries(REGISTRY.map((p) => [p.key, true]));
        });
        setSourcesReady(true);
      })
      .catch(() => { if (!cancelled) setSourcesReady(true); });
    return () => { cancelled = true; };
  }, []);

  const loadStatus = useCallback(async () => {
    setStatusRefreshing(true);
    try {
      const response = await fetch("/api/status", { cache: "no-store" });
      setStatusData(await response.json());
    } catch {
      // keep the last known-good status on the page
    } finally {
      setStatusRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
    const interval = window.setInterval(loadStatus, 30_000);
    return () => window.clearInterval(interval);
  }, [loadStatus]);

  // ── theme ──
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#101114" : "#f4f6fa");
    localStorage.setItem(LS.theme, theme);
  }, [theme]);

  // ── formatter preview (debounced; server renders the real engine) ──
  async function runFormatterPreview(name, description) {
    if (!name.trim() && !description.trim()) {
      setFormatterPreview(null);
      return;
    }
    try {
      const response = await fetch("/api/formatter-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, description }),
      });
      const result = await response.json().catch(() => ({}));
      setFormatterPreview(result.ok ? result : `Error: ${result.error || "preview failed"}`);
    } catch {
      setFormatterPreview("Error: preview failed");
    }
  }
  function scheduleFormatterPreview(overrides) {
    const name = overrides?.name ?? formatterName;
    const description = overrides?.description ?? formatterDescription;
    if (formatterPreviewTimerRef.current) clearTimeout(formatterPreviewTimerRef.current);
    formatterPreviewTimerRef.current = setTimeout(() => runFormatterPreview(name, description), 400);
  }
  useEffect(() => {
    scheduleFormatterPreview();
    return () => { if (formatterPreviewTimerRef.current) clearTimeout(formatterPreviewTimerRef.current); };
  }, [formatterName, formatterDescription]);

  async function handleUseDefaultFormatter() {
    try {
      const response = await fetch("/api/formatter-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "x", description: "x" }),
      });
      const result = await response.json().catch(() => ({}));
      if (result.ok && result.defaults) {
        setFormatterName(result.defaults.name);
        setFormatterDescription(result.defaults.description);
        setFormatterPreset("default");
        scheduleFormatterPreview({ name: result.defaults.name, description: result.defaults.description });
      }
    } catch {}
  }

  function applyFormatterPreset(presetKey) {
    const preset = FORMATTER_PRESETS[presetKey];
    if (!preset) return;
    setFormatterName(preset.name);
    setFormatterDescription(preset.description);
    setFormatterPreset(presetKey);
    scheduleFormatterPreview({ name: preset.name, description: preset.description });
  }

  function applyFormatterJsonImport() {
    try {
      const parsed = JSON.parse(formatterJsonText);
      const name = typeof parsed?.name === "string" ? parsed.name : "";
      const description = typeof parsed?.description === "string" ? parsed.description : "";
      if (!name.trim() && !description.trim()) {
        setFormatterJsonError("That JSON has no usable \"name\" or \"description\" template.");
        return;
      }
      setFormatterName(name);
      setFormatterDescription(description);
      setFormatterPreset(null);
      setFormatterJsonError("");
      setFormatterJsonOpen(false);
      setFormatterJsonText("");
      scheduleFormatterPreview({ name, description });
    } catch {
      setFormatterJsonError("Could not parse that as JSON — paste the whole {\"name\": …, \"description\": …} object.");
    }
  }

  const selectedProviderCount = providers().filter(({ key }) => selectedSources?.[key]).length;
  const selectedQualityCount = qualities.filter(({ key }) => selectedQualities[key]).length;
  const canGenerate = selectedProviderCount > 0 && selectedQualityCount > 0;
  const status = selectedProviderCount === 0
    ? "Select at least one source."
    : selectedQualityCount === 0
      ? "Select at least one quality."
      : "Configuration ready.";

  const parsedMinSizeGb = Number(minSizeGb);
  const parsedMaxSizeGb = Number(maxSizeGb);
  const hasMinSize = minSizeGb !== "" && Number.isFinite(parsedMinSizeGb) && parsedMinSizeGb > 0;
  const hasMaxSize = maxSizeGb !== "" && Number.isFinite(parsedMaxSizeGb) && parsedMaxSizeGb > 0;
  const fileSizeLabel = hasMinSize && hasMaxSize
    ? `${parsedMinSizeGb}–${parsedMaxSizeGb} GB`
    : hasMinSize ? `≥ ${parsedMinSizeGb} GB` : hasMaxSize ? `≤ ${parsedMaxSizeGb} GB` : "Any";
  const activeFilterCount = (hasMinSize ? 1 : 0) + (hasMaxSize ? 1 : 0);

  function buildConfig() {
    const config = {};
    for (const provider of providers()) {
      if (selectedSources?.[provider.key]) config[provider.key] = "on";
    }
    for (const quality of qualities) {
      if (selectedQualities[quality.key]) config[quality.key] = "on";
    }
    if (subtitlesDisabled) config.subtitles_disabled = "on";
    if (disableDirect) config.disable_direct = "on";
    if (minSizeGb !== "" && Number(minSizeGb) > 0) config.min_size_gb = Number(minSizeGb);
    if (maxSizeGb !== "" && Number(maxSizeGb) > 0) config.max_size_gb = Number(maxSizeGb);
    if (groupBy && groupBy !== "none") config.group_by = groupBy;
    if (sortBy && sortBy !== "quality") config.sort_by = sortBy;
    if (Array.isArray(providerOrder) && providerOrder.length > 0) config.provider_order = providerOrder.join(",");
    if (maxTimeout && maxTimeout !== 15) config.max_timeout = maxTimeout;
    if (formatterName && formatterName.trim()) config.formatter_name = formatterName;
    if (formatterDescription && formatterDescription.trim()) config.formatter_description = formatterDescription;
    for (const [limitKey, limit] of Object.entries(qualityLimits)) {
      if (limit > 0 || limit === 0) config[`quality_limit_${limitKey}`] = String(limit);
    }
    return config;
  }

  function saveToLocalStorage() {
    try {
      localStorage.setItem(LS.config, JSON.stringify({
        selectedSources, selectedQualities, subtitlesDisabled, disableDirect,
        qualityLimits, groupBy, sortBy, providerOrder, maxTimeout,
        minSizeGb, maxSizeGb, formatter_name: formatterName, formatter_description: formatterDescription,
      }));
    } catch {}
  }

  // Autosave on every change (once sources are loaded)
  const skipFirstAutosaveRef = useRef(true);
  useEffect(() => {
    if (skipFirstAutosaveRef.current) {
      skipFirstAutosaveRef.current = false;
      return;
    }
    if (!sourcesReady) return;
    saveToLocalStorage();
  }, [selectedSources, selectedQualities, subtitlesDisabled, disableDirect, qualityLimits, groupBy, sortBy, providerOrder, maxTimeout, minSizeGb, maxSizeGb, formatterName, formatterDescription, sourcesReady]);

  // Modal focus trap (identical behavior to the reference page)
  useEffect(() => {
    if (!installModalOpen) return;
    const previouslyFocused = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => installModalRef.current?.focus());
    const handleModalKeyDown = (event) => {
      if (event.key === "Escape") { setInstallModalOpen(false); return; }
      if (event.key !== "Tab" || !installModalRef.current) return;
      const focusable = Array.from(installModalRef.current.querySelectorAll(
        'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ));
      if (focusable.length === 0) { event.preventDefault(); installModalRef.current.focus(); return; }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === installModalRef.current)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", handleModalKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleModalKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, [installModalOpen]);

  function toggleSource(key) {
    setSelectedSources((value) => ({ ...value, [key]: !value[key] }));
  }
  function applyPreset(ids) {
    const next = {};
    for (const provider of providers()) next[provider.key] = ids.includes(provider.id);
    setSelectedSources(next);
  }
  function isPresetActive(preset) {
    return providers().every(({ id, key }) => Boolean(selectedSources?.[key]) === preset.ids.includes(id));
  }
  function clearAll() {
    const noSources = {};
    for (const provider of providers()) noSources[provider.key] = false;
    const noQualities = {};
    for (const quality of qualities) noQualities[quality.key] = false;
    setSelectedSources(noSources);
    setSelectedQualities(noQualities);
    setGroupBy("none");
    setSortBy("quality");
    setProviderOrder([]);
    setQualityLimits({});
  }
  function handleQualityLimitChange(limitKey, limit) {
    setQualityLimits((prev) => {
      if (limit === "") {
        const next = { ...prev };
        delete next[limitKey];
        return next;
      }
      return { ...prev, [limitKey]: limit };
    });
  }

  const selectedProvidersList = providers().filter(({ key }) => selectedSources?.[key]);

  // Provider display order: the user's explicit ordering first, then any
  // selected provider they never ranked, in registry order (/sources.json).
  const registryOrder = providers().map((p) => p.id);
  const defaultProviderOrder = (() => {
    const list = selectedProvidersList.slice();
    if (!registryOrder.length) return list;
    const rank = new Map(registryOrder.map((id, index) => [id, index]));
    const fallback = 1000000;
    return list.sort((a, b) =>
      (rank.has(a.id) ? rank.get(a.id) : fallback) - (rank.has(b.id) ? rank.get(b.id) : fallback));
  })();
  const orderedProviders = (() => {
    const inOrder = providerOrder
      .map((id) => defaultProviderOrder.find((provider) => provider.id === id))
      .filter(Boolean);
    const rest = defaultProviderOrder.filter((provider) => !providerOrder.includes(provider.id));
    return [...inOrder, ...rest];
  })();

  function moveProviderOrder(id, delta) {
    setProviderOrder((prev) => {
      const ids = defaultProviderOrder.map((provider) => provider.id);
      const ranked = prev.filter((entry) => ids.includes(entry));
      const current = [...ranked, ...ids.filter((entry) => !ranked.includes(entry))];
      const from = current.indexOf(id);
      const to = from + delta;
      if (from === -1 || to < 0 || to >= current.length) return prev;
      const next = current.slice();
      next.splice(from, 1);
      next.splice(to, 0, id);
      return next;
    });
  }

  // ── install / copy ──
  async function installAddon() {
    if (!canGenerate) return;
    saveToLocalStorage();
    const config = buildConfig();
    window.location.href = `stremio://${window.location.host}${await manifestPath(config)}`;
  }

  async function copyAddonUrl() {
    if (!canGenerate) return;
    saveToLocalStorage();
    const config = buildConfig();
    const urlPromise = manifestPath(config).then((path) => new URL(path, window.location.origin).href);
    copyUrlWhenReady(urlPromise)
      .then(() => setCopyState("Copied"))
      .catch(() => setCopyState("Copy failed. Long press to select"))
      .finally(() => window.setTimeout(() => setCopyState("Copy Addon URL"), 1600));
  }

  // ── local config versions ──
  function persistVersions(list) {
    setLocalVersions(list);
    try { localStorage.setItem(LS.versions, JSON.stringify(list)); } catch {}
  }
  function saveCurrentAsVersion() {
    setVersionError("");
    const config = buildConfig();
    const n = localVersions.length + 1;
    const version = {
      id: `v${Date.now().toString(36)}`,
      label: `v${n}`,
      createdAt: new Date().toISOString(),
      config,
    };
    persistVersions([...localVersions, version]);
  }
  function installVersionLink(id) {
    setVersionError("");
    const version = localVersions.find((v) => v.id === id);
    if (!version) { setVersionError("Could not build that version's link."); return; }
    manifestPath(version.config).then((path) => {
      window.location.href = `stremio://${window.location.host}${path}`;
    }).catch(() => setVersionError("Could not build that version's link."));
  }
  async function copyVersionLink(id) {
    setVersionError("");
    const version = localVersions.find((v) => v.id === id);
    if (!version) { setVersionError("Could not build that version's link."); return; }
    try {
      const path = await manifestPath(version.config);
      const url = new URL(path, window.location.origin).href;
      try { await navigator.clipboard.writeText(url); } catch { legacyCopy(url); }
      setCopiedVersion(id);
      window.setTimeout(() => setCopiedVersion((current) => (current === id ? null : current)), 1600);
    } catch {
      setVersionError("Could not build that version's link.");
    }
  }
  // Activate = load the snapshot back into the live UI (and autosave it).
  function activateVersion(id) {
    setVersionError("");
    const version = localVersions.find((v) => v.id === id);
    if (!version || !version.config) { setVersionError("That version is gone."); return; }
    applyServerConfig(version.config);
  }
  function deleteVersion(id) {
    setVersionError("");
    persistVersions(localVersions.filter((v) => v.id !== id));
  }

  // Apply a flat config map (a saved version) back into UI state — the local
  // equivalent of the reference page's server-config restore.
  function applyServerConfig(config) {
    if (!config || typeof config !== "object") return;
    const sources = {};
    for (const provider of providers()) {
      sources[provider.key] = config[provider.key] === "on" || config[provider.key] === true;
    }
    setSelectedSources(sources);
    const selectedQualitiesObj = {};
    for (const quality of qualities) {
      selectedQualitiesObj[quality.key] = config[quality.key] === "on" || config[quality.key] === true;
    }
    setSelectedQualities(selectedQualitiesObj);
    setSubtitlesDisabled(config.subtitles_disabled === "on" || config.subtitles_disabled === true);
    setDisableDirect(config.disable_direct === "on" || config.disable_direct === true);
    setGroupBy(config.group_by || "none");
    setSortBy(config.sort_by || "quality");
    setProviderOrder(
      typeof config.provider_order === "string" && config.provider_order.trim()
        ? config.provider_order.split(",").map((id) => id.trim()).filter(Boolean)
        : []
    );
    setMaxTimeout(config.max_timeout || 15);
    setMinSizeGb(config.min_size_gb != null && config.min_size_gb !== "" ? String(config.min_size_gb) : "");
    setMaxSizeGb(config.max_size_gb != null && config.max_size_gb !== "" ? String(config.max_size_gb) : "");
    setFormatterName(config.formatter_name || "");
    setFormatterDescription(config.formatter_description || "");
    setFormatterPreset(detectFormatterPreset(config.formatter_name || "", config.formatter_description || ""));
    const limits = {};
    for (const [key, value] of Object.entries(config)) {
      if (key.startsWith("quality_limit_")) {
        const providerId = key.slice("quality_limit_".length);
        limits[providerId] = Number(value);
      }
    }
    setQualityLimits(limits);
  }

  const statusById = useMemo(() => {
    const map = {};
    for (const [id, p] of Object.entries(statusData?.providers || {})) map[id] = p;
    return map;
  }, [statusData]);

  const tabs = [
    { id: "overview", label: "Overview", icon: LayoutDashboard, badge: null },
    { id: "sources", label: "Sources", icon: Film, badge: String(selectedProviderCount) },
    { id: "filtering", label: "Filtering", icon: FilterIcon, badge: activeFilterCount || null },
    { id: "playback", label: "Playback", icon: SlidersHorizontal, badge: null },
    { id: "status", label: "Status", icon: Gauge, badge: null },
    { id: "account", label: "Account", icon: Settings2, badge: localVersions.length ? String(localVersions.length) : null },
  ];

  const textareaStyle = {
    width: "100%",
    boxSizing: "border-box",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "0.8rem",
    lineHeight: 1.5,
    padding: "10px",
    borderRadius: "8px",
    border: "1px solid var(--line)",
    background: "var(--surface)",
    color: "var(--text)",
    resize: "vertical",
  };

  // ── loading gate (sources registry) ──
  if (!sourcesReady || !selectedSources) {
    return h("div", { style: { minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--bg)", color: "var(--muted)", gap: "12px" } },
      h("div", { style: { width: "36px", height: "36px", border: "3px solid var(--line)", borderTopColor: "var(--accent)", borderRadius: "999px", animation: "spin 0.7s linear infinite" } }),
      h("span", { style: { fontSize: "0.88rem", fontWeight: 600 } }, "Loading sources…"),
      h("style", null, "@keyframes spin{to{transform:rotate(360deg)}}"),
    );
  }

  const subtitleFor = (tabId) => tabId === "overview" ? "Install status & your settings"
    : tabId === "sources" ? `${selectedProviderCount} sources · ${selectedQualityCount} qualities`
    : tabId === "filtering" ? "Filesize bounds & stream filters"
    : tabId === "playback" ? "Subtitles, grouping & timeouts"
    : tabId === "status" ? "Provider health"
    : "Local versions & session";

  return h("div", { className: `app-layout${sidebarCollapsed ? " is-collapsed" : ""}` },
    // ── sidebar ──
    h("aside", { className: `sidebar${mobileOpen ? " is-open" : ""}` },
      h("div", { className: "sidebar-head" },
        h("a", { className: "sidebar-brand", href: "/" },
          h("img", { src: ICON, alt: "" }),
          h("span", { className: "sidebar-brand-text" },
            h("span", { className: "brand-name" }, "PhoeniX"),
            h("span", { className: "brand-subtitle" }, "Source control"),
          ),
        ),
        h("button", { className: "collapse-btn", onClick: () => { if (window.innerWidth <= 980) { setMobileOpen((v) => !v); } else { setSidebarCollapsed((v) => !v); localStorage.setItem(LS.sidebar, !sidebarCollapsed ? "collapsed" : "expanded"); } }, "aria-label": sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar", title: sidebarCollapsed ? "Expand" : "Collapse" },
          h(Menu, { size: 16 }),
        ),
      ),
      h("nav", { className: "sidebar-nav", "aria-label": "Dashboard sections" },
        h("div", { className: "nav-label" }, "Configure"),
        tabs.map((tab) => h("button", {
          key: tab.id, className: `nav-item${activeTab === tab.id ? " is-active" : ""}`,
          onClick: () => { setActiveTab(tab.id); setMobileOpen(false); },
          "aria-current": activeTab === tab.id ? "page" : undefined,
          title: sidebarCollapsed ? tab.label : undefined,
        },
          h(tab.icon, { size: 18, strokeWidth: 2 }),
          h("span", null, tab.label),
          tab.badge ? h("span", { className: "nav-badge" }, tab.badge) : null,
        )),
      ),
      h("div", { className: "sidebar-foot" },
        h("div", { className: "account-chip", style: { borderStyle: "dashed" } },
          h("span", { className: "account-avatar", style: { background: "var(--surface-3)", color: "var(--subtle)" } }, h(Settings2, { size: 16 })),
          h("div", { className: "account-meta" },
            h("span", { className: "account-name" }, "Local config"),
            h("span", { className: "account-sub" }, "Saved in this browser"),
          ),
        ),
      ),
    ),
    h("div", { className: `drawer-backdrop${mobileOpen ? " is-open" : ""}`, onClick: () => setMobileOpen(false), "aria-hidden": "true" }),

    // ── main column ──
    h("div", { className: "main-col" },
      h("header", { className: "topbar" },
        h("div", { className: "topbar-left" },
          h("button", { className: "topbar-hamburger", onClick: () => setMobileOpen((v) => !v), "aria-label": "Toggle navigation", "aria-expanded": mobileOpen },
            h(Menu, { size: 18 }),
          ),
          h("div", { className: "topbar-title" },
            h("h1", null, tabs.find((t) => t.id === activeTab)?.label || "Overview"),
            h("p", null, subtitleFor(activeTab)),
          ),
        ),
        h("div", { className: "top-actions" },
          IconButton({ label: theme === "dark" ? "Use light mode" : "Use dark mode", onClick: () => setTheme(theme === "dark" ? "light" : "dark"), children: theme === "dark" ? h(Sun, { size: 18 }) : h(Moon, { size: 18 }) }),
          IconButton({ label: "Refresh status", onClick: loadStatus, spinning: statusRefreshing, disabled: statusRefreshing, children: h(Zap, { size: 17 }) }),
        ),
      ),
      h("div", { className: "content" },

        activeTab === "overview" ? h("div", null,
          h("div", { className: "kpi-grid" },
            h("div", { className: "kpi-card" }, h("span", { className: "kpi-label" }, "Sources"), h("span", { className: "kpi-value" }, String(selectedProviderCount)), h("span", { className: "kpi-hint" }, `${providers().length} available`)),
            h("div", { className: "kpi-card" }, h("span", { className: "kpi-label" }, "Qualities"), h("span", { className: "kpi-value" }, String(selectedQualityCount)), h("span", { className: "kpi-hint" }, "4K → 360p")),
            h("div", { className: "kpi-card" }, h("span", { className: "kpi-label" }, "Live sources"), h("span", { className: "kpi-value", style: { fontSize: "1rem", color: "var(--success)" } }, statusData ? `${Object.values(statusData.providers || {}).filter((p) => p.status === "up").length}/${providers().length}` : "…"), h("span", { className: "kpi-hint" }, "Real-time monitor")),
          ),
          h("div", { className: "overview-grid", style: { gridTemplateColumns: "1fr" } },
            h("div", { className: "stack" },
              h("section", { className: "section" },
                h("div", { className: "summary-title" }, h(Play, { size: 14 }), "Install PhoeniX"),
                h("p", { className: status === "Configuration ready." ? "status-line" : "status-line is-warning", style: { marginTop: 0 } }, status),
                h("div", { className: "action-row" },
                  h("button", { className: "button primary", type: "button", disabled: !canGenerate, onClick: () => setInstallModalOpen(true) }, h(Play, { size: 17, fill: "currentColor" }), "Install PhoeniX"),
                  h("div", { style: { display: "flex", gap: "8px" } },
                    h("button", { className: "button", type: "button", disabled: !canGenerate, onClick: copyAddonUrl, style: { flex: 1 } }, h(Clipboard, { size: 16 }), copyState),
                    h("button", { className: "button ghost", type: "button", onClick: clearAll, title: "Clear all selections" }, "Clear"),
                  ),
                ),
                h("p", { style: { margin: "10px 0 0", color: "var(--subtle)", fontSize: "0.78rem", lineHeight: 1.5 } },
                  "Your settings autosave in this browser and ride inside the install URL — reinstalling with a new selection replaces the old one."),
              ),
              h("section", { className: "section" },
                h("div", { className: "section-header" }, h("h3", { className: "section-title" }, h(SlidersHorizontal, { size: 14 }), "Quick stats")),
                h("div", { style: { display: "grid", gap: "8px", fontSize: "0.88rem", color: "var(--muted)" } },
                  h("div", { style: { display: "flex", justifyContent: "space-between" } }, h("span", null, "Grouping"), h("strong", { style: { color: "var(--text)" } }, groupBy === "none" ? "Off" : groupBy)),
                  h("div", { style: { display: "flex", justifyContent: "space-between" } }, h("span", null, "Timeout"), h("strong", { style: { color: "var(--text)" } }, `${maxTimeout}s`)),
                  h("div", { style: { display: "flex", justifyContent: "space-between" } }, h("span", null, "Subtitles"), h("strong", { style: { color: "var(--text)" } }, subtitlesDisabled ? "Hidden" : "Shown")),
                  h("div", { style: { display: "flex", justifyContent: "space-between" } }, h("span", null, "Non-seekable Files"), h("strong", { style: { color: "var(--text)" } }, disableDirect ? "Filtered" : "Allowed")),
                  h("div", { style: { display: "flex", justifyContent: "space-between" } }, h("span", null, "File size"), h("strong", { style: { color: "var(--text)" } }, fileSizeLabel)),
                ),
              ),
            ),
          ),
        ) : null,

        activeTab === "sources" ? h("div", null,
          h("div", { className: "tab-head" },
            h("div", null, h("h2", null, "Sources"), h("p", { style: { whiteSpace: "nowrap" } }, "Select providers and resolutions. The dot on each card is its live status.")),
            h("div", { className: "tab-actions" }, h("button", { className: "clear-button", onClick: clearAll }, "Clear all")),
          ),
          h("section", { className: "section" },
            h("div", { className: "section-header" },
              h("h3", { className: "section-title" }, h(MonitorPlay, { size: 14 }), "Providers"),
              h("span", { className: "section-meta" }, `${selectedProviderCount} selected`),
            ),
            h("div", { className: "preset-bar" },
              presets().map((preset) => h("button", { key: preset.id, className: `preset-chip${isPresetActive(preset) ? " is-active" : ""}`, onClick: () => applyPreset(preset.ids) }, preset.label)),
            ),
            h("div", { className: "provider-grid" },
              providers().map((provider) => h(ProviderCard, {
                key: provider.key, provider,
                selected: Boolean(selectedSources[provider.key]),
                status: statusById[provider.id]?.status,
                onToggle: () => toggleSource(provider.key),
              })),
            ),
            h("div", { style: { marginTop: "12px", color: "var(--subtle)", fontSize: "0.78rem" } }, "Tip: pick 4–7 sources for best speed vs coverage. Add more if you watch regional or anime."),
          ),
          h("section", { className: "section", style: { marginTop: "16px" } },
            h("div", { className: "section-header" },
              h("h3", { className: "section-title" }, h(Gauge, { size: 14 }), "Resolutions"),
              h("button", { className: "clear-button", type: "button", onClick: () => { const noQ = {}; for (const q of qualities) noQ[q.key] = false; setSelectedQualities(noQ); } }, "Clear"),
            ),
            h("div", { className: "provider-grid", style: { gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" } },
              qualities.map((quality) => h(QualityOption, { key: quality.key, quality, selected: Boolean(selectedQualities[quality.key]), onToggle: () => setSelectedQualities((v) => ({ ...v, [quality.key]: !v[quality.key] })) })),
            ),
            selectedProvidersList.length ? h(React.Fragment, null,
              h("button", { className: "quality-drawer-toggle", onClick: () => setQualityDrawerOpen((v) => !v) },
                qualityDrawerOpen ? "Hide per-source caps" : "Per-source caps",
                h(ChevronDown, { size: 14, style: { transform: qualityDrawerOpen ? "rotate(180deg)" : "none", transition: "transform 160ms var(--ease)" } }),
                qualityDrawerOpen && Object.keys(qualityLimits).length ? h("span", { className: "count" }, "\u00b7 " + String(Object.keys(qualityLimits).length) + " set") : null,
              ),
              h(QualityDrawer, { open: qualityDrawerOpen, providers: selectedProvidersList, qualityLimits, onChange: handleQualityLimitChange }),
            ) : h("p", { style: { marginTop: "12px", color: "var(--subtle)", fontSize: "0.84rem" } }, "Select at least one source to set per-source caps."),
          ),
        ) : null,

        activeTab === "filtering" ? h("div", null,
          h("div", { className: "tab-head" },
            h("div", null, h("h2", null, "Filtering"), h("p", { style: { whiteSpace: "nowrap" } }, "Drop streams you never want to see.")),
          ),
          h("div", { className: "overview-grid" },
            h("div", { className: "stack" },
              h("section", { className: "section" },
                h("div", { className: "section-header" }, h("h3", { className: "section-title" }, h(FilterIcon, { size: 14 }), "File size")),
                h("div", { className: "option-block" },
                  h("span", { className: "option-label" }, "Keep streams between", h("span", { className: "help-icon", "data-tooltip": "Hides streams whose reported file size falls outside this range. Streams without a known size are always shown." }, "?")),
                  h("div", { className: "size-fields" },
                    h("div", { className: "size-field" },
                      h("label", { htmlFor: "min-size-gb" }, "Min (GB)"),
                      h("input", { id: "min-size-gb", type: "number", min: "0", step: "any", inputMode: "decimal", placeholder: "No minimum", value: minSizeGb, onChange: (e) => setMinSizeGb(e.target.value) }),
                    ),
                    h("div", { className: "size-field" },
                      h("label", { htmlFor: "max-size-gb" }, "Max (GB)"),
                      h("input", { id: "max-size-gb", type: "number", min: "0", step: "any", inputMode: "decimal", placeholder: "No maximum", value: maxSizeGb, onChange: (e) => setMaxSizeGb(e.target.value) }),
                    ),
                  ),
                ),
              ),
              h("section", { className: "section" },
                h("div", { className: "section-header" }, h("h3", { className: "section-title" }, h(Zap, { size: 14 }), "Seekability")),
                h("label", { className: "option-row" },
                  h("span", { className: "option-label" }, "Filter non-seekable files", h("span", { className: "help-icon", "data-tooltip": "Hides streams that open a web page instead of playing inline — a player cannot seek inside those." }, "?")),
                  h("button", { type: "button", role: "switch", "aria-checked": disableDirect, className: `switch${disableDirect ? " is-on" : ""}`, onClick: () => setDisableDirect((v) => !v) }),
                ),
                h("p", { style: { margin: "0", color: "var(--subtle)", fontSize: "0.78rem", lineHeight: 1.5 } }, "Hides external player-page streams — you won't be able to scrub or seek inside them."),
              ),
            ),
            h("div", { className: "stack" },
              h("section", { className: "section" },
                h("div", { className: "section-header" }, h("h3", { className: "section-title" }, h(Gauge, { size: 14 }), "Active filters")),
                h("div", { style: { display: "grid", gap: "8px", fontSize: "0.86rem" } },
                  h("div", { style: { display: "flex", justifyContent: "space-between" } }, h("span", { style: { color: "var(--muted)" } }, "File size"), h("strong", { style: { color: "var(--text)" } }, fileSizeLabel)),
                  h("div", { style: { display: "flex", justifyContent: "space-between" } }, h("span", { style: { color: "var(--muted)" } }, "Non-seekable files"), h("strong", { style: { color: "var(--text)" } }, disableDirect ? "Hidden" : "Allowed")),
                ),
              ),
            ),
          ),
        ) : null,

        activeTab === "playback" ? h("div", null,
          h("div", { className: "tab-head" },
            h("div", null, h("h2", null, "Playback"), h("p", { style: { whiteSpace: "nowrap" } }, "Subtitles, grouping and timeout settings for playback.")),
          ),
          h("div", { className: "overview-grid" },
            h("div", { className: "stack" },
              h("section", { className: "section" },
                h("div", { className: "section-header" }, h("h3", { className: "section-title" }, h(SlidersHorizontal, { size: 14 }), "Preferences")),
                h("div", { className: "options-block" },
                  h("label", { className: "option-row" },
                    h("span", { className: "option-label" }, "Hide subtitles", h("span", { className: "help-icon", "data-tooltip": "Removes the subtitles resource from the manifest and strips subtitle tracks from every stream." }, "?")),
                    h("button", { type: "button", role: "switch", "aria-checked": subtitlesDisabled, className: `switch${subtitlesDisabled ? " is-on" : ""}`, onClick: () => setSubtitlesDisabled((v) => !v) }),
                  ),
                ),
                h("div", { className: "option-block" },
                  h("span", { className: "option-label" }, "Group streams by", h("span", { className: "help-icon", "data-tooltip": "Cluster mirrors in Stremio's player: by Provider (one group per source) or by Quality (one group per resolution). Default keeps each provider's own grouping." }, "?")),
                  h("div", { className: "segmented", role: "group", "aria-label": "Group streams by" },
                    [{ value: "none", label: "Default" }, { value: "provider", label: "Provider" }, { value: "quality", label: "Quality" }].map((opt) => h("button", { type: "button", key: opt.value, className: `segmented-btn${groupBy === opt.value ? " is-active" : ""}`, "aria-pressed": groupBy === opt.value, onClick: () => setGroupBy(opt.value) }, opt.label)),
                  ),
                ),
                h("div", { className: "option-block" },
                  h("span", { className: "option-label" }, "Sort streams", h("span", { className: "help-icon", "data-tooltip": "Resolutions always stay grouped (4K first, then 1080p, …). Default keeps the per-provider arrival order inside each group; Size puts the biggest files first inside each group." }, "?")),
                  h("div", { className: "segmented", role: "group", "aria-label": "Sort streams" },
                    [{ value: "quality", label: "Default" }, { value: "size", label: "Size" }].map((opt) => h("button", { type: "button", key: opt.value, className: `segmented-btn${sortBy === opt.value ? " is-active" : ""}`, "aria-pressed": sortBy === opt.value, onClick: () => setSortBy(opt.value) }, opt.label)),
                  ),
                ),
                h("div", { className: "option-block" },
                  h("span", { className: "option-label" }, "Load timeout", h("span", { className: "help-icon", "data-tooltip": "Maximum time to wait for sources. When the timeout is reached, results collected so far are returned. Nothing is discarded." }, "?")),
                  h("div", { className: "segmented", role: "group", "aria-label": "Load timeout" },
                    timeoutOptions.map((opt) => h("button", { type: "button", key: opt.value, className: `segmented-btn${maxTimeout === opt.value ? " is-active" : ""}`, "aria-pressed": maxTimeout === opt.value, onClick: () => setMaxTimeout(opt.value) }, opt.label)),
                  ),
                ),
              ),
              h("section", { className: "section", style: { marginTop: "16px" } },
                h("div", { className: "section-header" },
                  h("h3", { className: "section-title" }, h(SlidersHorizontal, { size: 14 }), "Provider order"),
                  providerOrder.length ? h("button", { className: "clear-button", type: "button", onClick: () => setProviderOrder([]) }, "Reset to default") : null,
                ),
                h("p", { style: { margin: "0 0 10px", color: "var(--subtle)", fontSize: "0.82rem" } }, "Within each resolution, providers appear in this order. All 4K first, then 1080p, and so on. The ranking only decides who goes first inside a group."),
                orderedProviders.length >= 2
                  ? h("div", { style: { display: "grid", gap: "6px" } },
                      orderedProviders.map((provider, index) =>
                        h("div", { key: provider.id, style: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 10px", border: "1px solid var(--line)", borderRadius: "8px" } },
                          h("span", { style: { fontSize: "0.86rem", color: "var(--text)" } }, `${index + 1}. ${provider.name}`),
                          h("span", { style: { display: "flex", gap: "4px" } },
                            h("button", { type: "button", className: "clear-button", "aria-label": `Move ${provider.name} up`, disabled: index === 0, style: { opacity: index === 0 ? 0.4 : 1 }, onClick: () => moveProviderOrder(provider.id, -1) }, "↑"),
                            h("button", { type: "button", className: "clear-button", "aria-label": `Move ${provider.name} down`, disabled: index === orderedProviders.length - 1, style: { opacity: index === orderedProviders.length - 1 ? 0.4 : 1 }, onClick: () => moveProviderOrder(provider.id, 1) }, "↓"),
                          ),
                        ),
                      ),
                    )
                  : h("p", { style: { color: "var(--subtle)", fontSize: "0.84rem" } }, "Select at least two sources to reorder them."),
              ),
              h("section", { className: "section", style: { marginTop: "16px" } },
                h("div", { className: "section-header" },
                  h("h3", { className: "section-title" }, h(SlidersHorizontal, { size: 14 }), "Custom formatter"),
                  h("div", { style: { display: "flex", gap: "8px", alignItems: "center" } },
                    h("button", { className: "clear-button", type: "button", onClick: () => { setFormatterJsonOpen((v) => !v); setFormatterJsonError(""); } }, "Import JSON"),
                    h("button", { className: "clear-button", type: "button", onClick: () => { setFormatterName(""); setFormatterDescription(""); setFormatterPreset(null); setFormatterPreview(null); } }, "Clear"),
                  ),
                ),
                formatterJsonOpen
                  ? h("div", { style: { marginTop: "10px" } },
                      h("textarea", { value: formatterJsonText, onChange: (e) => { setFormatterJsonText(e.target.value); setFormatterJsonError(""); }, rows: 4, spellCheck: false, placeholder: 'Paste a shared formatter, e.g. {"name": "…", "description": "…"}', style: textareaStyle }),
                      formatterJsonError ? h("p", { style: { margin: "6px 0 0", color: "var(--danger)", fontSize: "0.78rem" } }, formatterJsonError) : null,
                      h("div", { style: { display: "flex", gap: "8px", marginTop: "8px" } },
                        h("button", { type: "button", className: "preset-chip", onClick: applyFormatterJsonImport }, "Apply"),
                        h("button", { type: "button", className: "clear-button", onClick: () => { setFormatterJsonOpen(false); setFormatterJsonText(""); setFormatterJsonError(""); } }, "Cancel"),
                      ),
                    )
                  : null,
                h("div", { className: "preset-bar", role: "group", "aria-label": "Formatter template" },
                  h("button", { type: "button", className: `preset-chip${formatterPreset === "default" ? " is-active" : ""}`, onClick: handleUseDefaultFormatter }, "Default"),
                  Object.entries(FORMATTER_PRESETS).map(([presetKey, preset]) => h("button", { key: presetKey, type: "button", className: `preset-chip${formatterPreset === presetKey ? " is-active" : ""}`, onClick: () => applyFormatterPreset(presetKey) }, preset.label)),
                ),
                h("label", { style: { display: "block", fontSize: "0.8rem", color: "var(--muted)", margin: "10px 0 4px" } }, "Name template"),
                h("textarea", { value: formatterName, onChange: (e) => { setFormatterName(e.target.value); setFormatterPreset(null); setFormatterPreview(null); }, rows: 4, spellCheck: false, placeholder: "{stream.resolution} • {stream.source}", style: textareaStyle }),
                h("label", { style: { display: "block", fontSize: "0.8rem", color: "var(--muted)", margin: "10px 0 4px" } }, "Description template"),
                h("textarea", { value: formatterDescription, onChange: (e) => { setFormatterDescription(e.target.value); setFormatterPreset(null); setFormatterPreview(null); }, rows: 4, spellCheck: false, placeholder: "{stream.title} • {stream.size::bytes} • {addon.name}", style: textareaStyle }),
                h("p", { style: { margin: "10px 0 0", color: "var(--subtle)", fontSize: "0.78rem" } },
                  "Template syntax over this addon's real stream fields: resolution, size, source, server, languages, title, type, addon.name. Leave empty for the default look. Shared badge packs that come as one {\"name\": …, \"description\": …} JSON object go through Import JSON above."),
                formatterPreview != null && typeof formatterPreview === "object" && formatterPreview.ok && Array.isArray(formatterPreview.samples)
                  ? h("div", { className: "formatter-preview" },
                      formatterPreview.samples.map((sample) =>
                        h("div", { key: sample.label, className: "stream-card" },
                          h("div", { className: "stream-card-head" },
                            h("span", { className: "stream-card-badge" }, sample.label),
                            sample.error ? h("span", { className: "stream-card-error" }, sample.error) : null,
                          ),
                          sample.name ? h("div", { className: "stream-card-name" }, sample.name) : null,
                          sample.description ? h("div", { className: "stream-card-desc" }, sample.description) : null,
                        ),
                      ),
                    )
                  : typeof formatterPreview === "string"
                    ? h("p", { style: { margin: "10px 0 0", color: "var(--danger)", fontSize: "0.78rem" } }, formatterPreview)
                    : null,
              ),
            ),
            h("div", { className: "stack" },
              h("section", { className: "section" },
                h("div", { className: "section-header" }, h("h3", { className: "section-title" }, h(Gauge, { size: 14 }), "Status")),
                h("p", { className: status === "Configuration ready." ? "status-line" : "status-line is-warning", style: { marginTop: 0 } }, status),
                h("div", { style: { display: "grid", gap: "8px" } },
                  h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "0.86rem" } }, h("span", { style: { color: "var(--muted)" } }, "Providers"), h("strong", null, `${selectedProviderCount} / ${providers().length}`)),
                  h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: "0.86rem" } }, h("span", { style: { color: "var(--muted)" } }, "Resolutions"), h("strong", null, `${selectedQualityCount} / ${qualities.length}`)),
                ),
              ),
            ),
          ),
        ) : null,

        activeTab === "status" ? h("div", null,
          h("div", { className: "tab-head" },
            h("div", null, h("h2", null, "Status"), h("p", { style: { whiteSpace: "nowrap" } }, "Live provider health and uptime.")),
            h("div", { className: "tab-actions" }, h("a", { className: "button ghost", href: "/status", target: "_blank", rel: "noopener noreferrer" }, "Open full page")),
          ),
          h("div", { style: { borderRadius: "12px", overflow: "hidden", border: "1px solid var(--line)", background: "var(--surface)" } },
            h("iframe", { src: "/status", title: "PhoeniX status", style: { width: "100%", height: "72vh", minHeight: "480px", border: "none", display: "block", background: "var(--surface)" }, loading: "lazy" }),
          ),
        ) : null,

        activeTab === "account" ? h("div", null,
          h("div", { className: "tab-head" },
            h("div", null, h("h2", null, "Account"), h("p", { style: { whiteSpace: "nowrap" } }, "Your config lives in this browser — no account needed.")),
          ),
          h("div", { className: "overview-grid" },
            h("section", { className: "section" },
              h("div", { className: "section-header" }, h("h3", { className: "section-title" }, h(Settings2, { size: 14 }), "Config versions")),
              h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" } },
                h("strong", { style: { fontSize: "0.92rem" } }, "Snapshots"),
                h("button", { className: "clear-button", type: "button", onClick: saveCurrentAsVersion }, "Save current as new"),
              ),
              h("p", { style: { margin: "0 0 10px", color: "var(--subtle)", fontSize: "0.78rem", lineHeight: 1.5 } }, "Each version is a full snapshot with its own install link. Activating a version loads it back into the page; installing it applies it to your player."),
              versionError ? h("div", { className: "auth-error", role: "alert" }, versionError) : null,
              localVersions.length === 0
                ? h("p", { style: { margin: 0, color: "var(--subtle)", fontSize: "0.82rem" } }, "No saved versions yet.")
                : localVersions.slice().reverse().map((version) =>
                    h("div", { key: version.id, style: { display: "grid", gap: "8px", padding: "10px 12px", borderRadius: "10px", border: "1px solid var(--line)", background: "var(--surface-2)", marginBottom: "8px" } },
                      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" } },
                        h("strong", { style: { fontSize: "0.88rem" } }, version.label),
                        h("span", { style: { fontSize: "0.72rem", color: "var(--muted)" } }, version.createdAt ? new Date(version.createdAt).toLocaleDateString() : ""),
                      ),
                      h("div", { style: { display: "flex", flexWrap: "wrap", gap: "6px" } },
                        h("button", { className: "clear-button", type: "button", onClick: () => copyVersionLink(version.id) }, copiedVersion === version.id ? "Copied ✓" : "Copy link"),
                        h("button", { className: "clear-button", type: "button", onClick: () => installVersionLink(version.id) }, "Install"),
                        h("button", { className: "clear-button", type: "button", onClick: () => activateVersion(version.id) }, "Activate"),
                        h("button", { className: "clear-button", type: "button", style: { color: "var(--danger)" }, onClick: () => deleteVersion(version.id) }, "Delete"),
                      ),
                    ),
                  ),
            ),
            h("section", { className: "section" },
              h("div", { className: "section-header" }, h("h3", { className: "section-title" }, h(Gauge, { size: 14 }), "Session")),
              h("div", { style: { display: "grid", gap: "8px", fontSize: "0.88rem", color: "var(--muted)" } },
                h("div", { style: { display: "flex", justifyContent: "space-between" } }, h("span", null, "Status"), h("strong", { style: { color: "var(--text)" } }, "Local")),
                h("div", { style: { display: "flex", justifyContent: "space-between" } }, h("span", null, "Sync"), h("strong", { style: { color: "var(--text)" } }, "Browser autosave")),
                h("div", { style: { display: "flex", justifyContent: "space-between" } }, h("span", null, "Storage"), h("strong", { style: { color: "var(--text)" } }, "This browser")),
              ),
              h("p", { style: { margin: "12px 0 0", color: "var(--subtle)", fontSize: "0.78rem", lineHeight: 1.5 } }, "Nothing about you or your settings leaves this page — the config rides inside the install URL you generate."),
            ),
          ),
        ) : null,

        installModalOpen ? h("div", { className: "install-modal-backdrop", onMouseDown: (event) => { if (event.target === event.currentTarget) setInstallModalOpen(false); } },
          h("section", { ref: installModalRef, className: "install-modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "install-modal-title", tabIndex: -1 },
            h("div", { className: "install-modal-header" },
              h("h2", { id: "install-modal-title", className: "install-modal-title" }, "Install PhoeniX"),
              h("button", { className: "button ghost install-modal-close", type: "button", onClick: () => setInstallModalOpen(false) }, "Close"),
            ),
            h("div", { className: "install-modal-state" },
              h("h3", null, "Your personal addon URL"),
              h("p", { className: "install-modal-copy" }, "This URL carries every setting you chose. Open it on any device to reinstall the exact same configuration."),
            ),
            h("div", { style: { display: "grid", gap: "10px" } },
              h("div", { className: "install-url-box", id: "install-url-box" }, `${window.location.origin}${manifestPathSyncHint()}`),
              h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
                h("button", { className: "button primary", type: "button", onClick: installAddon }, h(Play, { size: 16, fill: "currentColor" }), "Install in Stremio"),
                h("button", { className: "button", type: "button", onClick: copyAddonUrl, style: { flex: 1 } }, h(Clipboard, { size: 16 }), copyState),
              ),
              h("p", { className: "install-modal-copy", style: { margin: 0 } }, "Installing again with different settings replaces the previous configuration — no uninstall needed."),
            ),
          ),
        ) : null,
      ),
    ),
  );
}

// The modal shows a readable placeholder URL immediately (the compressed
// segment is built asynchronously at click time — see installAddon/copyAddonUrl).
function manifestPathSyncHint() {
  return "/<your-configuration>/manifest.json";
}

createRoot(document.getElementById("root")).render(h(App));
