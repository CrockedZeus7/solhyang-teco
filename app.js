/* =========================
   설정
========================= */
const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vRP87eWUxufllUjacy-JEz-BCjpu84kx81tpm0Gby7Xupfa5J3YITrbqc-aLfRflkLVgytimAxpexpk/pub?output=csv";

const AUTO_REFRESH_MS = 30000;

// 헤더가 "이름 (ex. 홍길동)"처럼 오므로 prefix로 매칭합니다.
const HEADER_PREFIX = {
  name: "이름",
  studentId: "학번",
  nick: "리더보드에 표시할 닉네임",
  record: "기록",
};
/* ========================= */

const els = {
  refreshBtn: document.getElementById("refreshBtn"),
  searchInput: document.getElementById("searchInput"),
  statusText: document.getElementById("statusText"),
  lastUpdated: document.getElementById("lastUpdated"),
  countText: document.getElementById("countText"),
  top3: document.getElementById("top3"),
  list: document.getElementById("list"),
  emptyState: document.getElementById("emptyState"),
  debugBox: document.getElementById("debugBox"),
};

let rawRows = [];
let timerId = null;

/* ---------- UI helpers ---------- */
function setStatus(msg) {
  els.statusText.textContent = msg;
}
function setUpdatedNow() {
  els.lastUpdated.textContent = new Date().toLocaleString("ko-KR");
}
function showDebug(text) {
  els.debugBox.classList.remove("hidden");
  els.debugBox.textContent = text;
}
function clearDebug() {
  els.debugBox.classList.add("hidden");
  els.debugBox.textContent = "";
}

