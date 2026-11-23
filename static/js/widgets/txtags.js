'use strict';

// ─── Transaction tags (Transactions page) ────────────────────────────────────
// The tag pieces the ledger uses, kept out of pages/transactions.js so that
// file stays about the ledger itself. A transaction carries at most one tag; the
// tags themselves are a vocabulary of their own (handlers/tags.js).
//
//   TxTags.picker(input, { tags, value, allowKeep, onChoose, onBlur })
//       Turns a text input into Select showSearch over the tags: focusing it
//       lists them, typing narrows the list, and a name no tag has yet offers
//       'Create "…"' at the end. → { value(), setValue(choice) }
//   TxTags.resolve(choice)
//       → Promise<{ tagId, created }>. tagId is undefined for "keep", null for
//       "no tag", or an id; a "new" choice is created first, and `created` is
//       then the new tag.
//   TxTags.manage({ onChanged })
//       The Manage tags dialog: add, rename (renaming onto another tag's name
//       offers to merge the two) and delete. onChanged() runs on close if
//       anything changed.
//   TxTags.tagHtml(name)
//       A tag as the ledger draws it.
//
// A choice is what a picker holds: { kind: 'keep' } (several rows, leave each
// as it is), { kind: 'none' }, { kind: 'tag', id, name } or { kind: 'new', name }.
// A new tag is only created when the change it is part of is saved, so a dialog
// that is cancelled leaves no unused tag behind.
//
// Globals used: apiFetch (api.js), escapeHtml (escape.js), Ant (ant.js).

