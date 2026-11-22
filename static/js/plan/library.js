'use strict';

// ─── library.js ─────────────────────────────────────────────────────────────
// The module library: every preset from the catalog, listed across the top of
// the plan builder and grouped by category, each a tile in its role's colour.
//
//   press         preview the module in the inspector (its settings, read-only)
//   double-click  add it in the middle of the view
//   drag          drop it on the canvas (canvas.js handles the drop)
//
// A tile shows its icon; its name is its tooltip and accessible name, and the
// inspector names it on a press. Arrow keys move along the bar.

(function () {
    const C = window.PlanCatalog;
    const root = document.getElementById('library');
    if (!root) return;

    const PRESET_TYPE = 'application/x-citrine-preset';

    root.innerHTML = C.CATEGORIES.map((cat) => {
        const items = C.PRESETS.filter((p) => p.cat === cat.id);
        if (!items.length) return '';
        return `<div class="lib-group" role="group" aria-label="${escapeHtml(cat.name)}">
            <span class="lib-group-name" aria-hidden="true">${escapeHtml(cat.name)}</span>
            <div class="lib-group-items">${items.map((p) => `
                <button class="lib-tile" type="button" draggable="true" data-preset="${p.id}" aria-pressed="false"
                        aria-label="${escapeHtml(p.name)}, ${escapeHtml(C.SWATCHES[C.swatchOf(p)].label)}" title="${escapeHtml(p.name)}">
                    <span class="role-tile" data-role="${C.swatchOf(p)}">${planIcon(p.icon)}</span>
                </button>`).join('')}
            </div>
        </div>`;
    }).join('');

    const tiles = [...root.querySelectorAll('.lib-tile')];

    root.addEventListener('click', (e) => {
        const tile = e.target.closest('.lib-tile');
        if (tile) PlanStore.previewPreset(tile.dataset.preset);
    });

    root.addEventListener('dblclick', (e) => {
        const tile = e.target.closest('.lib-tile');
        if (tile) Canvas.addAtCenter(tile.dataset.preset);
    });

    root.addEventListener('dragstart', (e) => {
        const tile = e.target.closest('.lib-tile');
        if (!tile) return;
        e.dataTransfer.setData(PRESET_TYPE, tile.dataset.preset);
        e.dataTransfer.effectAllowed = 'copy';
        // Drag the coloured tile, not the whole button.
        e.dataTransfer.setDragImage(tile.querySelector('.role-tile'), 16, 16);
    });

    root.addEventListener('keydown', (e) => {
        const tile = e.target.closest('.lib-tile');
        if (!tile || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return;
        e.preventDefault();
        const i = tiles.indexOf(tile);
        tiles[(i + (e.key === 'ArrowRight' ? 1 : tiles.length - 1)) % tiles.length].focus();
    });

    /** Mark the module previewed in the inspector. */
    function markActive() {
        const id = PlanStore.state.preview;
        for (const el of tiles) el.setAttribute('aria-pressed', String(el.dataset.preset === id));
    }
    PlanStore.on((c) => { if (c.type === 'selection') markActive(); });
}());