/* ---------- Utils ---------- */
function withNoCache(url) {
  const u = new URL(url);
  u.searchParams.set("t", Date.now().toString());
  return u.toString();
}
function normalizeHeader(h) {
  return (h ?? "").toString().replace(/^\uFEFF/, "").trim();
}
function simplify(s) {
  return normalizeHeader(s).replace(/\s+/g, "");
}
function escapeHtml(s) {
  return (s ?? "").toString()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
function displayName(r) {
  return (r.nick || r.name || "이름 없음").trim();
}

/* ---------- 기록 파싱/표시 ----------
   입력:  "1분 30초 12"
   해석:  1분 + 30초 + 0.12초 (12 = 1/100초)
   표시:  "1분 30초 12" 형태로 고정
---------------------------------- */
function parseRecordToSeconds(v) {
  const s = (v ?? "").toString().trim();
  if (!s) return null;

  // ✅ 메인 포맷: 1분 30초 12
  const main = s.match(/^\s*(\d+)\s*분\s*(\d+)\s*초\s*(\d+)\s*$/);
  if (main) {
    const min = Number(main[1]);
    const sec = Number(main[2]);
    const cs  = Number(main[3]); // centiseconds
    if ([min, sec, cs].every(Number.isFinite)) return min * 60 + sec + cs / 100;
  }

  // 보조 포맷도 그냥 지원(혹시 실수로 이렇게 입력해도 죽지 않게)
  const mmss = s.match(/^\s*(\d+)\s*:\s*(\d+(?:\.\d+)?)\s*$/);
  if (mmss) {
    const min = Number(mmss[1]);
    const sec = Number(mmss[2]);
    if ([min, sec].every(Number.isFinite)) return min * 60 + sec;
  }

  const text = s.match(/^\s*(\d+)\s*분\s*(\d+(?:\.\d+)?)\s*초\s*$/);
  if (text) {
    const min = Number(text[1]);
    const sec = Number(text[2]);
    if ([min, sec].every(Number.isFinite)) return min * 60 + sec;
  }

  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function formatSecondsToMinSecCs(totalSeconds) {
  // totalSeconds -> "X분 Y초 ZZ"
  let sec = totalSeconds;

  // 반올림해서 센티초 단위로 딱 맞추기
  let totalCs = Math.round(sec * 100); // centiseconds
  let minutes = Math.floor(totalCs / (60 * 100));
  totalCs -= minutes * 60 * 100;

  let seconds = Math.floor(totalCs / 100);
  totalCs -= seconds * 100;

  let cs = totalCs; // 0~99

  // 보정(극단 케이스)
  if (cs >= 100) { cs = 0; seconds += 1; }
  if (seconds >= 60) { seconds = 0; minutes += 1; }

  return `${minutes}분 ${seconds}초 ${String(cs).padStart(2, "0")}`;
}

/* ---------- 헤더 매핑 ---------- */
function buildHeaderMap(data) {
  const first = data?.[0] || {};
  const headers = Object.keys(first).map(normalizeHeader);

  const findByPrefix = (prefix) => {
    const p = simplify(prefix);
    return headers.find(h => simplify(h).startsWith(p)) || null;
  };

  const map = {
    name: findByPrefix(HEADER_PREFIX.name),
    studentId: findByPrefix(HEADER_PREFIX.studentId),
    nick: findByPrefix(HEADER_PREFIX.nick),
    record: findByPrefix(HEADER_PREFIX.record),
  };

  return { headers, map };
}

function normalizeRows(data) {
  const { headers, map } = buildHeaderMap(data);

  const missing = [];
  if (!map.name) missing.push(HEADER_PREFIX.name);
  if (!map.studentId) missing.push(HEADER_PREFIX.studentId);
  if (!map.nick) missing.push(HEADER_PREFIX.nick);
  if (!map.record) missing.push(HEADER_PREFIX.record);

  if (missing.length) {
    showDebug(
      `헤더를 찾지 못했습니다.\n` +
      `필요: ${missing.join(", ")}\n\n` +
      `실제 CSV 헤더:\n- ${headers.join("\n- ")}`
    );
  } else {
    clearDebug();
  }

  const get = (row, key) => (key && row[key] != null) ? row[key] : "";

  // ✅ 기록이 비어도 명단은 유지합니다. (기록 없음 표시)
  return (data || []).map(row => {
    const name = (get(row, map.name) ?? "").toString().trim();
    const studentId = (get(row, map.studentId) ?? "").toString().trim();
    const nick = (get(row, map.nick) ?? "").toString().trim();
    const recordRaw = (get(row, map.record) ?? "").toString().trim();
    const seconds = parseRecordToSeconds(recordRaw);
    return { name, studentId, nick, recordRaw, seconds };
  }).filter(r => displayName(r));
}

/* ---------- BEST 모드 ---------- */
function keyForPerson(r) {
  if (r.nick?.trim()) return `N:${r.nick.trim()}`;
  return `S:${(r.name || "").trim()}|${(r.studentId || "").trim()}`;
}
function bestOnly(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = keyForPerson(r);
    const prev = map.get(key);
    if (!prev) { map.set(key, r); continue; }

    // 기록 있는 쪽 우선
    if (prev.seconds == null && r.seconds != null) { map.set(key, r); continue; }
    if (prev.seconds != null && r.seconds == null) continue;

    // 둘 다 기록 있으면 더 빠른 기록
    if (prev.seconds != null && r.seconds != null && r.seconds < prev.seconds) {
      map.set(key, r);
    }
  }
  return [...map.values()];
}

/* ---------- 정렬 안정화 ---------- */
function stableCompare(a, b) {
  // 기록 있는 사람 먼저
  if (a.seconds == null && b.seconds != null) return 1;
  if (a.seconds != null && b.seconds == null) return -1;

  // 둘 다 기록 있으면 오름차순
  if (a.seconds != null && b.seconds != null && a.seconds !== b.seconds) {
    return a.seconds - b.seconds;
  }

  // 동점/기록 없음: 닉네임/학번/이름으로 고정
  const n = (a.nick || "").localeCompare(b.nick || "", "ko");
  if (n !== 0) return n;
  const s = (a.studentId || "").localeCompare(b.studentId || "", "ko");
  if (s !== 0) return s;
  return (a.name || "").localeCompare(b.name || "", "ko");
}

/* ---------- Render ---------- */
function render() {
  const q = (els.searchInput.value || "").toLowerCase().trim();
  let rows = bestOnly(rawRows); // 항상 1인 1기록 기준

  if (q) {
    rows = rows.filter(r =>
      (r.nick || "").toLowerCase().includes(q) ||
      (r.name || "").toLowerCase().includes(q) ||
      (r.studentId || "").toLowerCase().includes(q)
    );
  }

  rows.sort(stableCompare);
  els.countText.textContent = `${rows.length}명`;

  if (rows.length === 0) {
    els.top3.innerHTML = "";
    els.list.innerHTML = "";
    els.emptyState.classList.remove("hidden");
    return;
  }
  els.emptyState.classList.add("hidden");

  // 명예의 전당은 기록 있는 사람만
  const ranked = rows.filter(r => r.seconds != null);
  const top3 = ranked.slice(0, 3);

  const medals = ["🥇", "🥈", "🥉"];
  const titles = ["1위", "2위", "3위"];

  els.top3.innerHTML = top3.map((r, idx) => {
    const medal = medals[idx] || "⭐";
    const title = titles[idx] || "TOP";
    const timeText = formatSecondsToMinSecCs(r.seconds);

    return `
      <div class="rounded-3xl p-4 bg-white/5 border border-white/10">
        <div class="flex items-center justify-between">
          <div class="text-sm font-semibold">${medal} ${title}</div>
          <div class="text-xs text-zinc-400">#${idx + 1}</div>
        </div>
        <div class="mt-2 text-lg font-bold truncate">${escapeHtml(displayName(r))}</div>
        <div class="mt-2 text-sm text-zinc-200 font-semibold">${escapeHtml(timeText)}</div>
        <div class="mt-1 text-xs text-zinc-400">🔥 명예의 전당</div>
      </div>
    `;
  }).join("") || `
    <div class="text-sm text-zinc-400">명예의 전당을 표시할 기록이 없습니다.</div>
  `;

  // 전체 리스트
  els.list.innerHTML = rows.map((r, i) => {
    const recordText = (r.seconds == null)
      ? "기록 없음"
      : formatSecondsToMinSecCs(r.seconds);

    const recordClass = (r.seconds == null) ? "text-zinc-400" : "text-zinc-50";

    return `
      <div class="rounded-3xl p-4 bg-white/5 border border-white/10">
        <div class="flex justify-between items-center gap-3">
          <div class="min-w-0">
            <div class="text-sm font-semibold truncate">#${i + 1} ${escapeHtml(displayName(r))}</div>
            <div class="text-xs text-zinc-400 truncate">${escapeHtml(r.studentId || "")}</div>
          </div>
          <div class="font-semibold whitespace-nowrap ${recordClass}">
            ${escapeHtml(recordText)}
          </div>
        </div>
      </div>
    `;
  }).join("");
}

/* ---------- Load ---------- */
async function loadData() {
  try {
    setStatus("불러오는 중입니다.");
    clearDebug();

    const res = await fetch(withNoCache(SHEET_CSV_URL), { cache: "no-store" });
    if (!res.ok) throw new Error(`CSV 요청 실패: ${res.status}`);

    const csvText = await res.text();
    const parsed = Papa.parse(csvText, {
      header: true,
      skipEmptyLines: true,
      transformHeader: normalizeHeader,
    });

    rawRows = normalizeRows(parsed.data || []);
    setStatus("업데이트되었습니다.");
    setUpdatedNow();
    render();
  } catch (e) {
    console.error(e);
    setStatus("불러오지 못했습니다.");
    showDebug(
      `오류가 발생했습니다.\n` +
      `메시지: ${String(e?.message || e)}\n\n` +
      `팁:\n- file:// 로 열면 fetch가 막힐 수 있어요.\n- 배포(Vercel/Netlify/GitHub Pages)나 로컬 서버로 열어주세요.`
    );
    rawRows = [];
    render();
  }
}

/* ---------- Init ---------- */
function initEvents() {
  els.refreshBtn.addEventListener("click", loadData);
  els.searchInput.addEventListener("input", render);
}

(function boot() {
  initEvents();
  loadData();
  timerId = setInterval(loadData, AUTO_REFRESH_MS);
})();
