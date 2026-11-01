'use strict';

(function () {
  // ─── Recurring ──────────────────────────────────────────────────────────────
  // The month's expected income, bills and transfers on a calendar, with every
  // schedule listed beside it. Drawn in Ant Design: the components are
  // static/css/ant.css and static/js/widgets/ant.js, the page layout is
  // recurring.css.
  //
  // The calendar IS the page. Every occurrence of an adopted schedule — actual
  // past charges and projected future ones alike — renders as a chip in its
  // day, and the chip is where that schedule's data lives: its name and the
  // amount, and the rest in its tooltip. CLICKING one opens that schedule's
  // editor — the same dialog a list row opens, on the surface the schedule
  // already lives on. Nothing opens on hover: a floating card wide enough to
  // hold a row covers the days around its chip.
  //
  // Two panels frame the calendar, scoped differently on purpose.
  // renderSummary totals the DISPLAYED MONTH by direction — money in, out and
  // moved — which is not readable off 42 cells. renderRail lists EVERY schedule
  // against its next due date, whatever month that falls in, so a quarterly
  // bill or an annual renewal is visible from a month it has nothing in. The
  // list's foot carries the page's two whole-list buttons.
  //
  // EVERY change to a schedule goes through one dialog, openScheduleDialog:
  // creating and editing, from the list, from a chip, and from a day. A chip
  // and a list row only decide WHICH schedule; they never hold an editable
  // copy of one.
  //
  // Detection, cadence classification and projection are server-side (GET
  // /api/recurring?month=YYYY-MM, backed by detectRecurringSeries in
  // services/predictions.js). Cadence is a RULE, not one of five names
  // (services/recurrence.js): every N weeks on a weekday, or every N months on
  // a date or on an nth weekday, with an optional end date. ruleLabel and
  // ruleSentence are its two readings — a word where there is room for a
  // word, a line where there is room for a line.
  //
  // The page starts EMPTY, however much recurring history the ledger holds:
  // detection is heuristic, so it does not populate the calendar on its own.
  // The user runs it from the list's "Detect schedules", ticks the series they
  // recognize (openDetectDialog → GET /api/recurring/candidates, POST
  // /api/recurring/adopt), and those appear on the calendar. Schedules are
  // added by hand from "Create schedule", which opens on today, or from a day
  // of the calendar, which opens on that date.
  //
  // Globals (loaded before this script): apiFetch (api.js), escapeHtml
  // (escape.js), todayIso/fmtShortDate (format.js), formatCurrency/
  // applyCurrencyFormat/stripCurrencyValue (currency.js), merchantAvatarHtml
  // (avatar.js), Ant (widgets/ant.js).

  const WEEKDAY_MIN = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const DIRECTION_LABEL = { income: 'Income', expense: 'Expense', transfer: 'Transfer' };
  const DIRECTION_OPTIONS = Object.keys(DIRECTION_LABEL);
  // Chips a day shows before the rest fold behind a "+n more" the user can
  // expand. A cap is needed (a busy 1st would otherwise stretch its week), but
  // nothing may become unreachable, so the fold is a button.
  const MAX_CHIPS_PER_DAY = 2;
  // Below this the calendar card cannot fit seven columns wide enough for a
  // chip's name, and the month is drawn as a list of days instead.
  const LIST_BELOW_PX = 560;
  // Ant's 6-week calendar.
  const CALENDAR_DAYS = 42;

  const pad2 = (n) => String(n).padStart(2, '0');

  function currentMonthKey() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
  }

  function addMonthKey(key, n) {
    const [y, m] = key.split('-').map(Number);
    const total = y * 12 + (m - 1) + n;
    return `${Math.floor(total / 12)}-${pad2((total % 12) + 1)}`;
  }

  function monthLabel(key) {
    const [y, m] = key.split('-').map(Number);
    return `${MONTHS[m - 1]} ${y}`;
  }

  function isoOf(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  /** 0 = Sunday, read in local time like every other date on this page. */
  function weekdayOf(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).getDay();
  }

  // Mirror of services/predictions.js's normaliseDesc — used client-side only to
  // warn the editor when a name produces no letters in the key. The backend is
  // authoritative and re-derives this on save.
  function normaliseDesc(desc) {
    return String(desc || '').toLowerCase().replace(/\d+/g, '').replace(/[^a-z]+/g, ' ').trim();
  }

  let month = currentMonthKey();
  let data = { series: [], occurrences: [] };
  // key -> schedule, rebuilt whenever `data` is. Every chip asks for its
  // schedule by key, so a scan per chip would make one render cost chips x
  // schedules.
  let seriesByKey = new Map();
  // Only the newest load may paint: stepping months quickly can have several
  // in flight, and a slow early answer must not overwrite a later month.
  let loadGeneration = 0;
  // The schedule a list row is being pointed at. Hovering the list lights that
  // schedule's chips on the calendar: the list is for finding a schedule on the
  // calendar, and the chips are where it is.
  let railHoverKey = null;
  // The schedule a list row was CLICKED on (or a save landed on), which is the
  // same mark made to stay: it says which of the month's chips is the one just
  // asked for. Another row, Escape, or stepping to another month ends it.
  let pickedKey = null;
  // ISO dates whose "+n more" the user expanded, so the extra chips stay put
  // across re-renders within the month.
  const expandedDays = new Set();
  // The calendar is drawn as a list of days while its card is too narrow.
  let listMode = false;

  function seriesFor(key) {
    return seriesByKey.get(key) || {};
  }

  function labelOf(s) {
    return s.display_name || s.description || s.key || '';
  }

  function occLabel(occ) {
    const s = seriesFor(occ.key);
    return s.display_name || s.description || occ.key;
  }

  /** The schedule marked on both surfaces: the list row under the pointer, or
   *  else the one last clicked (or saved). Hover sits above the click, so
   *  running the pointer down the list reads each schedule in turn and the
   *  picked row takes the mark back when the pointer leaves. Both the markup
   *  builders and applyActiveHighlight read it, so they cannot disagree. */
  function activeKey() {
    return railHoverKey || pickedKey;
  }

  /** A request made from `btn`, which shows Ant's loading state while it runs
   *  so a slow answer cannot be asked for twice. Resolves to the response, or
   *  to null when the request itself failed; the caller says so either way. */
  const requestFrom = (btn, url, opts) => Ant.whileLoading(btn, () => apiFetch(url, opts));
  const isBusy = (btn) => Ant.isLoading(btn);

  /** A JSON POST's fetch options. */
  const postJson = (body) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  // ─── Cadence, in words ─────────────────────────────────────────────────────

  const POSITION_LABELS = [[1, 'First'], [2, 'Second'], [3, 'Third'], [4, 'Fourth'], [-1, 'Last']];

  /** The familiar name for a cadence, where one exists, and "every N" where it
   *  does not. Used where there is room for a word and not for a sentence — the
   *  list's second line and the detection table's Cadence tag. */
  function ruleLabel(rule) {
    if (!rule) return '';
    if (rule.freq === 'weekly') {
      return { 1: 'Weekly', 2: 'Biweekly' }[rule.interval] || `Every ${rule.interval} weeks`;
    }
    return { 1: 'Monthly', 3: 'Quarterly', 12: 'Yearly' }[rule.interval] || `Every ${rule.interval} months`;
  }

  /** The whole rule in one line, for the editor's readout and for the tooltips
   *  on surfaces that only have room for the short label. */
  function ruleSentence(rule) {
    if (!rule) return '';
    const every = rule.freq === 'weekly'
      ? (rule.interval === 1 ? 'Every week' : `Every ${rule.interval} weeks`)
      : (rule.interval === 1 ? 'Every month' : `Every ${rule.interval} months`);
    let on = '';
    if (rule.freq === 'weekly') {
      on = ` on ${WEEKDAY_LABELS[rule.weekday]}`;
    } else if (rule.month_mode === 'day') {
      const pos = (POSITION_LABELS.find(([v]) => v === rule.pos) || [1, 'First'])[1].toLowerCase();
      on = ` on the ${pos} ${WEEKDAY_LABELS[rule.weekday]}`;
    } else if (rule.day) {
      on = ` on the ${ordinal(rule.day)}`;
    }
    return every + on + (rule.until ? `, until ${fmtShortDate(rule.until)}` : '');
  }

  function ordinal(n) {
    const tens = n % 100;
    if (tens >= 11 && tens <= 13) return `${n}th`;
    return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;
  }

  // ─── Toolbar ───────────────────────────────────────────────────────────────

  function renderToolbar() {
    const text = document.getElementById('rec-month-text');
    if (text) text.textContent = monthLabel(month);
    // Nothing to go back to while already there — disabled rather than hidden,
    // so the controls beside it never move under the pointer.
    const today = document.getElementById('rec-month-today');
    if (today) today.disabled = month === currentMonthKey();
  }

  // ─── Month totals ──────────────────────────────────────────────────────────
  // The three figures above the calendar: what the displayed month is expected
  // to bring in, pay out and move. They total the OCCURRENCES the calendar
  // draws — recorded charges and projections alike — so they can never disagree
  // with the chips under them, and stepping to another month retotals them.

  const SUMMARY_TILES = [
    ['income', 'Expected income'],
    ['expense', 'Expected expenses'],
    ['transfer', 'Expected transfers'],
  ];

  function monthTotals() {
    const totals = { income: 0, expense: 0, transfer: 0 };
    for (const occ of data.occurrences) {
      if (Object.hasOwn(totals, occ.direction)) totals[occ.direction] += occ.amount;
    }
    return totals;
  }

  function renderSummary() {
    const host = document.getElementById('rec-summary');
    if (!host) return;
    const totals = monthTotals();
    host.innerHTML = SUMMARY_TILES.map(([direction, label]) => `
      <div class="ant-card ant-card-small rec-stat rec-stat-${direction}">
        <div class="ant-card-body">
          <div class="ant-statistic-title">${label}</div>
          <div class="ant-statistic-content">${escapeHtml(formatCurrency(totals[direction], true))}</div>
        </div>
      </div>`).join('');
  }

  // ─── Calendar ──────────────────────────────────────────────────────────────

  /** The 42 days Ant's Calendar draws: six weeks from the Sunday on or before
   *  the 1st. Days outside the month show their date and hold nothing — the
   *  occurrences are the displayed month's only. */
  function calendarDays() {
    const [y, m] = month.split('-').map(Number);
    const lead = new Date(y, m - 1, 1).getDay();
    return Array.from({ length: CALENDAR_DAYS }, (_, i) => {
      const d = new Date(y, m - 1, 1 - lead + i);
      return { iso: isoOf(d), day: d.getDate(), inMonth: d.getMonth() === m - 1 };
    });
  }

  /** The month's occurrences by date, biggest amount first within a day, so
   *  the two a day shows before "+n more" are the two that matter most. */
  function occurrencesByDate() {
    const byDate = new Map();
    for (const occ of data.occurrences) {
      let list = byDate.get(occ.date);
      if (!list) { list = []; byDate.set(occ.date, list); }
      list.push(occ);
    }
    for (const list of byDate.values()) list.sort((a, b) => b.amount - a.amount);
    return byDate;
  }

  /** One occurrence, as a chip: the name over the amount, tinted by direction
   *  (rec-occ-<direction>, recurring.css). A <button> that opens its schedule's
   *  editor. The tooltip carries what a narrow day cannot: the full name, the
   *  rule, and whether the charge is a projection. */
  function chipHtml(occ) {
    const label = occLabel(occ);
    const amount = formatCurrency(occ.amount, true);
    const projected = occ.actual ? '' : ' (projected)';
    const tip = [label, amount, ruleSentence(seriesFor(occ.key).rule)].filter(Boolean).join(' · ') + projected;
    const name = `${label}, ${amount} on ${fmtShortDate(occ.date)}${projected}. Edit schedule`;
    const cls = `rec-occ rec-occ-${occ.direction} rec-occ-${occ.actual ? 'actual' : 'projected'}`
      + (activeKey() === occ.key ? ' rec-occ-active' : '');
    return `<button type="button" class="${cls}" aria-haspopup="dialog"
      data-key="${escapeHtml(occ.key)}" data-date="${escapeHtml(occ.date)}"
      aria-label="${escapeHtml(name)}" data-tip="${escapeHtml(tip)}">
      <span class="rec-occ-name">${escapeHtml(label)}</span>
      <span class="rec-occ-amount">${escapeHtml(amount)}</span>
    </button>`;
  }

  /** One day of the grid: the date at the right of its rule, the + that starts
   *  a schedule on it, and its chips. */
  function dayCellHtml(c, byDate, today) {
    const num = pad2(c.day);
    if (!c.inMonth) {
      return `<td class="rec-day rec-day-outside"><div class="rec-day-inner">
        <div class="rec-day-head"><span class="rec-day-num">${num}</span></div>
        <div class="rec-day-occs"></div>
      </div></td>`;
    }
    const occs = byDate.get(c.iso) || [];
    const expanded = expandedDays.has(c.iso);
    const shown = expanded ? occs : occs.slice(0, MAX_CHIPS_PER_DAY);
    const folded = occs.length - shown.length;
    const when = fmtShortDate(c.iso);
    let toggle = '';
    if (folded > 0) {
      toggle = `<button type="button" class="rec-day-more" data-expand="${c.iso}" aria-expanded="false"
        aria-label="Show ${folded} more on ${escapeHtml(when)}">+${folded} more</button>`;
    } else if (expanded && occs.length > MAX_CHIPS_PER_DAY) {
      toggle = `<button type="button" class="rec-day-more" data-expand="${c.iso}" aria-expanded="true">Show less</button>`;
    }
    const isToday = c.iso === today;
    return `<td class="rec-day${isToday ? ' rec-day-today' : ''}" data-day="${c.iso}"${isToday ? ' aria-current="date"' : ''}>
      <div class="rec-day-inner">
        <div class="rec-day-head">
          <button type="button" class="ant-btn ant-btn-text ant-btn-sm ant-btn-icon-only rec-day-add" data-add="${c.iso}"
            aria-label="Add a schedule due ${escapeHtml(when)}" data-tip="Add a schedule">${Ant.icon('plus')}</button>
          <span class="rec-day-num">${num}</span>
        </div>
        <div class="rec-day-occs">${shown.map(chipHtml).join('')}${toggle}</div>
      </div>
    </td>`;
  }

  function gridHtml(byDate, today) {
    const days = calendarDays();
    const weeks = [];
    for (let i = 0; i < days.length; i += 7) {
      weeks.push(`<tr>${days.slice(i, i + 7).map((c) => dayCellHtml(c, byDate, today)).join('')}</tr>`);
    }
    return `<table class="rec-cal" aria-label="${escapeHtml(monthLabel(month))}">
      <thead><tr>${WEEKDAY_MIN.map((w, i) => `<th scope="col" abbr="${WEEKDAY_LABELS[i]}">${w}</th>`).join('')}</tr></thead>
      <tbody>${weeks.join('')}</tbody>
    </table>`;
  }

  /** The narrow form: only the days with something due, each with its chips. */
  function listHtml(byDate, today) {
    const dates = [...byDate.keys()].sort();
    if (!dates.length) return Ant.empty({ title: `Nothing expected in ${monthLabel(month)}`, compact: true });
    return `<div class="rec-list">${dates.map((iso) => `
      <div class="rec-list-day">
        <div class="rec-list-date${iso === today ? ' rec-list-today' : ''}">${escapeHtml(fmtShortDate(iso))} · ${WEEKDAY_SHORT[weekdayOf(iso)]}</div>
        ${byDate.get(iso).map(chipHtml).join('')}
      </div>`).join('')}</div>`;
  }

  function renderCalendar() {
    const host = document.getElementById('rec-calendar');
    if (!host) return;
    const byDate = occurrencesByDate();
    const today = todayIso();
    host.innerHTML = `<div class="ant-card-head"><div class="ant-card-head-wrapper">
        <h2 class="ant-card-head-title">${escapeHtml(monthLabel(month))}</h2>
      </div></div>
      <div class="ant-card-body">${listMode ? listHtml(byDate, today) : gridHtml(byDate, today)}</div>`;
  }

  // ─── The schedule list ─────────────────────────────────────────────────────
  // EVERY adopted schedule, soonest due first, against the date its next charge
  // falls on — deliberately not month-scoped, unlike the totals: the month on
  // screen shows what is due inside it, and the list answers "what is running
  // and what is coming", including a bill that lands nowhere near this month.
  //
  // A row is the EDIT control for its schedule, and its only one: every change,
  // deleting included, is made in the editor it opens. Hovering a row lights
  // its chips, which is how the list finds a schedule on the calendar without
  // opening anything; the mark is also what a saved edit leaves behind
  // (goToSchedule).

  /** The merchant, its cadence and amount under it, and its next due date with
   *  a dot in its direction's colour. The rule's full sentence is the tooltip.
   *  An ended schedule says so in place of a date: it stays listed until the
   *  user deletes it, because a row that vanished would read as lost data. */
  function railRowHtml(s) {
    const label = labelOf(s);
    let due = '';
    if (s.ended) due = '<span class="ant-tag">Ended</span>';
    else if (s.next_date) due = `<span class="rec-rail-date">${escapeHtml(fmtShortDate(s.next_date))}</span>`;
    const cls = 'rec-rail-row'
      + (activeKey() === s.key ? ' rec-rail-active' : '')
      + (s.ended ? ' rec-rail-ended' : '');
    return `<button type="button" class="${cls}" aria-haspopup="dialog" data-key="${escapeHtml(s.key)}"
      data-tip="${escapeHtml(ruleSentence(s.rule))}" data-tip-placement="left">
      ${merchantAvatarHtml(label)}
      <span class="rec-rail-main">
        <span class="rec-rail-name">${escapeHtml(label)}</span>
        <span class="rec-rail-sub">${escapeHtml(ruleLabel(s.rule))} · ${escapeHtml(formatCurrency(s.amount, true))}</span>
      </span>
      <span class="rec-rail-next">${due}<span class="rec-dir-dot rec-dir-${s.direction}" role="img"
        aria-label="${DIRECTION_LABEL[s.direction] || ''}"></span></span>
    </button>`;
  }

  /** The card, head to foot. The two buttons at the foot are the page's only
   *  whole-list actions, under the list the schedules they make land in. */
  function renderRail() {
    const host = document.getElementById('rec-rail');
    if (!host) return;
    const list = data.series.length
      ? `<div class="rec-rail-list">${data.series.map(railRowHtml).join('')}</div>`
      : Ant.empty({ title: 'No schedules yet', desc: 'Create one, or let detection find them in your ledger.' });
    host.innerHTML = `<div class="ant-card-head"><div class="ant-card-head-wrapper">
        <h2 class="ant-card-head-title">Schedules</h2>
        <div class="ant-card-extra"><span class="ant-typography-secondary">${data.series.length}</span></div>
      </div></div>
      <div class="ant-card-body">
        ${list}
        <div class="rec-rail-foot">
          <button type="button" class="ant-btn ant-btn-primary ant-btn-block" data-rail-action="create">${Ant.icon('plus')}<span>Create schedule</span></button>
          <button type="button" class="ant-btn ant-btn-default ant-btn-block" data-rail-action="detect">${Ant.icon('radar-chart')}<span>Detect schedules</span></button>
        </div>
      </div>`;
  }

  // ─── Marking a schedule on both surfaces ───────────────────────────────────

  /** The chip for an occurrence, when the calendar is drawing one. */
  function chipFor(ref) {
    if (!ref) return null;
    return document.querySelector(
      `.rec-occ[data-key="${CSS.escape(ref.key)}"][data-date="${CSS.escape(ref.date)}"]`
    );
  }

  /** Light every chip of the active SCHEDULE — a monthly bill's whole run, not
   *  just the one under the pointer — and its list row with them. Classes
   *  only, no re-render: the pointer is sitting on one of these nodes, and
   *  replacing it mid-hover would restart the mouseover/mouseout cycle. */
  function applyActiveHighlight() {
    const key = activeKey();
    document.querySelectorAll('.rec-occ').forEach((chip) => {
      chip.classList.toggle('rec-occ-active', key != null && chip.dataset.key === key);
    });
    document.querySelectorAll('.rec-rail-row').forEach((row) => {
      row.classList.toggle('rec-rail-active', key != null && row.dataset.key === key);
    });
  }

  /** Mark `key` on the month on screen, unfolding its day if the chip is
   *  behind a "+n more". False when this month draws nothing for it, which is
   *  the list's normal case: most schedules are elsewhere. */
  function markScheduleInMonth(key) {
    const occ = data.occurrences.find((o) => o.key === key);
    if (!occ) return false;
    revealOccurrence({ key, date: occ.date });
    pickedKey = key;
    applyActiveHighlight();
    return true;
  }

  /** Follow a schedule to wherever it is: the calendar steps to the month of
   *  its next charge, and its chips there light up. */
  async function goToSchedule(key) {
    if (markScheduleInMonth(key)) return true;
    const target = seriesFor(key).next_date?.slice(0, 7);
    if (!target || target === month) return false;
    month = target;
    expandedDays.clear();
    await load();
    return markScheduleInMonth(key);
  }

  /** Make sure an occurrence has a chip before anything points at it: a mark on
   *  a chip that is not drawn is no answer at all. Unfolding the day also shows
   *  the user where the schedule went. */
  function revealOccurrence(ref) {
    if (chipFor(ref)) return;
    expandedDays.add(ref.date);
    renderCalendar();
  }

  /** Drop the mark, for Escape. The calendar stays where it is: the month on
   *  screen is where the user asked to be. */
  function clearPick() {
    pickedKey = null;
    applyActiveHighlight();
  }

  // ─── The editor ────────────────────────────────────────────────────────────
  // ONE dialog for every change a schedule can take, and the only one on the
  // page. Creating (the list's Create schedule, a day of the calendar) and
  // editing (a chip or a list row) all open it.
  //
  // WHAT IS SENT. Editing sends only what the user changed (diffPatch). That
  // matters beyond saving bytes: a null field on a detected schedule means
  // "follow the ledger", so writing every field back on every save would
  // quietly pin a schedule's name, amount and cadence the first time someone
  // corrected its spelling.

  const REPEAT_MODES = [
    ['weekly', 'Weekly'],
    ['monthly-date', 'Monthly (by date)'],
    ['monthly-day', 'Monthly (by day)'],
  ];
  // Matches services/recurrence.js's MAX_INTERVAL. A larger number is a typo
  // rather than a cadence.
  const MAX_INTERVAL = 120;
  // The Name field's merchant suggestions: two characters before the first
  // lookup (one letter matches most of the lexicon), and a pause long enough
  // that typing a full name costs one request rather than one per key.
  const SUGGEST_DELAY_MS = 160;
  const SUGGEST_MIN_CHARS = 2;
  // The readout's next dates: asked for once the form stops changing.
  const PREVIEW_DELAY_MS = 120;

  const dayOptions = Array.from({ length: 31 }, (_, i) => [i + 1, ordinal(i + 1)]);
  const weekdayOptions = WEEKDAY_LABELS.map((label, i) => [i, label]);

  /** The rule as the form's controls hold it. "Monthly by date" and "monthly
   *  by day" are one control here and two fields in the rule (freq +
   *  month_mode), because to the user they are one choice. Whatever the rule
   *  leaves open comes from `anchorIso`, so a schedule started on the 14th
   *  repeats on the 14th, and by day on the second of that weekday. A fifth
   *  weekday reads as the last: rules have no fifth week, since most months
   *  do not. */
  function ruleToForm(rule, anchorIso) {
    const [y, m, d] = anchorIso.split('-').map(Number);
    const week = Math.ceil(d / 7);
    const base = {
      mode: 'monthly-date', interval: 1,
      weekday: new Date(y, m - 1, d).getDay(), day: d, pos: week > 4 ? -1 : week,
    };
    if (!rule) return base;
    if (rule.freq === 'weekly') {
      return { ...base, mode: 'weekly', interval: rule.interval, weekday: rule.weekday ?? base.weekday };
    }
    if (rule.month_mode === 'day') {
      return {
        ...base, mode: 'monthly-day', interval: rule.interval,
        weekday: rule.weekday ?? base.weekday, pos: rule.pos ?? base.pos,
      };
    }
    return { ...base, mode: 'monthly-date', interval: rule.interval, day: rule.day ?? base.day };
  }

  function formToRule(f, until) {
    if (f.mode === 'weekly') {
      return { freq: 'weekly', interval: f.interval, weekday: f.weekday, month_mode: null, day: null, pos: null, until };
    }
    if (f.mode === 'monthly-day') {
      return { freq: 'monthly', interval: f.interval, weekday: f.weekday, month_mode: 'day', day: null, pos: f.pos, until };
    }
    return { freq: 'monthly', interval: f.interval, weekday: null, month_mode: 'date', day: f.day, pos: null, until };
  }

  /** "week" or "weeks", "month" or "months": the unit beside Every. */
  function unitOf(f) {
    return (f.mode === 'weekly' ? 'week' : 'month') + (f.interval === 1 ? '' : 's');
  }

  /** Ant's Select over a native <select>: DownOutlined is a sibling, since a
   *  <select> cannot hold a child. */
  function selectHtml(attrs, inner) {
    return `<span class="ant-select"><select class="ant-select-selector" ${attrs}>${inner}</select>`
      + `<span class="ant-select-arrow">${Ant.icon('down')}</span></span>`;
  }

  const optionsHtml = (pairs, selected) => pairs
    .map(([value, label]) =>
      `<option value="${escapeHtml(String(value))}"${String(value) === String(selected) ? ' selected' : ''}>${escapeHtml(label)}</option>`)
    .join('');

  /** The repeat band's changing cell: a weekday, a day of the month, or a
   *  position and a weekday as one joined control. */
  function repeatDetailHtml(f) {
    if (f.mode === 'weekly') {
      return `<label class="ant-form-item">
        <span class="ant-form-item-label">On</span>
        ${selectHtml('data-form="weekday"', optionsHtml(weekdayOptions, f.weekday))}
      </label>`;
    }
    if (f.mode === 'monthly-day') {
      return `<div class="ant-form-item">
        <span class="ant-form-item-label" id="rec-on-label">On the</span>
        <div class="ant-space-compact ant-space-compact-block" role="group" aria-labelledby="rec-on-label">
          ${selectHtml('data-form="pos" aria-label="Week of the month"', optionsHtml(POSITION_LABELS, f.pos))}
          ${selectHtml('data-form="weekday" aria-label="Weekday"', optionsHtml(weekdayOptions, f.weekday))}
        </div>
      </div>`;
    }
    return `<label class="ant-form-item">
      <span class="ant-form-item-label">On the</span>
      ${selectHtml('data-form="day"', optionsHtml(dayOptions, f.day))}
    </label>`;
  }

  function editorBodyHtml(s, f, { creating, nextIso }) {
    const label = s.display_name || s.description || '';
    const until = s.rule && s.rule.until ? s.rule.until : '';
    // A date the user owns only on a schedule with no transactions behind it. A
    // detected one takes its dates from the ledger, so there is nothing to move.
    const dateField = creating || s.manual ? `<label class="ant-form-item">
        <span class="ant-form-item-label">Next charge</span>
        <input type="date" class="ant-input" data-form="next_date" value="${escapeHtml(nextIso)}">
      </label>` : '';
    const footnote = !creating && !s.manual
      ? `<div class="rec-edit-footnote">Detected from ${s.occurrences} transaction${s.occurrences === 1 ? '' : 's'} in your ledger, so its dates follow the ledger.</div>`
      : '';

    // Two bands — what it is, then how it repeats — split by a rule. Name is not
    // a <label> wrapper like the fields after it: its suggestion list is a
    // sibling of the input, and a click anywhere inside a label is forwarded to
    // that label's control.
    return `<div class="rec-edit-grid">
        <div class="ant-form-item rec-field-wide rec-name-field">
          <label class="ant-form-item-label" for="rec-name-input">Name</label>
          <div class="rec-name-row">
            <span class="rec-name-avatar" id="rec-name-avatar" aria-hidden="true">${merchantAvatarHtml(label)}</span>
            <input type="text" class="ant-input" id="rec-name-input" data-form="display_name" maxlength="100"
              value="${escapeHtml(label)}" placeholder="e.g. Gym Membership" autocomplete="off"
              role="combobox" aria-expanded="false" aria-autocomplete="list" aria-controls="rec-name-suggest">
          </div>
          <div class="rec-suggest" id="rec-name-suggest" role="listbox" aria-label="Matching merchants" hidden></div>
        </div>
        <label class="ant-form-item">
          <span class="ant-form-item-label">Type</span>
          ${selectHtml('data-form="direction"', optionsHtml(DIRECTION_OPTIONS.map((d) => [d, DIRECTION_LABEL[d]]), s.direction || 'expense'))}
        </label>
        <label class="ant-form-item">
          <span class="ant-form-item-label">Amount</span>
          <input type="text" inputmode="decimal" class="ant-input rec-input-amount" data-form="amount"
            value="${s.amount == null ? '' : escapeHtml(formatCurrency(s.amount, true, { editable: true }))}"
            placeholder="${escapeHtml(formatCurrency(0, true, { editable: true }))}" autocomplete="off">
        </label>
      </div>

      <div class="rec-edit-grid rec-edit-band">
        <label class="ant-form-item">
          <span class="ant-form-item-label">Repeat by</span>
          ${selectHtml('data-form="mode"', optionsHtml(REPEAT_MODES, f.mode))}
        </label>
        <div class="ant-form-item">
          <label class="ant-form-item-label" for="rec-interval">Every</label>
          <div class="ant-space-compact">
            <input type="number" class="ant-input rec-input-interval" id="rec-interval" data-form="interval"
              min="1" max="${MAX_INTERVAL}" step="1" value="${f.interval}" aria-describedby="rec-interval-unit">
            <span class="ant-input-addon" id="rec-interval-unit" data-form="unit">${unitOf(f)}</span>
          </div>
        </div>
        <div class="rec-edit-detail">${repeatDetailHtml(f)}</div>
        ${dateField}
      </div>

      <div class="rec-edit-ends">
        <label class="ant-checkbox-wrapper">
          <input type="checkbox" class="ant-checkbox" data-form="ends-on"${until ? ' checked' : ''}>
          <span>Ends on</span>
        </label>
        <input type="date" class="ant-input" data-form="until" aria-label="End date"
          value="${escapeHtml(until)}"${until ? '' : ' hidden'}>
      </div>

      <div class="ant-alert ant-alert-info ant-alert-with-description rec-edit-readout" id="rec-edit-readout" role="status">
        <div class="ant-alert-content">
          <div class="ant-alert-message" id="rec-readout-rule"></div>
          <div class="ant-alert-description" id="rec-readout-next"></div>
        </div>
      </div>
      ${footnote}
      <div class="rec-edit-error" id="rec-edit-error" role="alert" hidden></div>`;
  }

  /** Only what changed, so a detected schedule keeps following the ledger on
   *  every field the user did not touch. */
  function diffPatch(before, after) {
    const patch = {};
    for (const [field, value] of Object.entries(after)) {
      const was = before[field];
      const same = field === 'rule'
        ? JSON.stringify(was) === JSON.stringify(value)
        : was === value;
      if (!same) patch[field] = value;
    }
    return patch;
  }

  /**
   * The editor. `key` names the schedule to edit; without one it creates,
   * starting on `dateIso` (a day's date, or today).
   */
  function openScheduleDialog({ key = null, dateIso = null } = {}) {
    const creating = !key;
    const s = creating
      ? { direction: 'expense', amount: null, rule: null, manual: true }
      : seriesFor(key);
    if (!creating && !s.key) return;
    const start = dateIso || todayIso();
    const nextIso = creating ? start : (s.next_date || start);
    const form = ruleToForm(s.rule, s.next_date || s.last_date || start);
    // The form's two timers, stopped when it closes so nothing answers into a
    // dialog that is gone.
    let previewTimer = 0;
    let suggestTimer = 0;

    const { overlay, close } = Ant.modal({
      title: creating ? 'New schedule' : 'Edit schedule',
      width: 560,
      className: 'rec-edit-dialog',
      body: editorBodyHtml(s, form, { creating, nextIso }),
      footer: `${creating ? '' : `<button type="button" class="ant-btn ant-btn-default ant-btn-dangerous rec-edit-delete" id="rec-edit-delete">${Ant.icon('delete')}<span>Delete</span></button>`}
        <button type="button" class="ant-btn ant-btn-primary" id="rec-edit-save">${creating ? 'Create' : 'Save'}</button>`,
      onClose: () => {
        clearTimeout(previewTimer);
        clearTimeout(suggestTimer);
      },
    });

    const el = (sel) => overlay.querySelector(sel);
    const nameInput = el('#rec-name-input');
    const amountInput = el('[data-form="amount"]');
    const dateInput = el('[data-form="next_date"]');
    const untilInput = el('[data-form="until"]');
    const endsBox = el('[data-form="ends-on"]');
    const errorLine = el('#rec-edit-error');
    // Whether the user has set the day the schedule repeats on. Until they do, a
    // new schedule's rule follows its date: moving the next charge to the 5th
    // makes it repeat on the 5th.
    let ruleTouched = false;

    /** Read the controls back into the rule the form describes. */
    function readForm() {
      form.mode = el('[data-form="mode"]').value;
      form.interval = Math.max(1, Math.min(MAX_INTERVAL, Number(el('[data-form="interval"]').value) || 1));
      const pick = (name, fallback) => {
        const node = el(`[data-form="${name}"]`);
        return node ? Number(node.value) : fallback;
      };
      form.weekday = pick('weekday', form.weekday);
      form.day = pick('day', form.day);
      form.pos = pick('pos', form.pos);
      return formToRule(form, endsBox.checked && untilInput.value ? untilInput.value : null);
    }

    // ── The readout: the rule in a sentence, and its next three dates ────────
    // The dates come from the backend (GET /api/recurring/preview), which runs
    // the same rule code the calendar is drawn with, so the readout never
    // promises a date the calendar then puts elsewhere. Its anchor is the one
    // a save would use: a detected schedule's last recorded charge, otherwise
    // the date the schedule starts. Only the newest answer may paint.
    let previewGeneration = 0;

    function previewAnchor() {
      if (!creating && !s.manual) return { anchor: s.last_date, afterAnchor: true };
      // An untouched date on an existing hand-made schedule is not sent on save
      // (diffPatch), so its stored anchor still rules.
      if (!creating && dateInput.value === nextIso) return { anchor: s.last_date, afterAnchor: false };
      return { anchor: dateInput.value, afterAnchor: false };
    }

    async function showNextDates(rule) {
      const mine = ++previewGeneration;
      const out = el('#rec-readout-next');
      const { anchor, afterAnchor } = previewAnchor();
      if (!anchor) { out.textContent = ''; return; }
      const params = new URLSearchParams({ anchor, freq: rule.freq, interval: String(rule.interval) });
      for (const field of ['weekday', 'month_mode', 'day', 'pos', 'until']) {
        if (rule[field] != null) params.set(field, String(rule[field]));
      }
      if (afterAnchor) params.set('after_anchor', '1');
      let body = null;
      try {
        const res = await apiFetch(`/api/recurring/preview?${params}`);
        if (res.ok) body = await res.json();
      } catch (err) {
        console.error('[recurring] preview failed:', err);
      }
      if (mine !== previewGeneration || !overlay.isConnected) return;
      const dates = body && Array.isArray(body.dates) ? body.dates : null;
      if (!dates) out.textContent = '';
      else if (!dates.length) out.textContent = 'No dates left before it ends.';
      else out.textContent = `Next: ${dates.map(fmtShortDate).join(', ')}`;
    }

    function syncReadout() {
      const rule = readForm();
      el('#rec-readout-rule').textContent = `${ruleSentence(rule)}.`;
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => showNextDates(rule), PREVIEW_DELAY_MS);
    }

    /** Redraw the repeat band's mode-dependent cell from `form`. */
    function redrawDetail() {
      el('.rec-edit-detail').innerHTML = repeatDetailHtml(form);
      el('[data-form="unit"]').textContent = unitOf(form);
      syncReadout();
    }

    // ── Errors ───────────────────────────────────────────────────────────────
    // A field that fails is marked and the first problem is said in words, so
    // the red border is never the only thing saying what is wrong. Saving never
    // stores a value the user did not type.
    function showError(text) {
      errorLine.textContent = text;
      errorLine.hidden = !text;
    }

    function clearInvalid(node) {
      if (!node.hasAttribute('aria-invalid')) return;
      node.removeAttribute('aria-invalid');
      if (!overlay.querySelector('[aria-invalid="true"]')) showError('');
    }

    // ── Name: avatar, and the merchants the lexicon knows ────────────────────
    // Typing a name offers matching merchants (GET /api/recurring/brands, the
    // bundled lexicon rather than the ledger). Picking one writes the
    // merchant's canonical spelling, and that spelling is what draws the brand
    // avatar — avatar.js slugs the label and looks it up in the icon manifest
    // the same lexicon generated.
    //
    // It claims NOTHING. No transaction, no alias, no history: a suggestion fills
    // in one field the user can immediately overwrite. A schedule is still joined
    // to the ledger by its key alone.
    const avatarBox = el('#rec-name-avatar');
    const suggestBox = el('#rec-name-suggest');

    let suggestions = [];
    let suggestIndex = -1;   // -1 = nothing highlighted; Enter then saves nothing
    let suggestGeneration = 0;
    let avatarFor = null;    // the label the avatar currently draws

    /** Keep the avatar showing the name as typed, rebuilt only when the name
     *  actually changed so a held key does not rebuild it per repeat. */
    function syncAvatar() {
      const label = nameInput.value.trim();
      if (label === avatarFor) return;
      avatarFor = label;
      avatarBox.innerHTML = merchantAvatarHtml(label);
    }

    function closeSuggest() {
      suggestions = [];
      suggestIndex = -1;
      suggestBox.hidden = true;
      suggestBox.innerHTML = '';
      nameInput.setAttribute('aria-expanded', 'false');
      nameInput.removeAttribute('aria-activedescendant');
    }

    function suggestRowHtml(b, i) {
      // tabindex="-1": the arrow keys walk the list, Tab leaves it. A row that
      // took a Tab stop would put eight of them between Name and Type.
      return `<button type="button" class="rec-suggest-row" id="rec-suggest-${i}" role="option" tabindex="-1"
        data-index="${i}" aria-selected="false">
        ${merchantAvatarHtml(b.name)}
        <span class="rec-suggest-name">${escapeHtml(b.name)}</span>
      </button>`;
    }

    function renderSuggest() {
      if (!suggestions.length) { closeSuggest(); return; }
      suggestBox.innerHTML = suggestions.map(suggestRowHtml).join('');
      suggestBox.hidden = false;
      nameInput.setAttribute('aria-expanded', 'true');
    }

    /** Move the highlight, wrapping at both ends so one key reaches every row. */
    function moveSuggest(step) {
      if (!suggestions.length) return;
      suggestIndex = (suggestIndex + step + suggestions.length) % suggestions.length;
      [...suggestBox.children].forEach((row, i) => {
        row.classList.toggle('rec-suggest-active', i === suggestIndex);
        row.setAttribute('aria-selected', String(i === suggestIndex));
      });
      nameInput.setAttribute('aria-activedescendant', `rec-suggest-${suggestIndex}`);
      suggestBox.children[suggestIndex].scrollIntoView({ block: 'nearest' });
    }

    /** Take a suggestion: its name, and nothing else. The lexicon knows what a
     *  merchant is called, not what they charge this user. */
    function applySuggestion(i) {
      const brand = suggestions[i];
      if (!brand) return;
      nameInput.value = brand.name;
      clearInvalid(nameInput);
      closeSuggest();
      syncAvatar();
      nameInput.focus();
    }

    async function searchBrands() {
      const q = nameInput.value.trim();
      if (q.length < SUGGEST_MIN_CHARS) { closeSuggest(); return; }
      // Every keystroke can outrun the one before it; only the newest answer
      // may paint, or a slow early response overwrites a fast later one.
      const mine = ++suggestGeneration;
      const res = await apiFetch(`/api/recurring/brands?q=${encodeURIComponent(q)}`);
      if (mine !== suggestGeneration || !res.ok) return;
      const { brands } = await res.json();
      if (mine !== suggestGeneration) return;
      // A name already spelled exactly as the one merchant offered is answered:
      // re-opening the list over it would only be something else to dismiss.
      suggestions = (brands.length === 1 && brands[0].name === nameInput.value.trim()) ? [] : brands;
      suggestIndex = -1;
      renderSuggest();
    }

    function queueSuggest() {
      clearTimeout(suggestTimer);
      suggestTimer = setTimeout(searchBrands, SUGGEST_DELAY_MS);
    }

    function dropSuggest() {
      clearTimeout(suggestTimer);
      suggestGeneration++;
      closeSuggest();
    }

    // mousedown, not click: it fires before the input loses focus, so picking a
    // row cannot race the focusout that closes the list.
    suggestBox.addEventListener('mousedown', (e) => {
      const row = e.target.closest('.rec-suggest-row');
      if (!row) return;
      e.preventDefault();
      applySuggestion(Number(row.dataset.index));
    });

    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!suggestions.length) return;
        e.preventDefault();
        moveSuggest(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (e.key === 'Enter' && suggestIndex >= 0) {
        e.preventDefault();
        applySuggestion(suggestIndex);
        return;
      }
      // Dismiss the list, not the dialog: the dialog's Escape listener is on
      // the document, so stopping here keeps an open list from closing the form
      // the user is still filling in.
      if (e.key === 'Escape' && !suggestBox.hidden) {
        e.stopPropagation();
        dropSuggest();
      }
    });

    el('.rec-name-field').addEventListener('focusout', (e) => {
      if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget)) return;
      dropSuggest();
    });

    // ── Form events ──────────────────────────────────────────────────────────
    overlay.addEventListener('change', (e) => {
      const t = e.target;
      clearInvalid(t);
      if (t.matches('[data-form="mode"]')) {
        ruleTouched = true;
        readForm();
        redrawDetail();
        return;
      }
      if (t.matches('[data-form="weekday"], [data-form="day"], [data-form="pos"]')) ruleTouched = true;
      if (t === dateInput && creating && !ruleTouched && t.value) {
        const fromDate = ruleToForm(null, t.value);
        Object.assign(form, { weekday: fromDate.weekday, day: fromDate.day, pos: fromDate.pos });
        redrawDetail();
        return;
      }
      if (t === endsBox) {
        untilInput.hidden = !t.checked;
        clearInvalid(untilInput);
        // An end date with nothing in it is not an end date. A year out is a
        // guess the user is about to move anyway, and never one that ends the
        // schedule before its next charge.
        if (t.checked && !untilInput.value) {
          const d = new Date();
          untilInput.value = isoOf(new Date(d.getFullYear() + 1, d.getMonth(), d.getDate()));
        }
        if (t.checked) untilInput.focus();
      }
      syncReadout();
    });

    overlay.addEventListener('input', (e) => {
      const t = e.target;
      if (t.matches('select, [type="date"], [type="checkbox"]')) return;   // 'change' has these
      clearInvalid(t);
      if (t === nameInput) { syncAvatar(); queueSuggest(); }
      if (t === amountInput) applyCurrencyFormat(t);
      if (t.matches('[data-form="interval"]')) {
        readForm();
        el('[data-form="unit"]').textContent = unitOf(form);
        syncReadout();
      }
    });

    // ── Delete ───────────────────────────────────────────────────────────────
    // Here because this is where a schedule is read: the form names it and shows
    // what it repeats. Ant's Popconfirm asks above the button rather than a
    // second dialog stacking on this one, and the wording names what is lost:
    // the schedule, never the transactions it was detected from.
    el('#rec-edit-delete')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      if (isBusy(btn)) return;
      const label = labelOf(s);
      const ok = await Ant.popconfirm(btn, {
        title: `Delete ${label}?`,
        desc: s.manual
          ? 'It leaves the calendar. Nothing in your ledger changes.'
          : 'It leaves the calendar. Its transactions stay in your ledger, and Detect schedules can offer it again.',
        okText: 'Delete',
        danger: true,
      });
      if (!ok) return;
      const res = await requestFrom(btn, `/api/recurring/schedule/${encodeURIComponent(s.key)}`, { method: 'DELETE' });
      if (!res?.ok) {
        Ant.message.error("Couldn't delete it — try again.");
        return;
      }
      if (pickedKey === s.key) pickedKey = null;
      close();
      await load();
      Ant.message.success(`Deleted ${label}`);
    });

    // ── Save ─────────────────────────────────────────────────────────────────
    el('#rec-edit-save').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      if (isBusy(btn)) return;
      const name = nameInput.value.trim();
      const amount = parseFloat(stripCurrencyValue(amountInput.value));
      const rule = readForm();

      const problems = [];
      const check = (node, ok, text) => {
        if (!node || ok) return;
        node.setAttribute('aria-invalid', 'true');
        problems.push({ node, text });
      };
      check(nameInput, !!name, 'Give the schedule a name.');
      check(nameInput, !name || !!normaliseDesc(name), 'The name needs at least one letter.');
      check(amountInput, amount > 0, 'Enter an amount above zero.');
      check(dateInput, !dateInput || !!dateInput.value, 'Pick the date of the next charge.');
      if (endsBox.checked) {
        check(untilInput, !!untilInput.value, 'Pick the date it ends, or untick Ends on.');
        check(untilInput, !untilInput.value || !dateInput || !dateInput.value || untilInput.value >= dateInput.value,
          'The end date is before the next charge.');
      }
      if (problems.length) {
        showError(problems[0].text);
        problems[0].node.focus();
        return;
      }

      let res;
      if (creating) {
        res = await requestFrom(btn, '/api/recurring/schedule', postJson({
          display_name: name, direction: el('[data-form="direction"]').value,
          amount, next_date: dateInput.value, rule, until: rule.until,
        }));
      } else {
        const after = {
          display_name: name,
          direction: el('[data-form="direction"]').value,
          amount,
          rule: { ...rule, until: null },
          until: rule.until,
        };
        if (dateInput) after.next_date = dateInput.value;

        const patch = diffPatch({
          display_name: s.display_name || s.description,
          direction: s.direction,
          amount: s.amount,
          rule: { ...ruleFromFormState(s), until: null },
          until: (s.rule && s.rule.until) || null,
          next_date: s.next_date,
        }, after);
        if (!Object.keys(patch).length) { close(); return; }
        res = await requestFrom(btn, '/api/recurring/override', postJson({ key: s.key, ...patch }));
      }

      if (!res?.ok) {
        Ant.message.error("Couldn't save your change — it hasn't been stored.");
        return;
      }
      const saved = creating ? (await res.json()).key : s.key;
      close();
      await load();
      goToSchedule(saved);
      Ant.message.success(`${creating ? 'Created' : 'Saved'} ${name}`);
    });

    syncReadout();
    syncAvatar();
    nameInput.focus();
    nameInput.select();
  }

  /** The schedule's rule in the same shape readForm produces, so the two can be
   *  compared field by field without one carrying nulls the other omits. */
  function ruleFromFormState(s) {
    return formToRule(ruleToForm(s.rule, s.next_date || s.last_date || todayIso()), null);
  }

  // ─── Detect ────────────────────────────────────────────────────────────────
  // Detection runs only on request. The table lists what the backend found that
  // is not adopted yet (GET /api/recurring/candidates), and adopting the ticked
  // ones (POST /api/recurring/adopt) puts them on the calendar. Opening it
  // writes nothing, so cancelling leaves the database unchanged.
  //
  // Nothing starts ticked. Detection is a heuristic reading of the ledger, so
  // every row is a guess the user is being asked about — and a pre-ticked list
  // answers for them: the fast path becomes "Add", which adopts whatever the
  // guess happened to include. Starting empty makes each schedule on the
  // calendar one the user chose, and the header box ticks them all in one go.

  function candidateRowHtml(c) {
    const label = c.display_name || c.description;
    const confidence = Math.round((c.confidence || 0) * 100);
    return `<tr>
      <td class="ant-table-selection-column">
        <input type="checkbox" class="ant-checkbox rec-cand-cb" data-key="${escapeHtml(c.key)}" aria-label="Keep ${escapeHtml(label)}">
      </td>
      <td><div class="rec-cand-name">${merchantAvatarHtml(label)}<span class="rec-cand-label">${escapeHtml(label)}</span></div></td>
      <td><span class="ant-tag" data-tip="${escapeHtml(ruleSentence(c.rule))}">${escapeHtml(ruleLabel(c.rule))}</span></td>
      <td class="ant-table-cell-end rec-cand-amount rec-amount-${c.direction}">
        <span class="ant-visually-hidden">${DIRECTION_LABEL[c.direction] || ''} </span>${escapeHtml(formatCurrency(c.amount, true))}
      </td>
      <td class="rec-cand-next">${escapeHtml(fmtShortDate(c.next_date))}</td>
      <td>
        <div class="ant-progress" role="progressbar" aria-label="Confidence"
          aria-valuemin="0" aria-valuemax="100" aria-valuenow="${confidence}">
          <div class="ant-progress-outer"><div class="ant-progress-inner"><div class="ant-progress-bg" style="width: ${confidence}%"></div></div></div>
          <span class="ant-progress-text">${confidence}%</span>
        </div>
      </td>
    </tr>`;
  }

  async function openDetectDialog(trigger) {
    if (isBusy(trigger)) return;
    const res = await requestFrom(trigger, '/api/recurring/candidates');
    if (!res?.ok) {
      Ant.message.error("Couldn't scan your transactions — try again.");
      return;
    }
    const { candidates } = await res.json();

    if (!candidates.length) {
      const { overlay } = Ant.modal({
        title: 'Detect schedules',
        className: 'rec-detect-dialog',
        body: Ant.empty({
          title: 'Nothing new found',
          desc: 'A pattern needs a few charges at a steady interval before it can be spotted. Import more history, or add a schedule by hand from its day on the calendar.',
        }),
        footer: '<button type="button" class="ant-btn ant-btn-default confirm-cancel">Close</button>',
      });
      overlay.querySelector('.confirm-cancel').focus();
      return;
    }

    const { overlay, close } = Ant.modal({
      title: 'Detect schedules',
      width: 760,
      className: 'rec-detect-dialog',
      body: `<div class="ant-typography-secondary">Series that repeat in your ledger and are not on the calendar yet. Tick the ones to keep — you can correct any detail afterwards.</div>
        <div class="ant-table-wrapper">
          <table class="ant-table">
            <thead><tr>
              <th scope="col" class="ant-table-selection-column"><input type="checkbox" class="ant-checkbox" id="rec-cand-all" aria-label="Select all"></th>
              <th scope="col">Schedule</th>
              <th scope="col" class="rec-col-cadence">Cadence</th>
              <th scope="col" class="rec-col-amount ant-table-cell-end">Amount</th>
              <th scope="col" class="rec-col-next">Next</th>
              <th scope="col" class="rec-col-confidence">Confidence</th>
            </tr></thead>
            <tbody>${candidates.map(candidateRowHtml).join('')}</tbody>
          </table>
        </div>`,
      footer: `<button type="button" class="ant-btn ant-btn-default confirm-cancel">Cancel</button>
        <button type="button" class="ant-btn ant-btn-primary" id="rec-cand-ok">Add selected</button>`,
    });

    const allBox = overlay.querySelector('#rec-cand-all');
    const boxes = [...overlay.querySelectorAll('.rec-cand-cb')];
    const okBtn = overlay.querySelector('#rec-cand-ok');
    const ticked = () => boxes.filter((b) => b.checked);

    // "Add" with nothing ticked has nothing to do, and the backend rejects an
    // empty list, so the button says so instead of producing an error.
    function syncState() {
      const n = ticked().length;
      allBox.checked = n === boxes.length;
      allBox.indeterminate = n > 0 && n < boxes.length;
      okBtn.disabled = n === 0;
      okBtn.textContent = n ? `Add ${n} schedule${n === 1 ? '' : 's'}` : 'Add selected';
      boxes.forEach((b) => b.closest('tr').classList.toggle('ant-table-row-selected', b.checked));
    }

    allBox.addEventListener('change', () => {
      boxes.forEach((b) => { b.checked = allBox.checked; });
      syncState();
    });
    const tbody = overlay.querySelector('tbody');
    tbody.addEventListener('change', syncState);
    // A press anywhere on a row ticks it, the way the whole row was the label
    // in the picker this table replaced.
    tbody.addEventListener('click', (e) => {
      if (e.target.closest('input')) return;
      const box = e.target.closest('tr')?.querySelector('.rec-cand-cb');
      if (!box) return;
      box.checked = !box.checked;
      syncState();
    });

    okBtn.addEventListener('click', async () => {
      const keys = ticked().map((b) => b.dataset.key);
      if (!keys.length || isBusy(okBtn)) return;
      const adopt = await requestFrom(okBtn, '/api/recurring/adopt', postJson({ keys }));
      if (!adopt?.ok) {
        Ant.message.error("Couldn't add those schedules — try again.");
        return;
      }
      close();
      await load();
      Ant.message.success(`Added ${keys.length} schedule${keys.length === 1 ? '' : 's'}`);
    });

    syncState();
    allBox.focus();
  }

  // ─── Load and render ───────────────────────────────────────────────────────

  function render() {
    renderToolbar();
    renderSummary();
    renderRail();
    renderCalendar();
  }

  async function load() {
    const mine = ++loadGeneration;
    let res = null;
    try {
      res = await apiFetch(`/api/recurring?month=${encodeURIComponent(month)}`);
    } catch (err) {
      console.error('[recurring] could not load', err);
    }
    if (mine !== loadGeneration) return;
    if (!res?.ok) {
      // A locked database (423) is the shell's to handle: it puts its own
      // prompt over the page.
      if (res?.status !== 423) Ant.message.error("Couldn't load your schedules — try again.");
      return;
    }
    const body = await res.json();
    if (mine !== loadGeneration) return;
    data = body;
    seriesByKey = new Map(data.series.map((s) => [s.key, s]));
    render();
  }

  function goToMonth(key) {
    month = key;
    pickedKey = null;
    expandedDays.clear();
    renderToolbar();
    load();
  }

  document.addEventListener('DOMContentLoaded', () => {
    renderToolbar();

    document.getElementById('rec-month-prev').addEventListener('click', () => goToMonth(addMonthKey(month, -1)));
    document.getElementById('rec-month-next').addEventListener('click', () => goToMonth(addMonthKey(month, 1)));
    // One hop home from anywhere, since the arrows and the panel can take the
    // calendar years out.
    document.getElementById('rec-month-today').addEventListener('click', () => {
      const key = currentMonthKey();
      if (key !== month) goToMonth(key);
    });
    // The month opens Ant's month panel, any month of any year.
    document.getElementById('rec-month-label').addEventListener('click', (e) => {
      Ant.monthPicker(e.currentTarget, {
        value: month,
        onPick: (key) => { if (key !== month) goToMonth(key); },
      });
    });

    // ── The calendar's controls ──
    // Delegated, so one listener covers every day across every re-render.
    const calendar = document.getElementById('rec-calendar');
    calendar.addEventListener('click', (e) => {
      const add = e.target.closest('[data-add]');
      if (add) { openScheduleDialog({ dateIso: add.dataset.add }); return; }
      // Which occurrence was clicked does not matter: a schedule's fields
      // belong to the whole series, so the editor is keyed by the schedule.
      const chip = e.target.closest('.rec-occ');
      if (chip) { openScheduleDialog({ key: chip.dataset.key }); return; }
      const expand = e.target.closest('[data-expand]');
      if (expand) {
        const iso = expand.dataset.expand;
        if (expandedDays.has(iso)) expandedDays.delete(iso); else expandedDays.add(iso);
        renderCalendar();
        calendar.querySelector(`[data-expand="${CSS.escape(iso)}"]`)?.focus();
        return;
      }
      // A day's empty space starts a schedule on that day, as a press on a day
      // of Ant's Calendar selects it.
      const day = e.target.closest('[data-day]');
      if (day) openScheduleDialog({ dateIso: day.dataset.day });
    });

    // Seven columns while the card is wide enough for a chip's name, a list of
    // days below that. Measured on the card rather than the window, since the
    // sidebar and the zoom level decide its width as much as the window does.
    // The redraw waits a frame: drawing inside the observer would resize what
    // it is observing in the same pass.
    new ResizeObserver(([entry]) => {
      const narrow = entry.contentRect.width < LIST_BELOW_PX;
      if (narrow === listMode) return;
      listMode = narrow;
      requestAnimationFrame(renderCalendar);
    }).observe(calendar);

    // ── List → calendar ──
    // Hover marks the schedule wherever the month on screen draws it. Delegated
    // like the calendar's, so the listeners outlive every re-render.
    const rail = document.getElementById('rec-rail');

    function markRailHover(e) {
      const row = e.target.closest('.rec-rail-row');
      if (!row) return;
      railHoverKey = row.dataset.key;
      applyActiveHighlight();
    }

    function clearRailHover(e) {
      if (!e.target.closest('.rec-rail-row')) return;
      railHoverKey = null;
      applyActiveHighlight();
    }

    rail.addEventListener('mouseover', markRailHover);
    rail.addEventListener('mouseout', clearRailHover);
    rail.addEventListener('focusin', markRailHover);
    rail.addEventListener('focusout', clearRailHover);
    rail.addEventListener('click', (e) => {
      const foot = e.target.closest('[data-rail-action]');
      if (foot) {
        // A schedule created from here has no day behind it, so it opens on
        // today and the user moves the date if it belongs elsewhere.
        if (foot.dataset.railAction === 'create') openScheduleDialog({});
        else openDetectDialog(foot);
        return;
      }
      const row = e.target.closest('.rec-rail-row');
      if (row) openScheduleDialog({ key: row.dataset.key });
    });

    // The mark is the page's one piece of transient state, so Escape drops it.
    // A dialog on top handles its own Escape first.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || document.querySelector('.confirm-overlay')) return;
      if (pickedKey) clearPick();
    });

    window.addEventListener('currencychange', render);
    load();
  });
}());