(function () {
    const esc = escapeHtml;
    // The longest name the backend accepts (services/tags.js MAX_TAG_NAME_LEN).
    const MAX_NAME = 30;

    const KEEP = { kind: 'keep' };
    const NONE = { kind: 'none' };

    /** A typed name as the backend will store it, or '' when it cannot be one. */
    function cleanName(raw) {
        const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
        return name.length <= MAX_NAME ? name : '';
    }

    const sameName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
    const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

    async function api(url, { method = 'GET', body } = {}) {
        const r = await apiFetch(url, body === undefined ? { method } : {
            method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
            const err = new Error(data.error || `${method} ${url} failed`);
            err.status = r.status;
            throw err;
        }
        return data;
    }

    const tagHtml = (name) => `<span class="ant-tag tx-tag" title="${esc(name)}">${esc(name)}</span>`;

    // ─── Picker ──────────────────────────────────────────────────────────────
    function picker(input, { tags, value = NONE, allowKeep = false, onChoose = null, onBlur = null }) {
        let choice = value;
        let list = null;
        // Until something is typed, the whole list shows: the input holds the
        // current tag's name, which is not a search.
        let searching = false;

        input.setAttribute('role', 'combobox');
        input.setAttribute('aria-autocomplete', 'list');
        input.setAttribute('aria-expanded', 'false');
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.maxLength = MAX_NAME;

        const optionValue = (c) => (c.kind === 'tag' ? `tag:${c.id}` : c.kind);

        function items() {
            const query = searching ? cleanName(input.value) : '';
            const out = [];
            if (!query) {
                if (allowKeep) out.push({ value: 'keep', label: 'Keep current', choice: KEEP });
                out.push({ value: 'none', label: 'No tag', choice: NONE });
            }
            const needle = query.toLowerCase();
            for (const t of tags()) {
                if (needle && !t.name.toLowerCase().includes(needle)) continue;
                out.push({ value: `tag:${t.id}`, label: t.name, choice: { kind: 'tag', id: t.id, name: t.name } });
            }
            if (query && !tags().some((t) => sameName(t.name, query))) {
                out.push({ value: 'new', label: `Create "${query}"`, choice: { kind: 'new', name: query } });
            }
            return out;
        }

        function show() {
            input.value = choice.kind === 'tag' || choice.kind === 'new' ? choice.name : '';
            input.placeholder = choice.kind === 'keep' ? 'Keep current' : 'No tag';
        }

        function open() {
            if (list) { list.update(items()); return; }
            list = Ant.listbox(input, {
                items: items(),
                isSelected: (v) => v === optionValue(choice),
                onPick: (it) => pick(it.choice),
                onDismiss: close,
                emptyText: 'No tags yet',
            });
            input.setAttribute('aria-expanded', 'true');
        }

        function close() {
            if (!list) return;
            list.close();
            list = null;
            input.setAttribute('aria-expanded', 'false');
        }

        function pick(next) {
            choice = next;
            searching = false;
            close();
            show();
            if (onChoose) onChoose(choice);
        }

        input.addEventListener('focus', open);
        input.addEventListener('mousedown', () => { if (document.activeElement === input) open(); });
        input.addEventListener('input', () => {
            searching = true;
            open();
            list.move(0);
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                if (!list) open();
                else list.move(e.key === 'ArrowDown' ? 1 : -1);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const it = list?.activeItem();
                if (it) pick(it.choice);
                else open();
            } else if (e.key === 'Escape' && list) {
                // Close the list first; a second Escape reaches the dialog or cell.
                e.preventDefault();
                e.stopPropagation();
                close();
                searching = false;
                show();
            } else if (e.key === 'Tab') {
                close();
            }
        });
        input.addEventListener('blur', () => {
            close();
            searching = false;
            show();
            if (onBlur) onBlur();
        });
        show();

        return {
            value: () => choice,
            setValue(next) { choice = next; searching = false; show(); },
        };
    }

    // ─── Saving a choice ─────────────────────────────────────────────────────
    /** Create the tag `name`. Another window may have made it meanwhile (a
     *  409), and then that tag is the answer. */
    async function createTag(name) {
        try {
            return (await api('/api/tags', { method: 'POST', body: { name } })).tag;
        } catch (err) {
            if (err.status !== 409) throw err;
            const { tags } = await api('/api/tags');
            const found = tags.find((t) => sameName(t.name, name));
            if (!found) throw err;
            return { id: found.id, name: found.name };
        }
    }

    async function resolve(choice) {
        if (choice.kind === 'keep') return { tagId: undefined, created: null };
        if (choice.kind === 'none') return { tagId: null, created: null };
        if (choice.kind === 'tag') return { tagId: choice.id, created: null };
        const created = await createTag(choice.name);
        return { tagId: created.id, created };
    }

    // ─── Manage tags ─────────────────────────────────────────────────────────
    function manage({ onChanged = null } = {}) {
        let tags = [];
        let changed = false;
        let busy = false;

        const body = `
            <form class="tx-tags-add" novalidate>
                <input type="text" class="ant-input" maxlength="${MAX_NAME}" placeholder="New tag"
                    aria-label="New tag name" autocomplete="off" spellcheck="false">
                <button type="submit" class="ant-btn ant-btn-default">${Ant.icon('plus')}Add</button>
            </form>
            <span class="ant-form-item-explain tx-tags-explain" aria-live="polite"></span>
            <div class="tx-tags-list">${Ant.spin('Loading tags')}</div>`;
        const { dialog, close } = Ant.modal({
            title: 'Manage tags',
            body,
            footer: '<button type="button" class="ant-btn ant-btn-default" data-act="close">Close</button>',
            width: 480,
            className: 'tx-tags-modal',
            canClose: () => !busy,
            onClose: () => { if (changed && onChanged) onChanged(); },
        });
        const $ = (sel) => dialog.querySelector(sel);
        const addInput = $('.tx-tags-add input');

        function explain(text) {
            $('.tx-tags-explain').textContent = text;
            addInput.setAttribute('aria-invalid', String(!!text));
        }

        async function refresh() {
            try {
                tags = (await api('/api/tags')).tags || [];
            } catch {
                $('.tx-tags-list').innerHTML = Ant.empty({ title: 'The tags could not be loaded', compact: true });
                return;
            }
            render();
        }

        function render() {
            const el = $('.tx-tags-list');
            if (!tags.length) {
                el.innerHTML = Ant.empty({ title: 'No tags yet', desc: 'Add one here, or from a transaction\'s Tags cell.', compact: true });
                return;
            }
            el.innerHTML = `<ul class="tx-tags-rows">${tags.map((t) => `
                <li class="tx-tags-row" data-id="${t.id}">
                    <span class="tx-tags-name">${tagHtml(t.name)}</span>
                    <span class="tx-tags-count ant-typography-secondary">${esc(plural(t.transactions, 'transaction'))}</span>
                    <button type="button" class="ant-btn ant-btn-text ant-btn-sm ant-btn-icon-only" data-act="rename"
                        aria-label="Rename ${esc(t.name)}" data-tip="Rename">${Ant.icon('edit')}</button>
                    <button type="button" class="ant-btn ant-btn-text ant-btn-sm ant-btn-icon-only ant-btn-dangerous" data-act="delete"
                        aria-label="Delete ${esc(t.name)}" data-tip="Delete">${Ant.icon('delete')}</button>
                </li>`).join('')}</ul>`;
        }

        /** Run one write; the list redraws from the backend afterwards. */
        async function write(task, failure) {
            busy = true;
            try {
                await task();
                changed = true;
            } catch {
                Ant.message.error(failure);
            }
            busy = false;
            await refresh();
        }

        async function add() {
            const name = cleanName(addInput.value);
            if (!name) { explain(addInput.value.trim() ? `Up to ${MAX_NAME} characters.` : 'Name the tag.'); return; }
            if (tags.some((t) => sameName(t.name, name))) { explain(`"${name}" is already a tag.`); return; }
            explain('');
            addInput.value = '';
            await write(() => api('/api/tags', { method: 'POST', body: { name } }), 'The tag could not be added.');
            addInput.focus();
        }

        function startRename(row, tag) {
            const cell = row.querySelector('.tx-tags-name');
            cell.innerHTML = `<input type="text" class="ant-input tx-tags-rename" maxlength="${MAX_NAME}" value="${esc(tag.name)}"
                aria-label="New name for ${esc(tag.name)}" autocomplete="off" spellcheck="false">`;
            const input = cell.querySelector('input');
            let done = false;
            async function finish(save) {
                if (done) return;
                done = true;
                const name = cleanName(input.value);
                if (!save || !name || name === tag.name) { render(); return; }
                const other = tags.find((t) => t.id !== tag.id && sameName(t.name, name));
                if (other) {
                    const ok = await Ant.confirm({
                        title: `Merge "${tag.name}" into "${other.name}"?`,
                        content: `<p>${esc(plural(tag.transactions, 'transaction'))} tagged "${esc(tag.name)}" will be tagged "${esc(other.name)}", and "${esc(tag.name)}" is deleted.</p>`,
                        okText: 'Merge',
                    });
                    if (!ok) { render(); return; }
                    await write(() => api(`/api/tags/${tag.id}/merge`, { method: 'POST', body: { into: other.id } }), 'The tags could not be merged.');
                    return;
                }
                await write(() => api(`/api/tags/${tag.id}`, { method: 'PUT', body: { name } }), 'The tag could not be renamed.');
            }
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); finish(true); }
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
            });
            input.addEventListener('blur', () => finish(true));
            input.focus();
            input.select();
        }

        async function remove(btn, tag) {
            const ok = await Ant.popconfirm(btn, {
                title: `Delete "${tag.name}"?`,
                desc: tag.transactions ? `${plural(tag.transactions, 'transaction')} will have no tag.` : '',
                okText: 'Delete',
                danger: true,
            });
            if (!ok) return;
            await write(() => api(`/api/tags/${tag.id}`, { method: 'DELETE' }), 'The tag could not be deleted.');
        }

        $('.tx-tags-add').addEventListener('submit', (e) => { e.preventDefault(); add(); });
        addInput.addEventListener('input', () => explain(''));
        dialog.addEventListener('click', (e) => {
            const act = e.target.closest('[data-act]')?.dataset.act;
            if (!act) return;
            if (act === 'close') { close(); return; }
            const row = e.target.closest('.tx-tags-row');
            const tag = row && tags.find((t) => t.id === Number(row.dataset.id));
            if (!tag || busy) return;
            if (act === 'rename') startRename(row, tag);
            if (act === 'delete') remove(e.target.closest('[data-act]'), tag);
        });
        addInput.focus();
        refresh();
    }

    window.TxTags = { KEEP, NONE, picker, resolve, manage, tagHtml };
}());
