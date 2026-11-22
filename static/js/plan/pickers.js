'use strict';

// ─── pickers.js ─────────────────────────────────────────────────────────────
// The two pop-ups only the Plan section has, built on Ant.popover (so they
// place, dismiss and close one another like every other pop-up in the app):
//
//   PlanPickers.modules(at, groups, { placeholder, onPick, onCancel })
//       A Select's dropdown with a search box: the modules that may go on
//       the canvas, grouped by shelf. `at` is a point { x, y } (where a
//       link was dropped) or an element. groups: [{ label, items: [{ id,
//       label, icon, role, keywords }] }]. onPick(item), or onCancel() when
//       it closes with nothing picked.
//
//   PlanPickers.icons(anchor, { icons, value, role, onPick })
//       A grid of the icons a module may wear, in its role colour. `value`
//       is the icon worn now; onPick(name).
//
// Needs: Ant (widgets/ant.js), escapeHtml, planIcon.

(function () {
    // ── Module picker ──────────────────────────────────────────────────────

    function modules(at, groups, { placeholder = 'Search', onPick, onCancel } = {}) {
        const el = document.createElement('div');
        el.className = 'plan-picker';
        el.innerHTML = `
            <label class="plan-picker-search ant-input-affix-wrapper">${planIcon('magnifying-glass')}
                <input type="text" spellcheck="false" autocomplete="off" aria-label="${escapeHtml(placeholder)}"
                       placeholder="${escapeHtml(placeholder)}">
            </label>
            <div class="plan-picker-list" role="listbox"></div>`;
        const input = el.querySelector('input');
        const list = el.querySelector('.plan-picker-list');
        let visible = [];
        let active = 0;
        let picked = false;

        function render() {
            const q = input.value.trim().toLowerCase();
            visible = [];
            let html = '';
            for (const g of groups) {
                const items = g.items.filter((it) => !q
                    || it.label.toLowerCase().includes(q)
                    || (it.keywords || '').toLowerCase().includes(q));
                if (!items.length) continue;
                if (g.label) html += `<div class="ant-select-item-group">${escapeHtml(g.label)}</div>`;
                for (const it of items) {
                    const i = visible.push(it) - 1;
                    html += `<button type="button" class="plan-picker-item" role="option" data-i="${i}">
                        <span class="role-tile role-tile--sm" data-role="${escapeHtml(it.role || '')}">${planIcon(it.icon)}</span>
                        <span>${escapeHtml(it.label)}</span></button>`;
                }
            }
            list.innerHTML = html || '<div class="plan-picker-empty">No matches</div>';
            active = Math.min(active, Math.max(0, visible.length - 1));
            mark();
        }

        function mark() {
            list.querySelectorAll('.plan-picker-item').forEach((b) => {
                const on = Number(b.dataset.i) === active;
                b.classList.toggle('is-active', on);
                b.setAttribute('aria-selected', String(on));
                if (on) b.scrollIntoView({ block: 'nearest' });
            });
        }

        let pop = null;
        function choose(i) {
            const it = visible[i];
            if (!it) return;
            picked = true;
            pop.close();
            if (onPick) onPick(it);
        }

        input.addEventListener('input', () => { active = 0; render(); });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(visible.length - 1, active + 1); mark(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); mark(); }
            else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
        });
        list.addEventListener('click', (e) => {
            const b = e.target.closest('.plan-picker-item');
            if (b) choose(Number(b.dataset.i));
        });
        list.addEventListener('pointermove', (e) => {
            const b = e.target.closest('.plan-picker-item');
            if (b && Number(b.dataset.i) !== active) { active = Number(b.dataset.i); mark(); }
        });

        render();
        pop = Ant.popover(at, {
            content: el,
            className: 'plan-pop',
            arrow: false,
            gap: 4,
            onClose: () => { if (!picked && onCancel) onCancel(); },
        });
        input.focus();
    }

    // ── Icon picker ────────────────────────────────────────────────────────

    const ICON_COLUMNS = 6;
    const iconName = (name) => name.replace(/-/g, ' ');

    function icons(anchor, { icons: names, value, role = '', onPick } = {}) {
        const el = document.createElement('div');
        el.className = 'plan-icon-grid';
        el.dataset.role = role;
        el.setAttribute('aria-label', 'Choose an icon');
        el.innerHTML = names.map((name) =>
            `<button class="plan-icon-cell" type="button" data-icon="${escapeHtml(name)}" aria-pressed="${name === value}"
                aria-label="${escapeHtml(iconName(name))}" title="${escapeHtml(iconName(name))}">${planIcon(name)}</button>`).join('');

        const pop = Ant.popover(anchor, { content: el, className: 'plan-pop', arrow: false, gap: 4 });
        if (!pop) return;
        el.addEventListener('click', (e) => {
            const cell = e.target.closest('[data-icon]');
            if (!cell) return;
            pop.close();
            if (onPick) onPick(cell.dataset.icon);
            anchor.focus();
        });
        el.addEventListener('keydown', (e) => {
            const cell = e.target.closest('[data-icon]');
            const move = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: ICON_COLUMNS, ArrowUp: -ICON_COLUMNS }[e.key];
            if (!cell || !move) return;
            e.preventDefault();
            const cells = [...el.querySelectorAll('[data-icon]')];
            const next = cells[cells.indexOf(cell) + move];
            if (next) next.focus();
        });
        (el.querySelector('[aria-pressed="true"]') || el.querySelector('[data-icon]')).focus();
    }

    window.PlanPickers = { modules, icons };
}());
