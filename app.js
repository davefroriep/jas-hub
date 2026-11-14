import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { getDatabase, ref, onValue, set } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";

// Register Offline-First Service Worker + Seamless Auto-Refresh on Version Bump
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").then(reg => {
      reg.update().catch(() => {});
    }).catch(err => console.warn("SW reg warning:", err));
  });
  const hadController = Boolean(navigator.serviceWorker.controller);
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController && !refreshing) {
      refreshing = true;
      window.location.reload();
    }
  });
}

// Local Storage Keys
const LS_STARRED = "jas2027_starred_teams";
const LS_TIER = "jas2027_focus_tier";
const LS_VIEW_MODE = "jas2027_view_mode";
const LS_SETUP_DONE = "jas2027_setup_seen";
const LS_LAST_LIVE = "jas2027_last_live_cache";
const LS_SPOTTER_SESSION = "jas2027_spotter_session";

const TIER_DESCRIPTIONS = {
  1: "1 • My Kid's Team(s) Only",
  2: "2 • My Teams + All 9 JAS Teams",
  3: "3 • My Teams + JAS + My Division Rivals",
  4: "4 • My Teams + JAS + All JAS Divisions' Rivals"
};

let APP_DATA = null;
let EVENT = null;
let ENTRIES = [];
let currentDay = "2026-12-12";
let currentViewMode = localStorage.getItem(LS_VIEW_MODE) === "full" ? "full" : "hub";
let currentTier = Number(localStorage.getItem(LS_TIER) || 3);
let currentQuickFilter = "all"; // 'all' | 'jas' | 'rivals'
let starredTeams = JSON.parse(localStorage.getItem(LS_STARRED) || "[]");

// Live / Sim State: { order, date, driftMin, updatedAt, mode: 'cloud' | 'sim' }
let cloudLiveState = JSON.parse(localStorage.getItem(LS_LAST_LIVE) || "null");
let simLiveState = null;
let spotterSessionId = localStorage.getItem(LS_SPOTTER_SESSION) || null;
let db = null;

const $ = id => document.getElementById(id);

function parseMinutes(tStr) {
  if (!tStr) return null;
  const m = tStr.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AP]M)$/i);
  if (!m) return null;
  let hh = Number(m[1]);
  const mm = Number(m[2]);
  const ap = m[3].toUpperCase();
  if (ap === "PM" && hh !== 12) hh += 12;
  if (ap === "AM" && hh === 12) hh = 0;
  return hh * 60 + mm;
}

function formatMinutes(totalMin) {
  if (totalMin === null || totalMin === undefined) return "—";
  let m = ((Math.round(totalMin) % 1440) + 1440) % 1440;
  let hh = Math.floor(m / 60);
  const mm = m % 60;
  const ap = hh >= 12 ? "PM" : "AM";
  hh = hh % 12;
  if (hh === 0) hh = 12;
  return `${hh}:${String(mm).padStart(2, "0")} ${ap}`;
}

function getActiveLive() {
  if (simLiveState && simLiveState.date === currentDay) return simLiveState;
  if (cloudLiveState && cloudLiveState.date === currentDay) return cloudLiveState;
  return null;
}

function getAdjustedTime(schedStr, live) {
  if (!live || !live.driftMin) return null;
  const base = parseMinutes(schedStr);
  if (base === null) return null;
  return formatMinutes(base + live.driftMin);
}

