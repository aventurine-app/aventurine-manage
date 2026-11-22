'use strict';

// ─── components.js ──────────────────────────────────────────────────────────
// HTML for Ant Design's display components, in Manage's ant.css markup, for
// the Plan section's workspace pages (Goals, Analyze, Compare). Each builder
// returns a string; every caller's text passes through escapeHtml here, so a
// plan or goal name can never become markup. Behaviour stays with the views:
// a builder only marks its controls (data-* attributes) for them to listen to.
//
//   Components.pageHead({ start, extra })             a page's actions row
//   Components.statCard({ title, value, ... })         Statistic, in a card
//   Components.tag(text, { tone, icon })                Tag
//   Components.progress(fraction, { status, label })   Progress (line)
//   Components.switchField({ name, label, checked })   Switch with its words
//   Components.segmented(options, value, { attr })     Segmented
//   Components.tabs(items, active, { label })          Tabs (line)
//   Components.planPick({ act, id })                   a Select-shaped plan dropdown
//   Components.empty({ title, text, action })          Empty
//
// The few parts that are the section's own (the page head, the plan
// dropdown, a stat's tone, a goal met late) are drawn by plan/kit.css.
//
// Needs: escapeHtml, planIcon, Ant (Ant.empty).

(function () {
    const esc = escapeHtml;

    // The tone of a status, as Ant's status colours name it.
    const TONES = new Set(['success', 'warning', 'error', 'processing']);

    /** A page's header: what the page shows (`start`, such as its plan) on
     *  the left and its actions (`extra`) on the right, both markup from these
     *  builders. */
    function pageHead({ start = '', extra = '' }) {
        return `<div class="page-head">
            ${start ? `<div class="page-start">${start}</div>` : ''}
            <div class="page-extra">${extra}</div>
        </div>`;
    }

    /** A Statistic in its own small card. `tone`: 'up' | 'down' | 'warn' |
     *  'muted' colours the figure; `icon` leads it. */
    function statCard({ title, value, suffix = '', icon = '', tone = '' }) {
        return `<div class="ant-card ant-card-small plan-stat"><div class="ant-card-body">
            <div class="ant-statistic-title">${esc(title)}</div>
            <div class="ant-statistic-content${tone ? ` plan-stat-${tone}` : ''}">${icon ? planIcon(icon) : ''}<span>${esc(value)}</span>${
                suffix ? `<span class="plan-stat-suffix">${esc(suffix)}</span>` : ''}</div>
        </div></div>`;
    }

    /** A Tag. `tone`: 'success' | 'warning' | 'error' | 'processing', or none
     *  for the default grey. */
    function tag(text, { tone = '', icon = '', title = '' } = {}) {
        const cls = TONES.has(tone) ? ` ant-tag-${tone}` : '';
        return `<span class="ant-tag plan-tag${cls}"${title ? ` title="${esc(title)}"` : ''}>${icon ? planIcon(icon) : ''}<span>${esc(text)}</span></span>`;
    }

    /** A line Progress at `fraction` (0..1). `status`: 'success' shows a tick
     *  in place of the figure and 'warning' a clock (met, but late), as the
     *  Goals stat cards do; 'exception' and 'warning' colour the bar. */
    const PROGRESS_ICONS = { success: 'check-circle', warning: 'clock' };
    function progress(fraction, { status = 'normal', label = 'Progress' } = {}) {
        const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
        const text = PROGRESS_ICONS[status] ? planIcon(PROGRESS_ICONS[status]) : `${pct}%`;
        const cls = status === 'warning' ? 'plan-progress-late' : `ant-progress-status-${status}`;
        return `<div class="ant-progress plan-progress ${cls}" role="progressbar"
                aria-label="${esc(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
            <div class="ant-progress-outer"><div class="ant-progress-inner"><div class="ant-progress-bg" style="width: ${pct}%"></div></div></div>
            <span class="ant-progress-text">${text}</span>
        </div>`;
    }

    /** A small Switch with its words beside it; pressing either toggles it.
     *  The view listens for clicks on [data-switch="name"]. */
    function switchField({ name, label, checked }) {
        return `<label class="plan-switch-field">
            <button class="ant-switch ant-switch-small" type="button" role="switch" data-switch="${esc(name)}" aria-checked="${!!checked}"></button>
            <span>${esc(label)}</span>
        </label>`;
    }

    /** A Segmented control. `options`: [[value, text, icon?]]; each button
     *  carries data-<attr>="value". `chips` is the compact form. */
    function segmented(options, value, { attr, label, chips = false, block = false } = {}) {
        const cls = `ant-segmented${chips ? ' ant-segmented-sm plan-chips' : ''}${block ? ' ant-segmented-block' : ''}`;
        return `<div class="${cls}" role="group" aria-label="${esc(label)}">${options.map(([v, text, icon]) =>
            `<button class="ant-segmented-item" type="button" data-${attr}="${esc(String(v))}" aria-pressed="${String(v) === String(value)}">${
                icon ? planIcon(icon) : ''}<span>${esc(text)}</span></button>`).join('')}</div>`;
    }

    /** Line Tabs. `items`: [[id, text, icon?]]; each tab carries data-tab. */
    function tabs(items, active, { label }) {
        return `<div class="ant-tabs-nav plan-tabs-nav" role="tablist" aria-label="${esc(label)}">${items.map(([id, text, icon]) => {
            const on = id === active;
            return `<button class="ant-tabs-tab" type="button" role="tab" data-tab="${esc(id)}" aria-selected="${on}" tabindex="${on ? 0 : -1}">${
                icon ? planIcon(icon) : ''}<span>${esc(text)}</span></button>`;
        }).join('')}</div>`;
    }

    /** A dropdown that shows one plan, shaped like a Select. The view fills
     *  .plan-pick-name and opens the plans' menu on [data-act="act"]. */
    function planPick({ act = 'plan', id = '', label = 'Plan' }) {
        return `<button class="field-select plan-pick" type="button" data-act="${esc(act)}" aria-haspopup="menu" aria-expanded="false"
                aria-label="${esc(label)}"${id ? ` id="${esc(id)}"` : ''}>
            ${planIcon('file')}<span class="plan-pick-name"></span>${planIcon('caret-down')}</button>`;
    }

    /** An Empty: a title, a line of explanation and an optional action (a
     *  primary button marked data-act). */
    function empty({ title = '', text = '', action = null }) {
        const actionHtml = action
            ? `<button class="ant-btn ant-btn-primary" type="button" data-act="${esc(action.act)}">${
                action.icon ? planIcon(action.icon) : ''}<span>${esc(action.label)}</span></button>`
            : '';
        return Ant.empty({ title, desc: text, actionHtml });
    }

    /** Flip a Switch built by switchField; returns its new state. */
    function toggleSwitch(el) {
        const on = el.getAttribute('aria-checked') !== 'true';
        el.setAttribute('aria-checked', String(on));
        return on;
    }

    window.Components = { pageHead, statCard, tag, progress, switchField, segmented, tabs, planPick, empty, toggleSwitch };
}());
