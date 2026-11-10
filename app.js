// 보유 점검 모바일 — 화면.
//
// 계산은 하지 않는다. 서버가 새벽에 만든 결과(Store)를 읽어 보여 준다.
// 판정은 매매 룰 8가지로 코드가 정했고, Claude 의견은 참고 설명이다.
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
  const view = $('#view');

  const ACTIONS = ['전부 매도', '분할 매도', '매도 검토', '추가 매수 가능', '유지'];
  const ACTION_COLOR = {
    '전부 매도': '#F87171', '분할 매도': '#FB923C', '매도 검토': '#FBBF24', '추가 매수 가능': '#34D399', '유지': '#94A3B8',
  };
  const K = { pos: '#34D399', neg: '#F87171', warn: '#FBBF24', accent: '#60A5FA', text: '#E8EDF5', dim: '#8B98AC', mute: '#5A6678' };
  const STALE_DAYS = 4;       // 주말·연휴를 넘겨도 이보다 오래되면 서버가 멈춘 것이다
  const TREND_DAYS = 40;

  const S = { data: null, days: {}, dayBusy: {}, dayError: {}, loading: false, error: null, lastRoute: '', pending: '' };

  // ── 표기 ───────────────────────────────────────────────────
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ESC[c]);
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  function fnum(v, unit, digits, plus) {
    if (!isNum(v)) return '—';
    const d = digits || 0;
    const s = v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    return (plus && v > 0 ? '+' : '') + s + (unit || '');
  }
  const pct = (v) => fnum(v, '%', 1, true);
  const rateColor = (v) => (!isNum(v) || v === 0 ? K.dim : v > 0 ? K.pos : K.neg);
  const md = (iso) => (iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` : '—');
  const WEEK = '일월화수목금토';
  const mdw = (iso) => (iso ? `${md(iso)}(${WEEK[new Date(iso + 'T00:00:00+09:00').getDay()]})` : '—');
  const stamp = (ts) => (ts ? String(ts).slice(5, 16).replace('T', ' ') : '—');
  const ageDays = (ts) => (ts ? (Date.now() - new Date(ts).getTime()) / 864e5 : NaN);
  const color = (a) => ACTION_COLOR[a] || K.dim;

  function badge(text, c) {
    return `<span class="badge" style="background:${c}1F;color:${c};border:1px solid ${c}44">${esc(text)}</span>`;
  }
  const actionBadge = (a) => badge(a, color(a));
  const caveat = (text, cls) => `<div class="caveat ${cls || ''}">${esc(text)}</div>`;
  const kv = (k, v) => `<div class="kv"><span>${esc(k)}</span><span>${v}</span></div>`;
  function safeUrl(u) {
    try {
      const url = new URL(u);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch (e) { return null; }
  }

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove('show'), 2600);
  }

  // ── 자료 ───────────────────────────────────────────────────
  const ERR_TEXT = {
    auth: '토큰이 거부됐습니다. 만료됐거나 잘못 입력됐습니다.',
    notfound: '결과 파일을 읽을 수 없습니다. 토큰에 holdings-daily-data 저장소의 Contents 읽기 권한이 있는지 확인해 주세요.',
    limited: 'GitHub 요청 한도에 걸렸습니다. 잠시 뒤 다시 해 주세요.',
    network: '통신이 안 됩니다. 연결을 확인해 주세요.',
  };
  const errText = (e) => ERR_TEXT[e && e.kind] || `서버 오류 (${(e && e.status) || '알 수 없음'})`;

  const dayEntry = (on) => (S.data ? S.data.index.days.find((d) => d.on === on) : null);

  // 그날 파일을 한 번만 받는다. 실패하면 다시 시도 버튼을 누를 때까지 받지 않는다.
  async function loadDay(on) {
    if (S.dayBusy[on] || S.dayError[on]) return;
    S.dayBusy[on] = true;
    try {
      S.days[on] = await Store.day(on, (dayEntry(on) || {}).generated);
    } catch (e) {
      S.dayError[on] = e;
    } finally {
      S.dayBusy[on] = false;
    }
    render();
  }

  // 목록이 새로 왔으면 생성 시각이 바뀐 날은 다시 받게 한다
  function dropStaleDays() {
    for (const on of Object.keys(S.days)) {
      if (S.days[on].generated !== (dayEntry(on) || {}).generated) delete S.days[on];
    }
    S.dayError = {};
  }

  function dayOrLoad(on) {
    if (S.days[on]) return { day: S.days[on] };
    if (S.dayError[on]) {
      return { html: `<div class="empty">${esc(errText(S.dayError[on]))}<br><br><button class="btn" data-act="day-retry" data-on="${esc(on)}">다시 시도</button></div>` };
    }
    loadDay(on);
    return { html: '<div class="empty">불러오는 중…</div>' };
  }

  async function refresh(force, manual) {
    if (S.loading) return;
    S.loading = true;
    $('#refresh').classList.add('spin');
    try {
      const res = await Store.refresh(S.data && S.data.index.generated, force);
      S.error = null;
      if (res.changed) {
        S.data = res.data;
        dropStaleDays();
        if (manual) toast('새 결과를 받았습니다');
      } else if (manual) {
        toast('이미 최신입니다');
      }
    } catch (e) {
      S.error = e;
      if (S.data) toast(e.kind === 'network' ? '오프라인이라 마지막으로 받은 결과를 보여 줍니다' : errText(e));
    } finally {
      S.loading = false;
      $('#refresh').classList.remove('spin');
      render();
    }
  }

  // ── 연결 설정 ──────────────────────────────────────────────
  function setupView() {
    return `
      <h2>연결 설정</h2>
      <div class="note">점검 결과는 비공개 저장소에 있습니다. 이 기기가 읽을 수 있게 <b>읽기 전용 토큰</b>을 한 번만 넣습니다.
        토큰은 이 기기 안에만 저장되고 GitHub 말고는 어디에도 보내지 않습니다.</div>
      <div class="card">
        <ol class="steps">
          <li>GitHub → Settings → Developer settings → Personal access tokens → <b>Fine-grained tokens</b> → Generate new token</li>
          <li>Repository access: <b>Only select repositories</b> → <span class="num">${esc(Store.REPO)}</span></li>
          <li>Permissions → Repository permissions → <b>Contents: Read-only</b></li>
          <li>만들어진 토큰(<span class="num">github_pat_…</span>)을 아래에 붙여 넣습니다</li>
        </ol>
        <form data-form="token">
          <label class="field"><span>토큰</span>
            <input type="password" name="token" placeholder="github_pat_…" autocomplete="off" autocapitalize="off" spellcheck="false" required></label>
          <button class="btn primary block" type="submit">${S.loading ? '확인 중…' : '연결'}</button>
        </form>
      </div>
      ${S.error ? caveat(errText(S.error), 'err') : ''}
      <div class="note">카카오톡 버튼으로 열면 카카오톡 안의 브라우저라 한 번 더 넣어야 할 수 있습니다.
        이 토큰으로는 결과 저장소를 읽는 것만 할 수 있습니다.</div>`;
  }

  async function connect(value) {
    const t = String(value || '').trim();
    if (!t || S.loading) return;
    Store.token.set(t);
    S.loading = true; S.error = null;
    render();
    try {
      const res = await Store.refresh(null, true);
      S.data = res.data;
      dropStaleDays();
    } catch (e) {
      S.error = e;
      // 틀린 토큰을 저장해 두면 다음 실행 때 빈 화면에 갇힌다
      if (e.kind === 'auth' || e.kind === 'notfound') Store.token.clear();
    } finally {
      S.loading = false;
      render();
    }
  }

  // ── 📋 그날 점검 ───────────────────────────────────────────
  function countTiles(counts) {
    const tiles = ACTIONS.filter((a) => counts[a]).map((a) =>
      `<div class="count" style="border-color:${color(a)}44"><div class="n" style="color:${color(a)}">${counts[a]}</div>` +
      `<div class="l">${esc(a)}</div></div>`);
    return `<div class="counts">${tiles.join('')}</div>`;
  }

  function stockCard(s, on) {
    const top = s.actions[0];
    const o = s.opinion;
    const c = s.consensus || {};
    const consChips = ['op26', 'op27'].filter((k) => c[k] && Math.abs(c[k].pct) >= 10)
      .map((k) => `<span class="chip" style="color:${rateColor(c[k].pct)}">${k === 'op26' ? '26E' : '27E'} ${pct(c[k].pct)}</span>`);
    return `<a class="card" href="#/stock/${esc(s.code)}/${esc(on)}" style="border-left:3px solid ${color(top)}">
      <div class="stock-head">
        <span class="stock-name">${esc(s.name)}</span>
        <span class="stock-code">${esc(s.code)}</span>
        <span class="rate stock-rate" style="color:${rateColor(s.rate)}">${pct(s.rate)}</span>
      </div>
      <div class="badges">${s.actions.map(actionBadge).join('')}</div>
      <div class="sub">비중 ${fnum(s.weight, '%', 1)} · 손절가 ${fnum(s.stop_price, '원')}</div>
      ${o && o.headline ? `<div class="headline">${o.changed ? '<span class="new">새 소식</span>' : ''}${esc(o.headline)}</div>` : ''}
      ${consChips.length ? `<div class="chips">${consChips.join('')}</div>` : ''}
    </a>`;
  }

  // 확인 필요가 길면 접어 둔다
  function warningBox(items) {
    if (!items || !items.length) return '';
    const list = items.map(esc).join('<br>');
    if (items.length <= 3) return `<div class="caveat">확인 필요<br>${list}</div>`;
    return `<details class="caveat"><summary>확인 필요 ${items.length}건</summary>${list}</details>`;
  }

  function section(title, items) {
    if (!items || !items.length) return '';
    return `<h3>${esc(title)}</h3><div class="card"><ul class="list">${items.map((t) => `<li>${t}</li>`).join('')}</ul></div>`;
  }

  function dayView(on) {
    const days = S.data.index.days;
    if (!on) on = S.data.index.latest;
    if (!dayEntry(on)) return `<div class="empty">${esc(on)} 점검 기록이 없습니다.<br><br><a class="btn" href="#/day">최근 점검 보기</a></div>`;
    const got = dayOrLoad(on);
    if (!got.day) return got.html;
    const day = got.day;

    const i = days.findIndex((d) => d.on === on);
    const newer = days[i - 1], older = days[i + 1];
    const cons = day.consensus;
    return `
      <div class="day-nav">
        <a class="${older ? '' : 'off'}" href="#/day/${esc(older ? older.on : '')}">‹ ${older ? mdw(older.on) : ''}</a>
        <a class="${newer ? '' : 'off'}" href="#/day/${esc(newer ? newer.on : '')}">${newer ? mdw(newer.on) : ''} ›</a>
      </div>
      <div class="day-head"><h2>${mdw(day.created_on)} 아침 점검</h2><span class="sub mute">${md(day.trade_date)} 종가 기준</span></div>
      ${countTiles(day.counts)}
      <div class="sub">증권사별 판정 ${Object.values(day.counts).reduce((a, b) => a + b, 0)}건 · 종목 ${day.stocks.length} · 현금 비중 ${fnum(day.cash_ratio, '%', 1)}${day.usage ? ` · Claude 의견 ${day.usage.opinions}종목` : ''}</div>
      ${warningBox(day.warnings)}
      ${section('판정 변화', day.changes.map((c) => `<b>${esc(c.label)}</b> ${esc(c.before)} → ${esc(c.after)}`))}
      ${section('룰 알림', day.alerts.map(esc))}
      ${cons ? section('컨센 변화(1개월, ±10%)', cons.alerts.map((a) =>
        `<b>${esc(a.name)}</b> ${esc(a.item)} ${fnum(a.before)}→${fnum(a.now)}억 <span style="color:${rateColor(a.pct)}">${pct(a.pct)}</span>${a.is_new ? ' · 새로 넘음' : ''}`)) : ''}
      <h3>종목 ${day.stocks.length}</h3>
      ${day.stocks.map((s) => stockCard(s, on)).join('')}
      <div class="foot">판정은 매매 룰 8가지로 코드가 정했습니다. Claude 의견은 판단을 돕는 참고 설명이고 매매 권유가 아닙니다.
        생성 ${stamp(day.generated)}</div>`;
  }

  // ── 🔬 종목 상세 ───────────────────────────────────────────
  function trendSvg(points) {
    if (points.length < 2) return '';
    const W = 320, H = 110, P = 10;
    const rates = points.map((p) => p.r).filter(isNum);
    let lo = Math.min(0, ...rates), hi = Math.max(0, ...rates);
    if (hi - lo < 10) { const m = (hi + lo) / 2; lo = m - 5; hi = m + 5; }
    const x = (i) => P + (i * (W - 2 * P)) / (points.length - 1);
    const y = (v) => P + ((hi - v) * (H - 2 * P)) / (hi - lo);
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.r).toFixed(1)}`).join('');
    const dots = points.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.r).toFixed(1)}" r="3.2" fill="${color(p.a)}"/>`).join('');
    return `<svg class="trend" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="손익률 흐름">
      <line x1="${P}" x2="${W - P}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" stroke="rgba(255,255,255,.15)" stroke-dasharray="3 4"/>
      <path d="${line}" fill="none" stroke="${K.dim}" stroke-width="1.6" vector-effect="non-scaling-stroke"/>${dots}</svg>`;
  }

  function opBlock(label, text, cls) {
    if (!text) return '';
    return `<div class="op-block ${cls || ''}"><div class="tile-label">${esc(label)}</div><div class="op-text">${esc(text)}</div></div>`;
  }

  function stockView(code, on) {
    if (!on) on = S.data.index.latest;
    if (!dayEntry(on)) return `<div class="empty">${esc(on)} 점검 기록이 없습니다.</div>`;
    const got = dayOrLoad(on);
    if (!got.day) return got.html;
    const day = got.day;
    const s = day.stocks.find((x) => x.code === code);
    if (!s) return `<a class="back" href="#/day/${esc(on)}">‹ ${mdw(on)} 점검</a><div class="empty">이날 점검에 없는 종목입니다.</div>`;
    const o = s.opinion;
    const c = s.consensus;
    const hist = ((S.data.history[code] || {}).days || []).slice(-TREND_DAYS);
    const sources = (o && o.sources || []).map(safeUrl).filter(Boolean);
    const host = (u) => {
      try {
        const url = new URL(u);
        let path = url.pathname.replace(/\/$/, '');
        try { path = decodeURIComponent(path); } catch (e) { /* 그대로 */ }
        return url.hostname.replace(/^www\./, '') + (path ? ' ' + (path.length > 26 ? path.slice(0, 26) + '…' : path) : '');
      } catch (e) { return u; }
    };

    return `
      <a class="back" href="#/day/${esc(on)}">‹ ${mdw(on)} 점검</a>
      <div class="card" style="border-left:3px solid ${color(s.actions[0])}">
        <div class="stock-head">
          <span class="stock-name">${esc(s.name)}</span>
          <span class="stock-code">${esc(s.code)}${c && c.sector ? ' · ' + esc(c.sector) : ''}</span>
          <span class="rate stock-rate" style="color:${rateColor(s.rate)}">${pct(s.rate)}</span>
        </div>
        <div class="badges">${s.actions.map(actionBadge).join('')}</div>
        <div class="sub">비중 ${fnum(s.weight, '%', 1)} · 손절가 ${fnum(s.stop_price, '원')} · ${md(day.trade_date)} 종가 기준</div>
      </div>

      <h3>판정</h3>
      <div class="card">${s.verdicts.map((v) => `
        <div class="verdict">
          <div class="verdict-top">${actionBadge(v.action)}<span class="broker">${esc(v.broker)}</span>
            <span class="rate" style="color:${rateColor(v.rate)}">${pct(v.rate)}</span></div>
          ${(v.reasons && v.reasons.length) || v.breach_days || v.reevaluated ? `<ul class="reasons">
            ${(v.reasons || []).map((r) => `<li>${esc(r)}</li>`).join('')}
            ${v.breach_days ? `<li>원래 룰 이탈 ${v.breach_days}일째</li>` : ''}
            ${v.reevaluated ? '<li>재평가 반영</li>' : ''}</ul>` : ''}
        </div>`).join('')}
      </div>

      ${c && (c.op26 || c.op27) ? `<h3>컨센 1개월</h3><div class="card">
        ${['op26', 'op27'].filter((k) => c[k]).map((k) => kv(`${k === 'op26' ? '26E' : '27E'} 영업이익`,
          `${fnum(c[k].before)}→${fnum(c[k].now)}억 <span style="color:${rateColor(c[k].pct)}">${pct(c[k].pct)}</span>`)).join('')}</div>` : ''}

      <h3>Claude 의견${o && o.changed ? ' ' + badge('새 소식', K.warn) : ''}</h3>
      ${o ? `<div class="card">
        ${o.headline ? `<div class="headline" style="margin-top:0"><b>${esc(o.headline)}</b></div>` : ''}
        ${opBlock('최근 소식', o.news)}
        ${opBlock('유지 근거', o.bull, 'bull')}
        ${opBlock('반대 근거', o.bear, 'bear')}
        ${opBlock('확인할 것', o.watch, 'watch')}
        ${sources.length ? `<div class="tile-label" style="margin-top:12px">출처</div><div class="sources">
          ${sources.map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(host(u))} ↗</a>`).join('')}</div>` : ''}
      </div>` : '<div class="card"><div class="sub mute">이날은 의견이 없습니다.</div></div>'}

      ${s.reason ? `<h3>내 유지이유</h3><div class="card"><div class="op-text">${esc(s.reason)}</div></div>` : ''}

      ${hist.length ? `<h3>흐름 (최근 ${hist.length}거래일)</h3><div class="card">
        ${trendSvg(hist)}
        ${hist.slice().reverse().slice(0, 12).map((p) => `<a class="hist-row" href="#/stock/${esc(code)}/${esc(p.on)}">
          <span class="d">${md(p.d)}</span><span class="a">${actionBadge(p.a)}</span>
          <span class="rate" style="color:${rateColor(p.r)}">${pct(p.r)}</span>
          <span class="h">${esc(p.h || '')}</span></a>`).join('')}
      </div>` : ''}
      <div class="foot">판정은 매매 룰 8가지로 코드가 정했습니다. Claude 의견은 참고 설명이고 매매 권유가 아닙니다.</div>`;
  }

  // ── 🗓️ 기록 ────────────────────────────────────────────────
  function historyView() {
    const days = S.data.index.days;
    return `<h2>점검 기록</h2><div class="note">날짜를 누르면 그날 점검을 봅니다. 점은 종목별 판정입니다.</div>
      ${days.map((d) => {
        const dots = ACTIONS.flatMap((a) => Array(d.counts[a] || 0).fill(a))
          .map((a) => `<i style="background:${color(a)}" title="${esc(a)}"></i>`).join('');
        const strong = ACTIONS.slice(0, 3).filter((a) => d.counts[a]).map((a) => `${a} ${d.counts[a]}`).join(' · ');
        return `<a class="card day-row" href="#/day/${esc(d.on)}">
          <span class="when"><b>${mdw(d.on)}</b><div class="sub">${md(d.trade_date)} 종가${strong ? ' · ' + esc(strong) : ''}</div></span>
          <span class="mini-dots">${dots}</span></a>`;
      }).join('')}`;
  }

  // ── ⚙️ 설정 ────────────────────────────────────────────────
  function settingsView() {
    const connected = !!Store.token.get();
    const confirm = S.pending === 'token-clear';
    return `<h2>설정</h2>
      <div class="card">
        ${kv('결과 저장소', `<span class="num">${esc(Store.REPO)}</span>`)}
        ${kv('마지막 점검', esc(stamp(S.data.index.generated)))}
        ${kv('보관한 날짜', `${S.data.index.days.length}일`)}
        ${kv('앱 버전', esc(self.APP_VERSION || 'dev'))}
      </div>
      <div class="btn-row">
        <button class="btn sm" data-act="refresh-force">전부 다시 받기</button>
        ${connected ? `<button class="btn sm danger" data-act="token-clear">${confirm ? '정말 해제 — 토큰과 받은 결과 삭제' : '연결 해제'}</button>` : ''}
      </div>
      <div class="note">판정은 서버가 평일 새벽 1시에 직전 거래일 종가로 매매 룰 8가지를 적용해 정합니다.
        이 앱은 그 결과를 보여 주기만 하고 아무것도 바꾸지 않습니다.</div>`;
  }

  // ── 화면 전환 ──────────────────────────────────────────────
  function route() {
    const parts = (location.hash || '#/day').replace(/^#\/?/, '').split('/');
    return { name: parts[0] || 'day', arg: parts[1] || '', arg2: parts[2] || '' };
  }

  function statusBanner() {
    if (S.error && S.error.kind !== 'network') return caveat(errText(S.error), 'err');
    const age = ageDays(S.data.index.generated);
    return age > STALE_DAYS ? caveat(`마지막 점검이 ${Math.floor(age)}일 전입니다. 서버를 확인해 주세요.`) : '';
  }

  function render() {
    const setup = Store.needsToken();
    document.body.classList.toggle('setup', setup);
    const sub = $('#bar-sub');
    if (setup) {
      sub.textContent = '매매 룰 8가지 · 매일 아침'; sub.classList.remove('stale');
      view.innerHTML = setupView();
      return;
    }
    const r = route();
    const tab = r.name === 'stock' ? 'day' : r.name;
    document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('on', a.dataset.tab === tab));

    if (!S.data) {
      view.innerHTML = S.error && !S.loading
        ? `<div class="empty">${esc(errText(S.error))}<br><br><button class="btn" data-act="refresh">다시 시도</button>
            ${Store.token.get() ? '<br><br><button class="btn sm danger" data-act="token-clear">토큰 다시 입력</button>' : ''}</div>`
        : '<div class="empty">결과를 받는 중…</div>';
      return;
    }
    const idx = S.data.index;
    sub.textContent = `점검 ${stamp(idx.generated)}${S.error && S.error.kind === 'network' ? ' · 오프라인' : ''}`;
    sub.classList.toggle('stale', ageDays(idx.generated) > STALE_DAYS);

    let body;
    if (r.name === 'stock') body = stockView(r.arg, r.arg2);
    else if (r.name === 'history') body = historyView();
    else if (r.name === 'settings') body = settingsView();
    else body = dayView(r.arg);
    view.innerHTML = statusBanner() + body;

    const key = location.hash;
    if (key !== S.lastRoute) { S.lastRoute = key; window.scrollTo(0, 0); }
  }

  // ── 입력 처리 ──────────────────────────────────────────────
  const ACTS = {
    refresh: () => refresh(false, true),
    'day-retry': (el) => { delete S.dayError[el.dataset.on]; render(); },
    'refresh-force': async () => {
      try { await Store.clearCache(); } catch (e) { /* 무시 */ }
      S.days = {}; S.dayError = {};
      refresh(true, true);
    },
    'token-clear': async () => {
      if (S.pending !== 'token-clear') { S.pending = 'token-clear'; render(); return; }
      Store.token.clear();
      try { await Store.clearCache(); } catch (e) { /* 무시 */ }
      S.data = null; S.days = {}; S.dayError = {}; S.error = null; S.pending = '';
      render();
    },
  };

  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]');
    if (!el) return;
    const fn = ACTS[el.dataset.act];
    if (!fn) return;
    ev.preventDefault();
    if (S.pending && el.dataset.act !== 'token-clear') S.pending = '';
    fn(el);
  });

  document.addEventListener('submit', (ev) => {
    const form = ev.target.closest('[data-form]');
    if (!form) return;
    ev.preventDefault();
    if (form.dataset.form === 'token') connect(new FormData(form).get('token'));
  });

  // 탭 전환은 방문 기록을 쌓지 않는다. 뒤로 가기는 종목 상세에서 나올 때만 쓰인다.
  $('#tabs').addEventListener('click', (ev) => {
    const a = ev.target.closest('a');
    if (!a) return;
    ev.preventDefault();
    location.replace(a.getAttribute('href'));
  });

  window.addEventListener('hashchange', () => { S.pending = ''; render(); });

  // 앱으로 돌아왔을 때 몇 시간 지났으면 다시 받는다
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.data && !Store.needsToken()) refresh(false, false);
  });

  // ── 시작 ───────────────────────────────────────────────────
  (async function boot() {
    render();
    if (Store.needsToken()) return;
    const cached = await Store.loadCached();
    if (cached) { S.data = cached; render(); }
    refresh(false, false);
  })();
})();
