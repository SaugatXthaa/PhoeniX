/**
 * PhoeniX - Cinematic Landing Page Builder
 * dashboard.js
 *
 * Renders the premium dark-mode hero page with:
 *   - Phoenix-gradient glowing neon border
 *   - "⚡ Install on Stremio" deep-link CTA (stremio:// protocol)
 *   - "📋 Copy Manifest URL" with navigator.clipboard
 *   - Active Catalog Aggregation Matrix (per-domain link counts grid)
 *   - Live System Performance & Stream Health Diagnostics table
 *
 * The HTML/CSS/JS is fully self-contained (no external assets) so
 * it works offline and behind any reverse proxy.
 */

'use strict';

/**
 * Build the full HTML document for the PhoeniX landing page.
 * @param {Object} opts
 * @param {string} opts.hostUrl   - absolute base URL (e.g. https://phoenix.example.com)
 * @param {Array}  opts.diagnostics - array of {source, status, playable, latencyMs, reason}
 * @param {Object} opts.stats      - { sources, cacheKeys, uptime }
 * @param {Object} opts.matrix     - { categories, totals, sources, audit }
 */
function buildDashboardHTML(opts = {}) {
  const hostUrl = (opts.hostUrl || '').replace(/\/+$/, '');
  const manifestUrl = `${hostUrl}/manifest.json`;
  const stremioDeepLink = `stremio://${hostUrl.replace(/^https?:\/\//, '')}/manifest.json`;
  const diagnostics = Array.isArray(opts.diagnostics) ? opts.diagnostics : [];
  const stats = opts.stats || { sources: 0, cacheKeys: 0, uptime: 0 };
  const matrix = opts.matrix || { categories: [], totals: {}, sources: [], audit: {} };

  // === Build matrix totals bar ===
  const matrixTotalsHTML = (matrix.categories || ['Movies', 'Series', 'Anime', 'K-Drama'])
    .map((cat) => {
      const v = (matrix.totals && matrix.totals[cat]) || 0;
      return `<div class="matrix-total-card">
        <div class="label">${escapeHtml(cat)}</div>
        <div class="value">${v}</div>
      </div>`;
    })
    .join('\n');

  // === Build per-source matrix cards ===
  const matrixCardsHTML = (matrix.sources || [])
    .map((src) => {
      const status = src.status || 'idle';
      const statusIcon =
        status === 'online'   ? '✅' :
        status === 'healing'  ? '🔄' :
        status === 'failover' ? '🔄' :
        status === 'blocked'  ? '⚠️' :
        status === 'dead'     ? '❌' :
                                '⏳';
      const statusLabel =
        status === 'online'   ? 'ONLINE' :
        status === 'healing'  ? 'HEALING' :
        status === 'failover' ? 'FAILOVER' :
        status === 'blocked'  ? 'BLOCKED' :
        status === 'dead'     ? 'DEAD' :
                                'IDLE';

      const pillClass = (count, isDead) => {
        if (isDead) return 'dead';
        if (count === 0) return 'zero';
        if (count < 10) return 'mid';
        return 'high';
      };

      const pills = ['Movies', 'Series', 'Anime', 'K-Drama']
        .map((cat) => {
          const count = src[cat] || 0;
          const isDead = status === 'dead';
          const cls = pillClass(count, isDead);
          return `<div class="matrix-pill">
            <div class="pill-label">${escapeHtml(cat)}</div>
            <div class="pill-value ${cls}">${count}</div>
          </div>`;
        })
        .join('\n');

      const note = src.statusNote
        ? `<div class="matrix-card-note">${escapeHtml(src.statusNote)}</div>`
        : '';

      return `<div class="matrix-card" data-status="${escapeAttr(status)}">
        <div class="matrix-card-header">
          <div>
            <div class="matrix-card-label">${escapeHtml(src.label || src.domain)}</div>
            <div class="matrix-card-type">${escapeHtml(src.type || '')}</div>
          </div>
          <span class="matrix-card-status ${escapeAttr(status)}">${statusIcon} ${statusLabel}</span>
        </div>
        <div class="matrix-card-pills">
          ${pills}
        </div>
        ${note}
      </div>`;
    })
    .join('\n');

  // === Build audit info bar ===
  const auditInfo = matrix.audit || {};
  const auditRunning = auditInfo.inProgress === true;
  const lastEnd = auditInfo.lastAuditEnd
    ? new Date(auditInfo.lastAuditEnd).toLocaleString()
    : 'never';
  const auditPillClass = auditRunning ? 'audit-pill running' : 'audit-pill';
  const auditPillContent = auditRunning
    ? `<span class="spin"></span><span>Audit Running</span>`
    : `<span>Last Audit: ${escapeHtml(lastEnd)}</span>`;

  const diagnosticsRows = diagnostics.length
    ? diagnostics
        .map((d) => {
          const isOk = d.playable === true || /^2\d\d$/.test(String(d.status));
          const isWarn = d.status === 403 || d.status === 416;
          const isBad =
            !isOk &&
            !isWarn &&
            (d.status === 404 ||
              d.status === 410 ||
              d.status === 500 ||
              d.status === 502 ||
              d.status === 503 ||
              d.status === 504 ||
              (d.reason || '').startsWith('network_') ||
              (d.reason || '').startsWith('error_'));
          const capsuleClass = isOk
            ? 'capsule-ok'
            : isWarn
            ? 'capsule-warn'
            : isBad
            ? 'capsule-bad'
            : 'capsule-unknown';
          const statusLabel = isOk
            ? '✅ Playable'
            : isWarn
            ? `${d.status} Block`
            : isBad
            ? `${d.status || '⚠'} ${d.reason || 'Error'}`
            : `${d.status || '?'} ${d.reason || ''}`;
          const latencyLabel =
            d.latencyMs != null
              ? `${d.latencyMs < 1000 ? d.latencyMs + 'ms' : (d.latencyMs / 1000).toFixed(1) + 's'}`
              : '—';
          return `<tr>
            <td class="src-name">${escapeHtml(d.source || '—')}</td>
            <td><span class="capsule ${capsuleClass}">${escapeHtml(statusLabel)}</span></td>
            <td class="latency">${latencyLabel}</td>
            <td class="url-cell">${escapeHtml(d.url || '—')}</td>
          </tr>`;
        })
        .join('\n')
    : `<tr><td colspan="4" class="empty-state">
        Awaiting first stream request — diagnostics will populate as
        users trigger playback. Run a <code>/stream/movie/tt0111161.json</code>
        request to seed live data.
      </td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>PhoeniX Streaming Node</title>
<meta name="description" content="PhoeniX - premium multi-source streaming addon for Stremio and Nuvio">
<style>
  /* ============================================================
     RESET + BASE
     ============================================================ */
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
      Helvetica, Arial, sans-serif;
    color: #e8e8ec;
    background: #0f0f12;
    background-image:
      radial-gradient(ellipse at 20% 0%, rgba(255, 87, 34, 0.18) 0%, transparent 55%),
      radial-gradient(ellipse at 80% 100%, rgba(255, 179, 0, 0.12) 0%, transparent 55%),
      linear-gradient(180deg, #0f0f12 0%, #14141a 100%);
    background-attachment: fixed;
    min-height: 100vh;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    overflow-x: hidden;
  }
  ::selection { background: rgba(255, 87, 34, 0.4); color: #fff; }

  /* ============================================================
     PHOENIX HERO - neon glowing border card
     ============================================================ */
  .hero-wrap {
    max-width: 960px;
    margin: 0 auto;
    padding: 56px 24px 32px;
    text-align: center;
  }

  .hero-card {
    position: relative;
    padding: 56px 40px 48px;
    border-radius: 22px;
    background:
      linear-gradient(180deg, rgba(20, 20, 26, 0.92) 0%, rgba(15, 15, 18, 0.96) 100%);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
    overflow: hidden;
    isolation: isolate;
  }

  /* Neon gradient border via mask trick */
  .hero-card::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 22px;
    padding: 1.5px;
    background: linear-gradient(135deg,
      #ff5722 0%,
      #ffb300 35%,
      #ff5722 70%,
      #ffb300 100%);
    background-size: 300% 300%;
    -webkit-mask:
      linear-gradient(#fff 0 0) content-box,
      linear-gradient(#fff 0 0);
    -webkit-mask-composite: xor;
            mask-composite: exclude;
    animation: phoenix-flow 6s linear infinite;
    pointer-events: none;
    z-index: 1;
  }

  /* Outer ambient glow */
  .hero-card::after {
    content: '';
    position: absolute;
    inset: -2px;
    border-radius: 24px;
    background: linear-gradient(135deg, #ff5722, #ffb300);
    filter: blur(28px);
    opacity: 0.35;
    z-index: -1;
    animation: phoenix-flow 6s linear infinite;
  }

  @keyframes phoenix-flow {
    0%   { background-position: 0% 50%; }
    50%  { background-position: 100% 50%; }
    100% { background-position: 0% 50%; }
  }

  /* Phoenix SVG vector */
  .phoenix-svg {
    width: 96px;
    height: 96px;
    margin: 0 auto 20px;
    display: block;
    filter:
      drop-shadow(0 0 12px rgba(255, 87, 34, 0.7))
      drop-shadow(0 0 24px rgba(255, 179, 0, 0.4));
    animation: phoenix-float 4s ease-in-out infinite;
  }

  @keyframes phoenix-float {
    0%, 100% { transform: translateY(0) scale(1); }
    50%      { transform: translateY(-6px) scale(1.04); }
  }

  .hero-title {
    font-size: clamp(2.2rem, 5vw, 3.4rem);
    font-weight: 800;
    letter-spacing: -0.02em;
    background: linear-gradient(135deg, #ff5722 0%, #ffb300 100%);
    -webkit-background-clip: text;
            background-clip: text;
    -webkit-text-fill-color: transparent;
    margin-bottom: 12px;
    text-shadow: 0 0 40px rgba(255, 87, 34, 0.4);
  }

  .hero-subtitle {
    font-size: 1.05rem;
    color: #9a9aa6;
    font-weight: 400;
    max-width: 580px;
    margin: 0 auto 32px;
  }

  .hero-stats {
    display: flex;
    justify-content: center;
    gap: 28px;
    margin-bottom: 36px;
    flex-wrap: wrap;
  }
  .hero-stat {
    text-align: center;
  }
  .hero-stat-value {
    font-size: 1.6rem;
    font-weight: 700;
    color: #ffb300;
    line-height: 1;
  }
  .hero-stat-label {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #6b6b78;
    margin-top: 6px;
  }

  /* ============================================================
     CTA CLUSTER
     ============================================================ */
  .cta-cluster {
    display: flex;
    justify-content: center;
    gap: 16px;
    flex-wrap: wrap;
    position: relative;
    z-index: 2;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    padding: 14px 28px;
    border-radius: 12px;
    font-size: 0.95rem;
    font-weight: 600;
    text-decoration: none;
    cursor: pointer;
    border: none;
    transition: transform 0.15s ease, box-shadow 0.2s ease, background 0.2s ease;
    font-family: inherit;
    white-space: nowrap;
  }
  .btn:active { transform: translateY(1px); }

  .btn-primary {
    background: linear-gradient(135deg, #ff5722 0%, #ffb300 100%);
    color: #0f0f12;
    box-shadow:
      0 8px 24px rgba(255, 87, 34, 0.35),
      0 0 0 1px rgba(255, 179, 0, 0.3) inset;
  }
  .btn-primary:hover {
    transform: translateY(-2px);
    box-shadow:
      0 12px 32px rgba(255, 87, 34, 0.5),
      0 0 0 1px rgba(255, 179, 0, 0.5) inset;
  }

  .btn-secondary {
    background: rgba(255, 255, 255, 0.06);
    color: #e8e8ec;
    border: 1px solid rgba(255, 179, 0, 0.4);
    backdrop-filter: blur(10px);
  }
  .btn-secondary:hover {
    background: rgba(255, 179, 0, 0.12);
    border-color: #ffb300;
    transform: translateY(-2px);
  }

  .btn-secondary.copied {
    background: rgba(76, 175, 80, 0.15);
    border-color: #4caf50;
    color: #4caf50;
  }

  /* ============================================================
     AGGREGATION MATRIX - per-domain source cards
     ============================================================ */
  .matrix-panel {
    max-width: 1200px;
    margin: 48px auto 32px;
    padding: 0 24px;
  }

  .matrix-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 20px;
    flex-wrap: wrap;
    gap: 12px;
  }

  .matrix-title {
    font-size: 1.35rem;
    font-weight: 700;
    color: #f0f0f4;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .matrix-title::before {
    content: '';
    width: 4px;
    height: 22px;
    background: linear-gradient(180deg, #ff5722, #ffb300);
    border-radius: 2px;
  }

  .matrix-audit-info {
    font-size: 0.8rem;
    color: #9a9aa6;
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
  }
  .matrix-audit-info .audit-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    background: rgba(255, 179, 0, 0.08);
    border: 1px solid rgba(255, 179, 0, 0.25);
    border-radius: 999px;
    color: #ffb300;
    font-weight: 600;
  }
  .matrix-audit-info .audit-pill.running {
    background: rgba(76, 175, 80, 0.12);
    border-color: rgba(76, 175, 80, 0.4);
    color: #4caf50;
  }
  .matrix-audit-info .audit-pill .spin {
    display: inline-block;
    width: 10px;
    height: 10px;
    border: 2px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .matrix-totals-bar {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
    margin-bottom: 24px;
  }
  .matrix-total-card {
    background: linear-gradient(135deg, rgba(255, 87, 34, 0.08) 0%, rgba(255, 179, 0, 0.05) 100%);
    border: 1px solid rgba(255, 179, 0, 0.2);
    border-radius: 12px;
    padding: 14px 16px;
    text-align: center;
  }
  .matrix-total-card .label {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #9a9aa6;
    margin-bottom: 6px;
  }
  .matrix-total-card .value {
    font-size: 1.6rem;
    font-weight: 800;
    background: linear-gradient(135deg, #ff5722, #ffb300);
    -webkit-background-clip: text;
            background-clip: text;
    -webkit-text-fill-color: transparent;
  }

  .matrix-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 14px;
  }

  .matrix-card {
    background: rgba(20, 20, 26, 0.7);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 12px;
    padding: 16px;
    backdrop-filter: blur(12px);
    transition: transform 0.15s ease, border-color 0.2s ease, box-shadow 0.2s ease;
    position: relative;
    overflow: hidden;
  }
  .matrix-card::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
    background: var(--card-accent, #444);
  }
  .matrix-card[data-status='online']   { --card-accent: linear-gradient(90deg, #4caf50, #66bb6a); }
  .matrix-card[data-status='healing']  { --card-accent: linear-gradient(90deg, #ff9800, #ffb300); }
  .matrix-card[data-status='failover'] { --card-accent: linear-gradient(90deg, #ff9800, #ff5722); }
  .matrix-card[data-status='blocked']  { --card-accent: linear-gradient(90deg, #f44336, #ff5722); }
  .matrix-card[data-status='dead']     { --card-accent: linear-gradient(90deg, #f44336, #b71c1c); opacity: 0.65; }
  .matrix-card[data-status='idle']     { --card-accent: linear-gradient(90deg, #6b6b78, #9a9aa6); }

  .matrix-card:hover {
    transform: translateY(-2px);
    border-color: rgba(255, 179, 0, 0.3);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
  }

  .matrix-card-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 12px;
    gap: 8px;
  }
  .matrix-card-label {
    font-size: 0.95rem;
    font-weight: 700;
    color: #f0f0f4;
    line-height: 1.2;
  }
  .matrix-card-type {
    font-size: 0.7rem;
    color: #6b6b78;
    margin-top: 4px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .matrix-card-status {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    border-radius: 999px;
    font-size: 0.7rem;
    font-weight: 600;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .matrix-card-status.online   { background: rgba(76, 175, 80, 0.15); color: #4caf50; border: 1px solid rgba(76, 175, 80, 0.4); }
  .matrix-card-status.healing  { background: rgba(255, 152, 0, 0.15); color: #ff9800; border: 1px solid rgba(255, 152, 0, 0.4); }
  .matrix-card-status.failover { background: rgba(255, 87, 34, 0.15); color: #ff5722; border: 1px solid rgba(255, 87, 34, 0.4); }
  .matrix-card-status.blocked  { background: rgba(244, 67, 54, 0.15); color: #f44336; border: 1px solid rgba(244, 67, 54, 0.4); }
  .matrix-card-status.dead     { background: rgba(244, 67, 54, 0.15); color: #f44336; border: 1px solid rgba(244, 67, 54, 0.4); }
  .matrix-card-status.idle     { background: rgba(158, 158, 158, 0.15); color: #9e9e9e; border: 1px solid rgba(158, 158, 158, 0.3); }

  .matrix-card-pills {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
  }
  .matrix-pill {
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 8px;
    padding: 8px 10px;
    text-align: center;
  }
  .matrix-pill .pill-label {
    font-size: 0.66rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #6b6b78;
    margin-bottom: 3px;
  }
  .matrix-pill .pill-value {
    font-size: 1.1rem;
    font-weight: 700;
    font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
  }
  .matrix-pill .pill-value.high  { color: #4caf50; }
  .matrix-pill .pill-value.mid   { color: #ffb300; }
  .matrix-pill .pill-value.zero  { color: #ff9800; opacity: 0.7; }
  .matrix-pill .pill-value.dead  { color: #f44336; opacity: 0.6; }

  .matrix-card-note {
    margin-top: 10px;
    font-size: 0.72rem;
    color: #6b6b78;
    font-style: italic;
  }

  .matrix-trigger-btn {
    background: rgba(255, 87, 34, 0.12);
    border: 1px solid rgba(255, 87, 34, 0.4);
    color: #ff5722;
    padding: 6px 14px;
    border-radius: 8px;
    font-size: 0.78rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
    font-family: inherit;
  }
  .matrix-trigger-btn:hover {
    background: rgba(255, 87, 34, 0.2);
    border-color: #ff5722;
  }
  .matrix-trigger-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  @media (max-width: 640px) {
    .matrix-totals-bar { grid-template-columns: repeat(2, 1fr); }
    .matrix-card-pills { grid-template-columns: repeat(2, 1fr); }
  }

  /* ============================================================
     DIAGNOSTICS PANEL
     ============================================================ */
  .diag-panel {
    max-width: 1100px;
    margin: 48px auto 64px;
    padding: 0 24px;
  }

  .diag-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 20px;
    flex-wrap: wrap;
    gap: 12px;
  }

  .diag-title {
    font-size: 1.35rem;
    font-weight: 700;
    color: #f0f0f4;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .diag-title::before {
    content: '';
    width: 4px;
    height: 22px;
    background: linear-gradient(180deg, #ff5722, #ffb300);
    border-radius: 2px;
  }

  .diag-refresh {
    font-size: 0.8rem;
    color: #6b6b78;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .diag-refresh .pulse {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #4caf50;
    box-shadow: 0 0 0 0 rgba(76, 175, 80, 0.7);
    animation: pulse 2s infinite;
  }
  @keyframes pulse {
    0%   { box-shadow: 0 0 0 0 rgba(76, 175, 80, 0.7); }
    70%  { box-shadow: 0 0 0 8px rgba(76, 175, 80, 0); }
    100% { box-shadow: 0 0 0 0 rgba(76, 175, 80, 0); }
  }

  .diag-table-wrap {
    background: rgba(20, 20, 26, 0.7);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 14px;
    overflow: hidden;
    backdrop-filter: blur(12px);
  }

  .diag-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.88rem;
  }

  .diag-table thead {
    background: rgba(255, 87, 34, 0.08);
  }

  .diag-table th {
    text-align: left;
    padding: 14px 18px;
    font-weight: 600;
    color: #ffb300;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-size: 0.74rem;
    border-bottom: 1px solid rgba(255, 179, 0, 0.18);
  }

  .diag-table td {
    padding: 14px 18px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    vertical-align: middle;
  }

  .diag-table tbody tr:last-child td {
    border-bottom: none;
  }

  .diag-table tbody tr:hover {
    background: rgba(255, 87, 34, 0.04);
  }

  .src-name {
    font-weight: 600;
    color: #f0f0f4;
  }

  .url-cell {
    font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
    font-size: 0.78rem;
    color: #6b6b78;
    max-width: 380px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .latency {
    font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
    color: #9a9aa6;
  }

  .capsule {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 12px;
    border-radius: 999px;
    font-size: 0.78rem;
    font-weight: 600;
    white-space: nowrap;
  }

  .capsule-ok {
    background: rgba(76, 175, 80, 0.15);
    color: #4caf50;
    border: 1px solid rgba(76, 175, 80, 0.4);
    box-shadow: 0 0 12px rgba(76, 175, 80, 0.2);
  }

  .capsule-warn {
    background: rgba(255, 152, 0, 0.15);
    color: #ff9800;
    border: 1px solid rgba(255, 152, 0, 0.4);
  }

  .capsule-bad {
    background: rgba(244, 67, 54, 0.15);
    color: #f44336;
    border: 1px solid rgba(244, 67, 54, 0.4);
  }

  .capsule-unknown {
    background: rgba(158, 158, 158, 0.15);
    color: #9e9e9e;
    border: 1px solid rgba(158, 158, 158, 0.3);
  }

  .empty-state {
    text-align: center;
    color: #6b6b78;
    padding: 32px 18px !important;
    font-style: italic;
  }
  .empty-state code {
    background: rgba(255, 179, 0, 0.1);
    color: #ffb300;
    padding: 2px 6px;
    border-radius: 4px;
    font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
    font-size: 0.82rem;
  }

  /* ============================================================
     FOOTER
     ============================================================ */
  .footer {
    max-width: 960px;
    margin: 0 auto;
    padding: 24px;
    text-align: center;
    color: #6b6b78;
    font-size: 0.8rem;
    border-top: 1px solid rgba(255, 255, 255, 0.04);
  }
  .footer a {
    color: #ffb300;
    text-decoration: none;
  }
  .footer a:hover { text-decoration: underline; }

  /* ============================================================
     RESPONSIVE
     ============================================================ */
  @media (max-width: 640px) {
    .hero-card { padding: 40px 22px 32px; }
    .hero-stats { gap: 18px; }
    .hero-stat-value { font-size: 1.3rem; }
    .btn { padding: 12px 20px; font-size: 0.88rem; }
    .diag-table { font-size: 0.78rem; }
    .diag-table th, .diag-table td { padding: 10px 12px; }
    .url-cell { max-width: 160px; }
  }

  /* ============================================================
     TOAST
     ============================================================ */
  .toast {
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%) translateY(20px);
    background: rgba(20, 20, 26, 0.95);
    color: #4caf50;
    border: 1px solid #4caf50;
    padding: 12px 24px;
    border-radius: 10px;
    font-size: 0.88rem;
    font-weight: 600;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.25s ease, transform 0.25s ease;
    z-index: 1000;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  }
  .toast.show {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }
</style>
</head>
<body>

<!-- ============== HERO ============== -->
<div class="hero-wrap">
  <div class="hero-card">
    <!-- Phoenix SVG: abstract rising bird with flame tail -->
    <svg class="phoenix-svg" viewBox="0 0 96 96" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="phxGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%"  stop-color="#ff5722"/>
          <stop offset="60%" stop-color="#ffb300"/>
          <stop offset="100%" stop-color="#ff5722"/>
        </linearGradient>
        <radialGradient id="phxCore" cx="50%" cy="50%" r="50%">
          <stop offset="0%"  stop-color="#ffe082"/>
          <stop offset="100%" stop-color="#ff5722"/>
        </radialGradient>
      </defs>
      <!-- Left wing -->
      <path d="M48 50 Q30 38 14 46 Q22 50 26 54 Q18 56 12 64 Q24 62 30 60 Q24 68 22 78 Q34 70 40 64 Q42 72 46 78 Z"
            fill="url(#phxGrad)" opacity="0.95"/>
      <!-- Right wing (mirrored) -->
      <path d="M48 50 Q66 38 82 46 Q74 50 70 54 Q78 56 84 64 Q72 62 66 60 Q72 68 74 78 Q62 70 56 64 Q54 72 50 78 Z"
            fill="url(#phxGrad)" opacity="0.95"/>
      <!-- Body / head -->
      <ellipse cx="48" cy="42" rx="8" ry="14" fill="url(#phxCore)"/>
      <circle cx="48" cy="30" r="6" fill="url(#phxCore)"/>
      <!-- Tail flames -->
      <path d="M44 54 Q42 70 36 82 Q40 76 44 78 Q42 86 38 92 Q48 84 48 76 Q48 84 58 92 Q54 86 52 78 Q56 76 60 82 Q54 70 52 54 Z"
            fill="url(#phxGrad)" opacity="0.85"/>
      <!-- Eye -->
      <circle cx="48" cy="28" r="1.5" fill="#0f0f12"/>
    </svg>

    <h1 class="hero-title">PhoeniX Streaming Node</h1>
    <p class="hero-subtitle">
      A premium multi-source streaming aggregator for Stremio &amp; Nuvio.
      Three-tier source architecture with strict video-only filtering,
      pre-flight verification, and seekable proxy for native playback.
    </p>

    <div class="hero-stats">
      <div class="hero-stat">
        <div class="hero-stat-value">${stats.sources || 0}</div>
        <div class="hero-stat-label">Active Sources</div>
      </div>
      <div class="hero-stat">
        <div class="hero-stat-value">${stats.cacheKeys || 0}</div>
        <div class="hero-stat-label">Cached Items</div>
      </div>
      <div class="hero-stat">
        <div class="hero-stat-value">${formatUptime(stats.uptime)}</div>
        <div class="hero-stat-label">Uptime</div>
      </div>
    </div>

    <div class="cta-cluster">
      <a href="${escapeAttr(stremioDeepLink)}" class="btn btn-primary" id="installBtn">
        ⚡ Install on Stremio
      </a>
      <button class="btn btn-secondary" id="copyBtn" type="button">
        📋 Copy Manifest URL
      </button>
    </div>
  </div>
</div>

<!-- ============== AGGREGATION MATRIX ============== -->
<div class="matrix-panel">
  <div class="matrix-header">
    <h2 class="matrix-title">📡 Active Catalog Aggregation Matrix</h2>
    <div class="matrix-audit-info">
      <span class="${auditPillClass}">${auditPillContent}</span>
      <button class="matrix-trigger-btn" id="triggerAuditBtn" type="button" ${auditRunning ? 'disabled' : ''}>
        ${auditRunning ? '⏳ Auditing...' : '🔄 Trigger Audit'}
      </button>
    </div>
  </div>

  <div class="matrix-totals-bar">
    ${matrixTotalsHTML}
  </div>

  <div class="matrix-grid" id="matrixGrid">
    ${matrixCardsHTML || '<div style="grid-column: 1 / -1; text-align: center; color: #6b6b78; padding: 32px;">No sources registered yet.</div>'}
  </div>
</div>

<!-- ============== DIAGNOSTICS ============== -->
<div class="diag-panel">
  <div class="diag-header">
    <h2 class="diag-title">System Performance &amp; Stream Health Diagnostics</h2>
    <div class="diag-refresh">
      <span class="pulse"></span>
      <span>Live · auto-refresh 15s</span>
    </div>
  </div>

  <div class="diag-table-wrap">
    <table class="diag-table">
      <thead>
        <tr>
          <th>Source</th>
          <th>Status</th>
          <th>Latency</th>
          <th>Probed URL</th>
        </tr>
      </thead>
      <tbody id="diagBody">
        ${diagnosticsRows}
      </tbody>
    </table>
  </div>
</div>

<!-- ============== FOOTER ============== -->
<div class="footer">
  PhoeniX v3.0.0 ·
  <a href="${escapeAttr(manifestUrl)}">manifest.json</a> ·
  <a href="/health">health</a> ·
  <a href="/stats">stats</a> ·
  Built for Stremio &amp; Nuvio native playback
</div>

<!-- ============== TOAST ============== -->
<div class="toast" id="toast">✅ Copied!</div>

<script>
(function() {
  'use strict';

  // ============ COPY MANIFEST URL ============
  var copyBtn = document.getElementById('copyBtn');
  var toast = document.getElementById('toast');
  var manifestUrl = ${JSON.stringify(manifestUrl)};

  function showToast(msg, isError) {
    toast.textContent = msg;
    toast.style.color = isError ? '#f44336' : '#4caf50';
    toast.style.borderColor = isError ? '#f44336' : '#4caf50';
    toast.classList.add('show');
    setTimeout(function() { toast.classList.remove('show'); }, 2200);
  }

  copyBtn.addEventListener('click', function() {
    var originalText = copyBtn.innerHTML;
    function onSuccess() {
      copyBtn.innerHTML = '✅ Copied!';
      copyBtn.classList.add('copied');
      showToast('✅ Manifest URL copied to clipboard');
      setTimeout(function() {
        copyBtn.innerHTML = originalText;
        copyBtn.classList.remove('copied');
      }, 2200);
    }
    function onFailure() {
      showToast('⚠ Clipboard blocked — copy manually', true);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(manifestUrl).then(onSuccess, onFailure);
    } else {
      // Fallback: legacy execCommand
      try {
        var ta = document.createElement('textarea');
        ta.value = manifestUrl;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) { onSuccess(); } else { onFailure(); }
      } catch (e) { onFailure(); }
    }
  });

  // ============ INSTALL BUTTON ANALYTICS ============
  var installBtn = document.getElementById('installBtn');
  installBtn.addEventListener('click', function(e) {
    // Don't preventDefault - we want the stremio:// deep link to fire.
    // Just visually confirm.
    var original = installBtn.innerHTML;
    installBtn.innerHTML = '🚀 Launching Stremio...';
    setTimeout(function() {
      installBtn.innerHTML = original;
    }, 2000);
  });

  // ============ LIVE DIAGNOSTICS POLLING ============
  var diagBody = document.getElementById('diagBody');
  var renderRow = function(d) {
    var isOk = d.playable === true || /^2\\d\\d$/.test(String(d.status));
    var isWarn = d.status === 403 || d.status === 416;
    var isBad = !isOk && !isWarn && (
      d.status === 404 || d.status === 410 ||
      d.status === 500 || d.status === 502 || d.status === 503 || d.status === 504 ||
      (d.reason || '').indexOf('network_') === 0 ||
      (d.reason || '').indexOf('error_') === 0
    );
    var capsuleClass = isOk ? 'capsule-ok' : (isWarn ? 'capsule-warn' : (isBad ? 'capsule-bad' : 'capsule-unknown'));
    var statusLabel = isOk ? '✅ Playable'
      : (isWarn ? (d.status + ' Block')
      : (isBad ? ((d.status || '⚠') + ' ' + (d.reason || 'Error'))
      : ((d.status || '?') + ' ' + (d.reason || ''))));
    var latency = d.latencyMs != null
      ? (d.latencyMs < 1000 ? d.latencyMs + 'ms' : (d.latencyMs/1000).toFixed(1) + 's')
      : '—';
    var safeUrl = (d.url || '—').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    var safeSrc = (d.source || '—').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    var safeLabel = String(statusLabel).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return '<tr>' +
      '<td class="src-name">' + safeSrc + '</td>' +
      '<td><span class="capsule ' + capsuleClass + '">' + safeLabel + '</span></td>' +
      '<td class="latency">' + latency + '</td>' +
      '<td class="url-cell">' + safeUrl + '</td>' +
      '</tr>';
  };

  function fetchDiagnostics() {
    fetch('/api/diagnostics', { cache: 'no-store' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var rows = (data.diagnostics || []);
        if (!rows.length) {
          diagBody.innerHTML = '<tr><td colspan="4" class="empty-state">' +
            'Awaiting first stream request — diagnostics will populate as ' +
            'users trigger playback. Run a <code>/stream/movie/tt0111161.json</code> ' +
            'request to seed live data.</td></tr>';
          return;
        }
        diagBody.innerHTML = rows.map(renderRow).join('\\n');
      })
      .catch(function() {
        // silent fail - keep last known state
      });
  }

  // Poll every 15s
  fetchDiagnostics();
  setInterval(fetchDiagnostics, 15000);

  // ============ MATRIX POLLING ============
  var matrixGrid = document.getElementById('matrixGrid');
  var triggerBtn = document.getElementById('triggerAuditBtn');

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function pillClass(count, isDead) {
    if (isDead) return 'dead';
    if (count === 0) return 'zero';
    if (count < 10) return 'mid';
    return 'high';
  }

  function renderMatrixCard(src) {
    var status = src.status || 'idle';
    var statusIcon =
      status === 'online'   ? '✅' :
      status === 'healing'  ? '🔄' :
      status === 'failover' ? '🔄' :
      status === 'blocked'  ? '⚠️' :
      status === 'dead'     ? '❌' :
                              '⏳';
    var statusLabel =
      status === 'online'   ? 'ONLINE' :
      status === 'healing'  ? 'HEALING' :
      status === 'failover' ? 'FAILOVER' :
      status === 'blocked'  ? 'BLOCKED' :
      status === 'dead'     ? 'DEAD' :
                              'IDLE';
    var cats = ['Movies', 'Series', 'Anime', 'K-Drama'];
    var pills = cats.map(function(cat) {
      var count = src[cat] || 0;
      var cls = pillClass(count, status === 'dead');
      return '<div class="matrix-pill">' +
        '<div class="pill-label">' + escapeHtml(cat) + '</div>' +
        '<div class="pill-value ' + cls + '">' + count + '</div>' +
        '</div>';
    }).join('\\n');
    var note = src.statusNote
      ? '<div class="matrix-card-note">' + escapeHtml(src.statusNote) + '</div>'
      : '';
    return '<div class="matrix-card" data-status="' + escapeHtml(status) + '">' +
      '<div class="matrix-card-header">' +
        '<div>' +
          '<div class="matrix-card-label">' + escapeHtml(src.label || src.domain) + '</div>' +
          '<div class="matrix-card-type">' + escapeHtml(src.type || '') + '</div>' +
        '</div>' +
        '<span class="matrix-card-status ' + escapeHtml(status) + '">' + statusIcon + ' ' + statusLabel + '</span>' +
      '</div>' +
      '<div class="matrix-card-pills">' + pills + '</div>' +
      note +
      '</div>';
  }

  function fetchMatrix() {
    fetch('/api/matrix', { cache: 'no-store' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        // Update totals bar
        var totalsBar = document.querySelector('.matrix-totals-bar');
        if (totalsBar && data.totals) {
          var cats = data.categories || ['Movies', 'Series', 'Anime', 'K-Drama'];
          totalsBar.innerHTML = cats.map(function(cat) {
            var v = data.totals[cat] || 0;
            return '<div class="matrix-total-card">' +
              '<div class="label">' + escapeHtml(cat) + '</div>' +
              '<div class="value">' + v + '</div>' +
              '</div>';
          }).join('');
        }
        // Update source cards
        if (matrixGrid && data.sources) {
          if (!data.sources.length) {
            matrixGrid.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; color: #6b6b78; padding: 32px;">No sources registered yet.</div>';
          } else {
            matrixGrid.innerHTML = data.sources.map(renderMatrixCard).join('');
          }
        }
        // Update audit pill + trigger button
        var audit = data.audit || {};
        var pill = document.querySelector('.audit-pill');
        if (pill) {
          if (audit.inProgress) {
            pill.className = 'audit-pill running';
            pill.innerHTML = '<span class="spin"></span><span>Audit Running</span>';
            if (triggerBtn) {
              triggerBtn.disabled = true;
              triggerBtn.innerHTML = '⏳ Auditing...';
            }
          } else {
            pill.className = 'audit-pill';
            var lastEnd = audit.lastAuditEnd
              ? new Date(audit.lastAuditEnd).toLocaleString()
              : 'never';
            pill.innerHTML = '<span>Last Audit: ' + escapeHtml(lastEnd) + '</span>';
            if (triggerBtn) {
              triggerBtn.disabled = false;
              triggerBtn.innerHTML = '🔄 Trigger Audit';
            }
          }
        }
      })
      .catch(function() {
        // silent fail
      });
  }

  // Trigger audit on button click
  if (triggerBtn) {
    triggerBtn.addEventListener('click', function() {
      if (triggerBtn.disabled) return;
      triggerBtn.disabled = true;
      triggerBtn.innerHTML = '⏳ Auditing...';
      fetch('/api/audit/trigger', { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function() {
          // Poll matrix every 3s while audit runs, then back off to 15s.
          fetchMatrix();
          var fastPoll = setInterval(function() {
            fetchMatrix();
            // Stop fast polling once audit completes.
            fetch('/api/matrix', { cache: 'no-store' })
              .then(function(r) { return r.json(); })
              .then(function(d) {
                if (!d.audit || !d.audit.inProgress) {
                  clearInterval(fastPoll);
                }
              })
              .catch(function() {});
          }, 3000);
        })
        .catch(function() {
          triggerBtn.disabled = false;
          triggerBtn.innerHTML = '🔄 Trigger Audit';
        });
    });
  }

  fetchMatrix();
  setInterval(fetchMatrix, 15000);
})();
</script>

</body>
</html>`;
}

// ============================================================
// HELPERS
// ============================================================

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  return escapeHtml(s);
}

function formatUptime(seconds) {
  if (!seconds || seconds < 1) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

module.exports = { buildDashboardHTML };
