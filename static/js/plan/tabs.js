'use strict';

// ─── tabs.js ────────────────────────────────────────────────────────────────
// The plans as tabs across the top of the plan builder (Manage's sidebar
// holds the workspaces). An editable card tab bar:
//
//   - click a tab to open its plan; drag it sideways to move it
//   - × deletes the plan (after asking); + makes a new plan, imports one, or
//     exports them all (a zip, or one PDF report)
//   - double-click or F2 renames; the right-click menu (and Shift+F10) also
//     duplicates and exports
//   - arrows, Home and End move along the tabs; Enter opens; Delete deletes
//
// It also mirrors PlanStore.state.workspace onto the app root as
// data-workspace, which workbench.css uses to show only the open workspace.

(function () {
    const app = document.getElementById('app');
    const builder = app && app.querySelector('.builder');
    if (!builder) return;

    const bar = document.createElement('div');
    bar.className = 'plan-tabs';
    bar.innerHTML = `
        <div class="plan-tabs-list" role="tablist" aria-label="Plans" aria-orientation="horizontal"></div>
        <button class="plan-tabs-add" type="button" aria-haspopup="menu" aria-expanded="false"
            aria-label="Plans" title="New plan (Ctrl+T), import or export">${planIcon('plus')}</button>`;
    builder.prepend(bar);

    const list = bar.querySelector('.plan-tabs-list');
    const addBtn = bar.querySelector('.plan-tabs-add');

    // ── Drawing ────────────────────────────────────────────────────────────

    let renaming = null;
    let sig = null;

    function render() {
        if (renaming) return;
        const { tabs, activeId } = PlanStore.state;
        const next = `${tabs.map((id) => `${id}:${PlanStore.planName(id)}`).join('|')}#${activeId}`;
        if (next === sig) return;
        sig = next;
        const focused = document.activeElement?.closest?.('.plan-tab')?.dataset.id;
        list.innerHTML = tabs.map((id) => {
            const on = id === activeId;
            const name = escapeHtml(PlanStore.planName(id));
            return `<div class="plan-tab" role="tab" data-id="${escapeHtml(id)}" aria-selected="${on}"
                    tabindex="${on ? 0 : -1}" title="${name}">
                <span class="plan-tab-name">${name}</span>
                <button class="plan-tab-close" type="button" tabindex="-1" aria-label="Delete ${name}" title="Delete plan">${planIcon('x')}</button>
            </div>`;
        }).join('');
        if (focused) tabEl(focused)?.focus();
        tabEl(activeId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    const tabEl = (id) => id && list.querySelector(`.plan-tab[data-id="${CSS.escape(id)}"]`);

    function renderWorkspace() {
        app.dataset.workspace = PlanStore.state.workspace;
    }

    // ── Actions ────────────────────────────────────────────────────────────

    function openPlan(id) {
        PlanStore.setWorkspace('plans');
        PlanStore.openPlan(id);
    }

    function newPlan() {
        PlanStore.setWorkspace('plans');
        PlanStore.newPlan();
    }

    /** Import a plan file and open it. It starts in the click that asked for
     *  it, so the file picker may open; cancelling it changes nothing. */
    async function importPlan() {
        const plan = await PlanStore.importPlan();
        if (plan) PlanStore.setWorkspace('plans');
    }

    async function confirmDelete(id) {
        const ok = await Ant.confirm({
            title: 'Delete Plan',
            content: `${escapeHtml(PlanStore.planName(id))} and everything on its canvas will be deleted. This cannot be undone.`,
            okText: 'Delete',
            danger: true,
        });
        if (ok) PlanStore.deletePlan(id);
    }

    function tabMenu(id, anchor) {
        Ant.dropdown(anchor, { items: [
            { label: 'Rename', iconHtml: planIcon('pencil-simple'), onClick: () => startRename(id) },
            { label: 'Duplicate', iconHtml: planIcon('copy'), onClick: () => PlanStore.duplicatePlan(id) },
            { label: 'Export…', iconHtml: planIcon('export'), onClick: () => ExportMenu.plan(id) },
            { type: 'divider' },
            { label: 'Delete', iconHtml: planIcon('trash'), danger: true, onClick: () => confirmDelete(id) },
        ] });
    }

    function startRename(id) {
        const tab = tabEl(id);
        if (!tab) return;
        renaming = id;
        const nameEl = tab.querySelector('.plan-tab-name');
        const input = document.createElement('input');
        input.className = 'plan-tab-rename';
        input.value = PlanStore.planName(id);
        input.maxLength = window.PlanModel.LIMITS.name;
        input.size = Math.max(8, input.value.length);
        input.setAttribute('aria-label', 'Plan name');
        nameEl.replaceWith(input);
        input.focus();
        input.select();
        let done = false;
        // Enter and Escape hand the focus back to the tab; a click elsewhere keeps it.
        const finish = (save, refocus = false) => {
            if (done) return;
            done = true;
            renaming = null;
            sig = null;
            if (save && input.value.trim()) PlanStore.renamePlan(id, input.value);
            render();
            if (refocus) tabEl(id)?.focus();
        };
        input.addEventListener('input', () => { input.size = Math.max(8, input.value.length); });
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') finish(true, true);
            else if (e.key === 'Escape') finish(false, true);
        });
        input.addEventListener('blur', () => finish(true));
        for (const type of ['pointerdown', 'click', 'dblclick']) input.addEventListener(type, (e) => e.stopPropagation());
    }

    // ── Pointer: click opens, drag moves ───────────────────────────────────
    // A press that does not travel is a click (as is one from assistive tech,
    // which sends no pointer events); the click a drag ends with is not.

    let drag = null;
    let dragged = false;

    list.addEventListener('pointerdown', (e) => {
        const tab = e.target.closest('.plan-tab');
        if (!tab || e.button !== 0 || renaming || e.target.closest('.plan-tab-close')) return;
        drag = { id: tab.dataset.id, x0: e.clientX, active: false, tab, target: null };
        tab.setPointerCapture(e.pointerId);
    });

    list.addEventListener('pointermove', (e) => {
        if (!drag) return;
        if (!drag.active && Math.abs(e.clientX - drag.x0) < 5) return;
        drag.active = true;
        drag.tab.classList.add('is-dragging');
        const tabs = [...list.querySelectorAll('.plan-tab')];
        tabs.forEach((t) => t.classList.remove('is-drop-before', 'is-drop-after'));
        const over = tabs.find((t) => {
            const r = t.getBoundingClientRect();
            return e.clientX >= r.left && e.clientX < r.right;
        });
        if (over && over !== drag.tab) {
            const r = over.getBoundingClientRect();
            const before = e.clientX < r.left + r.width / 2;
            over.classList.add(before ? 'is-drop-before' : 'is-drop-after');
            drag.target = { id: over.dataset.id, before };
        } else {
            drag.target = null;
        }
    });

    function endDrag() {
        if (!drag) return;
        const d = drag;
        drag = null;
        if (!d.active) return;
        dragged = true;
        setTimeout(() => { dragged = false; }, 0);
        sig = null;
        if (d.target) moveTab(d.id, d.target.id, d.target.before);
        else render();
    }
    list.addEventListener('pointerup', endDrag);
    list.addEventListener('pointercancel', endDrag);

    function moveTab(id, targetId, before) {
        const order = PlanStore.state.tabs.filter((x) => x !== id);
        let i = order.indexOf(targetId);
        if (!before) i += 1;
        order.splice(i, 0, id);
        PlanStore.reorderTabs(order);
    }

    list.addEventListener('click', (e) => {
        const close = e.target.closest('.plan-tab-close');
        if (close) { confirmDelete(close.closest('.plan-tab').dataset.id); return; }
        const tab = e.target.closest('.plan-tab');
        if (tab && !dragged && !renaming) openPlan(tab.dataset.id);
    });
    list.addEventListener('dblclick', (e) => {
        const tab = e.target.closest('.plan-tab');
        if (tab && !e.target.closest('.plan-tab-close')) startRename(tab.dataset.id);
    });
    list.addEventListener('contextmenu', (e) => {
        const tab = e.target.closest('.plan-tab');
        if (!tab) return;
        e.preventDefault();
        tabMenu(tab.dataset.id, { x: e.clientX, y: e.clientY });
    });

    // ── Keyboard ───────────────────────────────────────────────────────────
    // One tab is in the Tab order (the open plan's); arrows move between them
    // and Ctrl+Shift+arrows move the focused tab itself.

    list.addEventListener('keydown', (e) => {
        const tab = e.target.closest('.plan-tab');
        if (!tab || e.target !== tab) return;
        const tabs = [...list.querySelectorAll('.plan-tab')];
        const i = tabs.indexOf(tab);
        const id = tab.dataset.id;
        const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (step && (e.ctrlKey || e.metaKey) && e.shiftKey) {
            e.preventDefault();
            const j = i + step;
            if (j >= 0 && j < tabs.length) moveTab(id, tabs[j].dataset.id, step < 0);
        } else if (step) {
            e.preventDefault();
            focusTab(tabs[(i + step + tabs.length) % tabs.length]);
        } else if (e.key === 'Home' || e.key === 'End') {
            e.preventDefault();
            focusTab(tabs[e.key === 'Home' ? 0 : tabs.length - 1]);
        } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openPlan(id);
        } else if (e.key === 'F2') {
            e.preventDefault();
            startRename(id);
        } else if (e.key === 'Delete') {
            e.preventDefault();
            confirmDelete(id);
        } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
            e.preventDefault();
            const r = tab.getBoundingClientRect();
            tabMenu(id, { x: r.left, y: r.bottom + 4 });
        }
    });

    function focusTab(tab) {
        for (const t of list.querySelectorAll('.plan-tab')) t.tabIndex = t === tab ? 0 : -1;
        tab.focus();
        tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    // A wheel over the bar scrolls it sideways.
    list.addEventListener('wheel', (e) => {
        if (!e.deltaY || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
        list.scrollLeft += e.deltaY;
        e.preventDefault();
    }, { passive: false });

    addBtn.addEventListener('click', () => Ant.dropdown(addBtn, { items: [
        { label: 'New plan', iconHtml: planIcon('plus'), onClick: newPlan },
        { label: 'Import plan…', iconHtml: planIcon('download-simple'), onClick: importPlan },
        { type: 'divider' },
        { label: 'Export all plans…', iconHtml: planIcon('file-zip'), onClick: ExportMenu.all },
        { label: 'Report of all plans…', iconHtml: planIcon('file-pdf'), onClick: ExportMenu.reportAll },
    ] }));

    PlanStore.on((c) => {
        if (c.type === 'tabs' || c.type === 'plan') render();
        else if (c.type === 'workspace') renderWorkspace();
    });

    renderWorkspace();
    render();
}());