async function sha256Hex(str) {
  const buf = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function loadData() {
  const resp = await fetch("./data/app_data.json");
  APP_DATA = await resp.json();
  const evId = APP_DATA.active_event_id;
  EVENT = APP_DATA.events[evId];
  ENTRIES = EVENT.entries;

  $("full-total-pill").textContent = String(ENTRIES.length);

  // Show team picker automatically on very first visit so parents see customization
  if (!localStorage.getItem(LS_SETUP_DONE)) {
    $("picker-card").style.display = "block";
    localStorage.setItem(LS_SETUP_DONE, "1");
  }

  renderTeamChips();
  renderSeasonModal();
  syncViewModeUI();
  syncTierButtons();
  syncDayTabsUI();
  renderAll();
  initFirebase();
}

function setViewMode(mode, scrollTop = true) {
  currentViewMode = mode === "full" ? "full" : "hub";
  localStorage.setItem(LS_VIEW_MODE, currentViewMode);
  syncViewModeUI();
  renderAll();
  if (scrollTop) {
    window.scrollTo({ top: 0, behavior: "instant" });
  }
}

function syncViewModeUI() {
  const isFull = currentViewMode === "full";
  $("btn-mode-hub").classList.toggle("active", !isFull);
  $("btn-mode-full").classList.toggle("active", isFull);
  $("view-my-hub").style.display = isFull ? "none" : "block";
  $("view-full-sched").style.display = isFull ? "block" : "none";
}

function syncDayTabsUI() {
  document.querySelectorAll(".day-tab").forEach(b => {
    b.classList.toggle("active", b.dataset.date === currentDay);
  });
}

function renderTeamChips() {
  const roster = APP_DATA.season.jas_roster;
  $("team-chips").innerHTML = roster.map(r => {
    const sel = starredTeams.includes(r.team) ? "selected" : "";
    return `<button type="button" class="team-chip ${sel}" data-team="${r.team}">${r.team}</button>`;
  }).join("");

  document.querySelectorAll(".team-chip").forEach(btn => {
    btn.addEventListener("click", () => {
      const t = btn.dataset.team;
      if (starredTeams.includes(t)) {
        starredTeams = starredTeams.filter(x => x !== t);
      } else {
        starredTeams.push(t);
      }
      localStorage.setItem(LS_STARRED, JSON.stringify(starredTeams));
      renderTeamChips();
      renderAll();
    });
  });
}

function syncTierButtons() {
  document.querySelectorAll(".tier-btn").forEach(b => {
    b.classList.toggle("active", Number(b.dataset.tier) === currentTier);
  });
  $("tier-desc").textContent = TIER_DESCRIPTIONS[currentTier] || "";
}

function renderLiveStrip() {
  const live = getActiveLive();
  const strip = $("live-strip");
  const pill = $("drift-pill");
  strip.classList.remove("is-live", "is-jas-stage");
  pill.classList.remove("late", "early");

  if (!live || !live.order) {
    $("live-strip-label").textContent = "📡 Hall C Stage Pulse";
    pill.textContent = "Schedule Mode (±0m)";
    $("live-stage-main").textContent = "No live mat check-in active for this day yet";
    $("live-stage-sub").textContent = "Works 100% offline • Tap 📍 Spotter to test live drift or check in a routine.";
    return;
  }

  const entry = ENTRIES.find(e => e.date === currentDay && e.order === live.order);
  const d = live.driftMin || 0;
  const driftTxt = d > 0 ? `+${d}m behind` : (d < 0 ? `${d}m ahead` : "On time (±0m)");
  if (d > 2) pill.classList.add("late");
  else if (d < -2) pill.classList.add("early");
  pill.textContent = `Hall C: ${driftTxt}`;

  const ageMin = live.updatedAt ? Math.max(0, Math.round((Date.now() - live.updatedAt) / 60000)) : 0;
  const modeTag = live.mode === "sim" ? "🧪 LOCAL ALPHA PREVIEW" : `🟢 LIVE HALL PULSE (${ageMin === 0 ? "just now" : ageMin + "m ago"})`;
  $("live-strip-label").textContent = modeTag;

  if (entry) {
    strip.classList.add(entry.is_jas ? "is-jas-stage" : "is-live");
    const who = entry.team ? `${entry.program} — ${entry.team}` : entry.program;
    $("live-stage-main").textContent = `#${entry.order} On Mat: ${who}`;
    $("live-stage-sub").textContent = `${entry.division} • Panel ${entry.panel || "—"} • Scheduled ${entry.compete}`;
  } else {
    strip.classList.add("is-live");
    $("live-stage-main").textContent = `Order #${live.order} On Mat`;
    $("live-stage-sub").textContent = `All upcoming times adjusted by ${driftTxt}.`;
  }
}

function renderConflicts() {
  const dayJas = ENTRIES.filter(e => e.date === currentDay && e.is_jas && starredTeams.includes(e.team))
    .sort((a, b) => a.order - b.order);

  if (dayJas.length < 2) {
    $("conflict-box").innerHTML = "";
    return;
  }

  const alerts = [];
  for (let i = 0; i < dayJas.length - 1; i++) {
    const first = dayJas[i];
    const second = dayJas[i + 1];
    const firstComp = parseMinutes(first.compete);
    const secWu = parseMinutes(second.warmup_checkin);
    if (firstComp !== null && secWu !== null) {
      const gap = secWu - firstComp;
      if (gap <= 55) {
        alerts.push(
          `<div class="conflict-alert">
            <strong>⚠️ Two-Athlete Transition Squeeze (${gap}m gap):</strong>
            <strong>${second.team}</strong> Warm-Up Check-In (<strong>${second.warmup_checkin}</strong>) is only <strong>${gap} mins</strong> after <strong>${first.team}</strong> competes (<strong>${first.compete}</strong>). Once coaches set their 30–45m pre-check-in huddle, <strong>${second.team}'s</strong> meet-up will overlap <strong>${first.team}</strong> on stage — have both athletes hair &amp; uniform ready before ${first.warmup_checkin}!
          </div>`
        );
      }
    }
  }
  $("conflict-box").innerHTML = alerts.join("");
}

function renderTier1MyTeams() {
  const live = getActiveLive();
  const myEntries = ENTRIES.filter(e => e.date === currentDay && e.is_jas && starredTeams.includes(e.team))
    .sort((a, b) => a.order - b.order);

  $("my-teams-count").textContent = `${myEntries.length} competing ${currentDay === "2026-12-12" ? "Saturday" : "Sunday"}`;

  if (!starredTeams.length) {
    $("my-teams-container").innerHTML = `
      <div class="my-team-card">
        <div class="mtc-div">Tap <strong>⚙️ My Teams</strong> above to pick your athlete's team(s) — saved privately on your phone for Stage Pulse, Warm-Up times, and division rivals.</div>
      </div>`;
    return;
  }

  if (!myEntries.length) {
    $("my-teams-container").innerHTML = `
      <div class="my-team-card">
        <div class="mtc-div">None of your selected teams compete on this day (1-day Novice/Prep teams compete Saturday only). Tap ⚙️ My Teams or switch to SAT Dec 12.</div>
      </div>`;
    return;
  }

  $("my-teams-container").innerHTML = myEntries.map(e => {
    const estComp = getAdjustedTime(e.compete, live);
    const estWu = getAdjustedTime(e.warmup_checkin, live);

    let badgeTxt = `#${e.order} in Hall C`;
    let badgeCls = "away-badge";
    let cardCls = "my-team-card";

    if (live && live.order) {
      const diff = e.order - live.order;
      if (diff === 0) {
        badgeTxt = "🔥 ON MAT NOW";
        badgeCls += " urgent";
        cardCls += " on-stage";
      } else if (diff > 0) {
        badgeTxt = `${diff} routine${diff === 1 ? "" : "s"} away`;
        if (diff <= 6) badgeCls += " urgent";
      } else {
        badgeTxt = "Completed ✓";
        cardCls += " done";
      }
    }

    return `
      <div class="${cardCls}">
        <div class="mtc-top">
          <div>
            <div class="mtc-name">⭐ ${e.team}</div>
            <div class="mtc-div">${e.division} • #${e.division_seq} of ${e.division_total} in Div • Panel ${e.panel}</div>
          </div>
          <span class="${badgeCls}">${badgeTxt}</span>
        </div>
        <div class="mtc-timeline">
          <div class="tl-box">
            <div class="tl-lbl">Coach Meet</div>
            <div class="tl-val" style="font-size:0.74rem; color:#fde68a;">${e.coach_meet_time && !e.coach_meet_time.startsWith("TBD") ? e.coach_meet_time : "TBD"}</div>
          </div>
          <div class="tl-box">
            <div class="tl-lbl">Warm-Up In</div>
            <div class="tl-val">${e.warmup_checkin}</div>
            ${estWu ? `<div class="tl-est">~${estWu}</div>` : ""}
          </div>
          <div class="tl-box">
            <div class="tl-lbl">Full Floor</div>
            <div class="tl-val">${e.full_floor}</div>
          </div>
          <div class="tl-box highlight">
            <div class="tl-lbl">ON MAT</div>
            <div class="tl-val">${e.compete}</div>
            ${estComp ? `<div class="tl-est">Est ~${estComp}</div>` : ""}
          </div>
        </div>
        <div class="mtc-footer">
          <span>Hall Order <strong>#${e.order}</strong> • ${e.tp} Athletes</span>
          <span>Awards: <strong>${e.awards_time || "TBD"}</strong></span>
        </div>
      </div>
    `;
  }).join("");
}

function renderTier2JasFeed() {
  const sec = $("sec-tier2");
  if (currentTier < 2) {
    sec.style.display = "none";
    return;
  }
  sec.style.display = "block";
  const live = getActiveLive();

  const jasRows = ENTRIES.filter(e =>
    e.date === currentDay && (e.is_jas || (e.is_break && e.program.toUpperCase().includes("LUNCH")))
  ).sort((a, b) => a.order - b.order);

  $("jas-feed-container").innerHTML = jasRows.map(e => {
    if (e.is_break) {
      return `<div class="feed-row break-row">⏸️ #${e.order} — ${e.program} (${e.compete})</div>`;
    }
    const isStarred = starredTeams.includes(e.team);
    const isPast = live && live.order && e.order < live.order;
    const isNow = live && live.order && e.order === live.order;
    const est = getAdjustedTime(e.compete, live);

    let cls = "feed-row " + (isStarred ? "starred-row" : "jas-row");
    if (isPast) cls += " past-row";
    if (isNow) cls += " live-now-row";

    const away = (live && live.order && e.order > live.order) ? ` • ${e.order - live.order} away` : "";

    return `
      <div class="${cls}">
        <div class="fr-time">
          <div class="fr-sched">${e.compete}</div>
          ${est ? `<div class="fr-est">~${est}</div>` : ""}
          <div class="fr-order">#${e.order} • Pnl ${e.panel}</div>
        </div>
        <div class="fr-body">
          <div class="fr-title">${isStarred ? "⭐ " : ""}${e.team}</div>
          <div class="fr-sub">${e.division} (#${e.division_seq} of ${e.division_total}) • WU ${e.warmup_checkin}${away}</div>
        </div>
      </div>
    `;
  }).join("");
}

function renderRivalsSection() {
  const sec = $("sec-rivals");
  if (currentTier < 3) {
    sec.style.display = "none";
    return;
  }
  sec.style.display = "block";
  const live = getActiveLive();

  const targetJasEntries = ENTRIES.filter(e =>
    e.date === currentDay &&
    e.is_jas &&
    (currentTier === 4 || starredTeams.includes(e.team))
  ).sort((a, b) => a.order - b.order);

  $("rivals-hdr-title").textContent = currentTier === 3 ? "🏆 My Division Rivals" : "🏆 All JAS Division Scouting";
  $("rivals-hdr-sub").textContent = `${targetJasEntries.length} division${targetJasEntries.length === 1 ? "" : "s"}`;

  $("rivals-container").innerHTML = targetJasEntries.map(jas => {
    const divTeams = ENTRIES.filter(e => e.date === currentDay && e.division === jas.division)
      .sort((a, b) => a.order - b.order);

    const rowsHtml = divTeams.map(t => {
      const isUs = t.is_jas;
      const isPast = live && live.order && t.order < live.order;
      const isNow = live && live.order && t.order === live.order;
      const est = getAdjustedTime(t.compete, live);

      let cls = "feed-row " + (isUs ? "starred-row" : "rival-row");
      if (isPast) cls += " past-row";
      if (isNow) cls += " live-now-row";

      return `
        <div class="${cls}" style="border-radius:0; border-left-width:4px; border-right:none; border-top:none;">
          <div class="fr-time">
            <div class="fr-sched">${t.compete}</div>
            ${est ? `<div class="fr-est">~${est}</div>` : ""}
            <div class="fr-order">#${t.order}</div>
          </div>
          <div class="fr-body">
            <div class="fr-title">${isUs ? "⭐ " : ""}${t.program}${t.team ? " — " + t.team : ""}</div>
            <div class="fr-sub">Div #${t.division_seq}/${t.division_total} • ${t.location} • ${t.tp || "—"} athletes</div>
          </div>
        </div>
      `;
    }).join("");

    return `
      <div class="div-card">
        <div class="div-card-hdr">
          <div class="div-card-title">${jas.team} — ${jas.division}</div>
          <div class="div-card-meta">${divTeams.length} Team${divTeams.length === 1 ? " (Unopposed)" : "s"} • Panel ${jas.panel}</div>
        </div>
        <div>${rowsHtml}</div>
      </div>
    `;
  }).join("");
}

function renderFullHallSection() {
  if (currentViewMode !== "full") return;

  const live = getActiveLive();
  const rawSearch = $("hall-search").value || "";
  const q = rawSearch.trim().toLowerCase();
  $("btn-clear-search").style.display = rawSearch.length > 0 ? "flex" : "none";
  $("btn-jump-live").style.display = (live && live.order) ? "inline-block" : "none";

  const jasDivMap = new Map();
  ENTRIES.filter(e => e.date === currentDay && e.is_jas).forEach(j => jasDivMap.set(j.division, j.team));

  const dayEntries = ENTRIES.filter(e => e.date === currentDay);
  let rows = dayEntries;

  if (currentQuickFilter === "jas") {
    rows = rows.filter(e => e.is_jas);
  } else if (currentQuickFilter === "rivals") {
    rows = rows.filter(e => e.is_jas || jasDivMap.has(e.division));
  }

  if (q) {
    const qDigits = q.replace(/^#/, "");
    rows = rows.filter(e =>
      String(e.order) === qDigits ||
      String(e.order).includes(q) ||
      (e.program && e.program.toLowerCase().includes(q)) ||
      (e.team && e.team.toLowerCase().includes(q)) ||
      (e.division && e.division.toLowerCase().includes(q)) ||
      (e.location && e.location.toLowerCase().includes(q)) ||
      (e.compete && e.compete.toLowerCase().includes(q)) ||
      (e.panel && ("panel " + e.panel.toLowerCase()).includes(q))
    );
  }

  $("full-hall-count").textContent = rows.length === dayEntries.length
    ? `${rows.length} entries`
    : `${rows.length} of ${dayEntries.length}`;

  const canSpot = Boolean(spotterSessionId);

  if (!rows.length) {
    $("full-hall-container").innerHTML = `
      <div class="my-team-card" style="text-align:center; padding:18px;">
        <div class="mtc-div">No routines match "<strong>${rawSearch.replace(/[<>&"]/g, "")}</strong>" on ${currentDay === "2026-12-12" ? "Saturday" : "Sunday"}.</div>
      </div>`;
    return;
  }

  $("full-hall-container").innerHTML = rows.map(e => {
    if (e.is_break) {
      return `<div id="routine-row-${e.order}" class="feed-row break-row">⏸️ #${e.order} — ${e.program} (${e.compete})</div>`;
    }
    const isUs = e.is_jas;
    const rivalOf = !isUs ? jasDivMap.get(e.division) : null;
    const isPast = live && live.order && e.order < live.order;
    const isNow = live && live.order && e.order === live.order;
    const est = getAdjustedTime(e.compete, live);

    let cls = "feed-row";
    if (isUs) cls += starredTeams.includes(e.team) ? " starred-row" : " jas-row";
    else if (rivalOf) cls += " rival-row";
    if (isPast) cls += " past-row";
    if (isNow) cls += " live-now-row";

    let badge = "";
    if (isNow) badge += `<span class="tag-badge" style="background:rgba(34,197,94,0.22); color:#86efac; margin-right:4px;">🔥 ON MAT</span>`;
    if (isUs) badge += `<span class="tag-badge tag-jas">★ JAS TOMS RIVER</span>`;
    else if (rivalOf) badge += `<span class="tag-badge tag-rival">🏆 ${rivalOf} Rival</span>`;

    const spotBtn = canSpot
      ? `<button type="button" class="spot-btn" data-spot-order="${e.order}">📍 On Mat</button>`
      : "";

    const wuNote = e.warmup_checkin ? ` • WU ${e.warmup_checkin}` : "";

    return `
      <div id="routine-row-${e.order}" class="${cls}">
        <div class="fr-time">
          <div class="fr-sched">${e.compete}</div>
          ${est ? `<div class="fr-est">~${est}</div>` : ""}
          <div class="fr-order">#${e.order} • Pnl ${e.panel || "—"}</div>
        </div>
        <div class="fr-body">
          <div class="fr-title">${e.program}${e.team ? " — " + e.team : ""}</div>
          <div class="fr-sub">${e.division}${wuNote} • ${e.location}</div>
          ${badge}
        </div>
        ${spotBtn}
      </div>
    `;
  }).join("");

  if (canSpot) {
    document.querySelectorAll("[data-spot-order]").forEach(btn => {
      btn.addEventListener("click", () => pushLiveSpotterOrder(Number(btn.dataset.spotOrder)));
    });
  }
}

function renderSeasonModal() {
  const comps = APP_DATA.season.competitions;
  $("season-list").innerHTML = comps.map(c => {
    const activeBadge = c.event_id === APP_DATA.active_event_id
      ? `<span class="tag-badge tag-jas" style="margin-left:6px;">ACTIVE SCHEDULE LOADED</span>`
      : "";
    const scopeBadge = `<span style="color:#5eead4; font-weight:700;">${c.teams_attending}</span>`;
    const linkHtml = c.official_url
      ? `<a href="${c.official_url}" target="_blank" rel="noopener" class="link-btn" style="margin-left:6px;">Producer Page ↗</a>`
      : "";

    return `
      <div class="season-item">
        <div style="font-size:0.86rem; font-weight:800; color:#fff;">
          ${c.seq}. ${c.name} — <span style="color:var(--teal);">${c.dates_display}</span>${activeBadge}
        </div>
        <div style="font-size:0.74rem; color:var(--text-muted); margin-top:2px;">
          📍 ${c.venue_detail || c.location} • ${scopeBadge}
        </div>
        <div style="font-size:0.7rem; color:var(--text-dim); margin-top:3px;">
          📡 <strong>Schedule Radar:</strong> ${c.schedule_radar || "TBD"} ${linkHtml}
        </div>
      </div>
    `;
  }).join("");
}

function renderAll() {
  if (currentViewMode === "full") {
    renderFullHallSection();
  } else {
    renderLiveStrip();
    renderConflicts();
    renderTier1MyTeams();
    renderTier2JasFeed();
    renderRivalsSection();
  }
}

// ── .ICS Native Phone Calendar Generator ─────────────────────
function exportIcsCalendar() {
  const myAllDays = ENTRIES.filter(e => e.is_jas && starredTeams.includes(e.team));
  if (!myAllDays.length) return;

  const toIcsUtc = (dateStr, timeStr, offsetMins = 0) => {
    const mins = parseMinutes(timeStr);
    if (mins === null) return null;
    const [y, m, d] = dateStr.split("-").map(Number);
    const dt = new Date(y, m - 1, d, Math.floor(mins / 60), mins % 60, 0);
    dt.setMinutes(dt.getMinutes() + offsetMins);
    const pad = n => String(n).padStart(2, "0");
    return `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}T${pad(dt.getHours())}${pad(dt.getMinutes())}00`;
  };

  let lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Jersey All Stars Toms River//Day-Of Hub//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH"
  ];

  myAllDays.forEach(e => {
    const dtStart = toIcsUtc(e.date, e.warmup_checkin || e.compete, 0);
    const dtEnd = toIcsUtc(e.date, e.compete, 15);
    if (!dtStart || !dtEnd) return;
    lines.push(
      "BEGIN:VEVENT",
      `UID:jas2027-${EVENT.event_id}-${e.date}-${e.order}@jerseyallstars`,
      `DTSTART:${dtStart}`,
      `DTEND:${dtEnd}`,
      `SUMMARY:JAS ${e.team} (Mat ${e.compete} / WU ${e.warmup_checkin})`,
      `LOCATION:${EVENT.venue} (${EVENT.city_state})`,
      `DESCRIPTION:Jersey All Stars - ${e.team} (${e.division})\\nOrder #${e.order} | Panel ${e.panel}\\nWarm-Up Check-In: ${e.warmup_checkin}\\nFull Floor: ${e.full_floor}\\nCompete: ${e.compete}\\nCoach Meet: ${e.coach_meet_time || "TBD"}`,
      "BEGIN:VALARM",
      "TRIGGER:-PT30M",
      "ACTION:DISPLAY",
      `DESCRIPTION:${e.team} Warm-Up Check-In in 30 mins (${e.warmup_checkin})`,
      "END:VALARM",
      "END:VEVENT"
    );
  });

  lines.push("END:VCALENDAR");
  const blob = new Blob([lines.join("\r\n")], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `JAS_${starredTeams.join("_").replace(/\s+/g, "")}_Encore2026.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ── Firebase Live Sync & Spotter Broadcast ───────────────────
function initFirebase() {
  try {
    const firebaseConfig = {
      apiKey: "AIzaSyC82EM0Ls3itLCuAVkq2GrcTMcLUp7_7As",
      authDomain: "jersey-all-stars.firebaseapp.com",
      databaseURL: "https://jersey-all-stars-default-rtdb.firebaseio.com",
      projectId: "jersey-all-stars",
      appId: "1:823754984830:web:f1036a1ab8f66b188c772f"
    };
    const app = initializeApp(firebaseConfig);
    db = getDatabase(app);

    if (spotterSessionId) {
      $("cloud-locked-row").style.display = "none";
      $("cloud-unlocked-row").style.display = "block";
    }

    const liveRef = ref(db, `jas2027_live/${APP_DATA.active_event_id}/hall_c`);
    onValue(liveRef, snap => {
      const val = snap.val();
      const chip = $("conn-chip");
      if (val && val.order) {
        cloudLiveState = { ...val, mode: "cloud" };
        localStorage.setItem(LS_LAST_LIVE, JSON.stringify(cloudLiveState));
        chip.classList.add("live");
        $("conn-text").textContent = "Live Pulse";
      } else {
        cloudLiveState = null;
        localStorage.removeItem(LS_LAST_LIVE);
        chip.classList.remove("live");
        $("conn-text").textContent = navigator.onLine ? "Online • Cached" : "Offline Mode";
      }
      renderAll();
    }, () => {
      $("conn-text").textContent = "Offline Mode";
    });
  } catch (err) {
    console.warn("Firebase offline fallback:", err);
  }
}

async function unlockSpotterPin() {
  const pin = ($("spotter-pin-input").value || "").trim();
  if (!pin || !db) return;
  $("spotter-msg").textContent = "Verifying PIN...";
  try {
    const sess = "sess_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    const hash = await sha256Hex("jas-tr-2027:" + pin);
    await set(ref(db, `jas2027_auth/${sess}`), hash);
    spotterSessionId = sess;
    localStorage.setItem(LS_SPOTTER_SESSION, sess);
    $("cloud-locked-row").style.display = "none";
    $("cloud-unlocked-row").style.display = "block";
    $("spotter-msg").textContent = "Spotter PIN verified!";
    renderAll();
  } catch (e) {
    $("spotter-msg").textContent = "Invalid PIN (or offline). Use 🧪 Preview Local for offline testing.";
  }
}

async function pushLiveSpotterOrder(orderNum) {
  if (!db || !spotterSessionId) return;
  const entry = ENTRIES.find(e => e.date === currentDay && e.order === orderNum);
  if (!entry) {
    $("spotter-msg").textContent = `Order #${orderNum} not found on ${currentDay}.`;
    return;
  }

  const now = new Date();
  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  let driftMin = 0;
  if (todayIso === currentDay) {
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const schedMins = parseMinutes(entry.compete);
    if (schedMins !== null) driftMin = nowMins - schedMins;
  } else {
    driftMin = Number($("sim-drift-input").value || 0);
  }

  try {
    simLiveState = null;
    await set(ref(db, `jas2027_live/${APP_DATA.active_event_id}/hall_c`), {
      order: orderNum,
      date: currentDay,
      driftMin,
      updatedAt: Date.now(),
      sessionId: spotterSessionId
    });
    $("spotter-msg").textContent = `Broadcasted #${orderNum} (${entry.program} ${entry.team}) • Drift ${driftMin >= 0 ? "+" : ""}${driftMin}m`;
  } catch (e) {
    $("spotter-msg").textContent = `Broadcast error: ${e.message}`;
  }
}

async function clearLiveSpotter() {
  if (!db || !spotterSessionId) return;
  try {
    await set(ref(db, `jas2027_live/${APP_DATA.active_event_id}/hall_c`), {
      order: 0,
      date: currentDay,
      driftMin: 0,
      updatedAt: Date.now(),
      sessionId: spotterSessionId
    });
    $("spotter-msg").textContent = "Cleared live stage broadcast.";
  } catch (e) {
    $("spotter-msg").textContent = `Clear failed: ${e.message}`;
  }
}

function toggleSpotterPanel() {
  const p = $("spotter-panel");
  p.style.display = p.style.display === "none" ? "block" : "none";
  if (p.style.display === "block") {
    p.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

// ── UI Wire-Up ───────────────────────────────────────────────
$("btn-mode-hub").addEventListener("click", () => setViewMode("hub"));
$("btn-mode-full").addEventListener("click", () => setViewMode("full"));

$("btn-teams-toggle").addEventListener("click", () => {
  const el = $("picker-card");
  el.style.display = el.style.display === "none" ? "block" : "none";
});
$("btn-picker-done").addEventListener("click", () => {
  $("picker-card").style.display = "none";
});
$("btn-select-all").addEventListener("click", () => {
  starredTeams = APP_DATA.season.jas_roster.map(r => r.team);
  localStorage.setItem(LS_STARRED, JSON.stringify(starredTeams));
  renderTeamChips();
  renderAll();
});
$("btn-clear-teams").addEventListener("click", () => {
  starredTeams = [];
  localStorage.setItem(LS_STARRED, JSON.stringify(starredTeams));
  renderTeamChips();
  renderAll();
});

document.querySelectorAll(".day-tab").forEach(btn => {
  btn.addEventListener("click", () => {
    currentDay = btn.dataset.date;
    syncDayTabsUI();
    renderAll();
  });
});

document.querySelectorAll(".tier-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    currentTier = Number(btn.dataset.tier);
    localStorage.setItem(LS_TIER, String(currentTier));
    syncTierButtons();
    renderAll();
  });
});

document.querySelectorAll("[data-qfilter]").forEach(btn => {
  btn.addEventListener("click", () => {
    currentQuickFilter = btn.dataset.qfilter;
    document.querySelectorAll("[data-qfilter]").forEach(b =>
      b.classList.toggle("active", b.dataset.qfilter === currentQuickFilter)
    );
    renderFullHallSection();
  });
});

$("hall-search").addEventListener("input", () => renderFullHallSection());
$("btn-clear-search").addEventListener("click", () => {
  $("hall-search").value = "";
  $("hall-search").focus();
  renderFullHallSection();
});

$("btn-jump-live").addEventListener("click", () => {
  const live = getActiveLive();
  if (!live || !live.order) return;
  if (currentQuickFilter !== "all" || $("hall-search").value) {
    currentQuickFilter = "all";
    $("hall-search").value = "";
    document.querySelectorAll("[data-qfilter]").forEach(b =>
      b.classList.toggle("active", b.dataset.qfilter === "all")
    );
    renderFullHallSection();
  }
  const row = document.getElementById(`routine-row-${live.order}`);
  if (row) row.scrollIntoView({ behavior: "smooth", block: "center" });
});

$("btn-ics").addEventListener("click", exportIcsCalendar);

$("btn-season").addEventListener("click", () => { $("season-modal").style.display = "flex"; });
$("btn-close-season").addEventListener("click", () => { $("season-modal").style.display = "none"; });
$("season-modal").addEventListener("click", e => { if (e.target === $("season-modal")) $("season-modal").style.display = "none"; });

$("btn-share-update").addEventListener("click", () => { $("update-modal").style.display = "flex"; });
$("btn-close-update").addEventListener("click", () => { $("update-modal").style.display = "none"; });
$("update-modal").addEventListener("click", e => { if (e.target === $("update-modal")) $("update-modal").style.display = "none"; });

$("btn-spotter-drawer").addEventListener("click", toggleSpotterPanel);
$("btn-spotter-full").addEventListener("click", toggleSpotterPanel);
$("btn-close-spotter").addEventListener("click", () => { $("spotter-panel").style.display = "none"; });

$("btn-run-sim").addEventListener("click", () => {
  const ord = Number($("sim-order-input").value || 85);
  const drift = Number($("sim-drift-input").value || 0);
  simLiveState = { order: ord, date: currentDay, driftMin: drift, updatedAt: Date.now(), mode: "sim" };
  $("conn-chip").classList.add("sim");
  $("conn-text").textContent = "Sim Preview";
  renderAll();
});

$("btn-preset-sample").addEventListener("click", () => {
  currentDay = "2026-12-12";
  syncDayTabsUI();
  $("sim-order-input").value = "85";
  $("sim-drift-input").value = "14";
  simLiveState = { order: 85, date: "2026-12-12", driftMin: 14, updatedAt: Date.now(), mode: "sim" };
  $("conn-chip").classList.add("sim");
  $("conn-text").textContent = "Sim Preview";
  renderAll();
});

$("btn-clear-sim").addEventListener("click", () => {
  simLiveState = null;
  $("conn-chip").classList.remove("sim");
  $("conn-text").textContent = cloudLiveState ? "Live Pulse" : "Offline Ready";
  renderAll();
});

$("btn-unlock-pin").addEventListener("click", unlockSpotterPin);
$("btn-push-live").addEventListener("click", () => {
  const ord = Number($("live-order-input").value);
  if (ord > 0) pushLiveSpotterOrder(ord);
});
$("btn-clear-live").addEventListener("click", clearLiveSpotter);

loadData();
