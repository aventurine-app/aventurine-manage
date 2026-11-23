'use strict';

// ─── dashgrid.js ──────────────────────────────────────────────────────────────
// The Dashboard's layout engine: where every card sits on its 12-column grid.
// Pure functions over plain card lists ({ id, x, y, w, h, ... }; x and w in
// columns, y and h in rows), so drag, resize, the keyboard and the widget list
// all place cards through one set of rules, and the rules are pinned under
// `node --test` (electron/backend/__tests__/dashGrid.test.js) with no DOM.
//
// THE RULE. A card stays where the user put it. Moving or resizing one never
// pulls another up into the space it left, so a layout may keep holes; a card
// that would overlap the one being placed is pushed straight down, just far
// enough, and anything it then lands on is pushed in turn. Every function
// returns new card objects and leaves its input untouched, which is what lets a
// drag preview a layout and throw it away.
//
// Dual-environment, like txparse.js: window.DashGrid in the browser
// (pages/dashboard.html loads it before dashboard.js), module.exports under Node.

(function () {
    const COLS = 12;

    const overlapX = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w;
    const byPosition = (a, b) => a.y - b.y || a.x - b.x;

    /** Drop each card, in the order given, onto the skyline of its columns.
     *  A card wider than the grid is narrowed to it, and one hanging past the
     *  right edge is pulled back in. */
    function stack(order) {
        const sky = new Array(COLS).fill(0);
        return order.map((card) => {
            const w = Math.min(Math.max(card.w, 1), COLS);
            const x = Math.min(Math.max(card.x, 0), COLS - w);
            let y = 0;
            for (let c = x; c < x + w; c++) y = Math.max(y, sky[c]);
            for (let c = x; c < x + w; c++) sky[c] = y + card.h;
            return { ...card, x, y, w };
        });
    }

    /** Tidy a layout: restack it in its own reading order, every card risen
     *  as far as it can go. Used for the built-in layout only. */
    const pack = (cards) => stack([...cards].sort(byPosition));

    const overlaps = (a, b) => overlapX(a, b) && a.y < b.y + b.h && b.y < a.y + a.h;

    /** The card brought inside the grid's edges, at row 0 or below. */
    function fit(card) {
        const w = Math.min(Math.max(card.w, 1), COLS);
        const x = Math.min(Math.max(card.x, 0), COLS - w);
        return { ...card, x, y: Math.max(card.y, 0), w };
    }

    /** Lay `order` down on top of `placed`, each card where it is unless it
     *  overlaps one already down, in which case it drops just below it. */
    function pushDown(placed, order) {
        const out = [...placed];
        for (const c of order) {
            const card = fit(c);
            for (let hit = out.find((o) => overlaps(o, card)); hit; hit = out.find((o) => overlaps(o, card))) {
                card.y = hit.y + hit.h;
            }
            out.push(card);
        }
        return out;
    }

    /** A layout with no overlaps, every card kept where it is or, when it
     *  collides with one earlier in reading order, moved down to clear it. */
    const settle = (cards) => pushDown([], [...cards].sort(byPosition));

    /** `cards` with `active` fixed exactly where it is and the rest pushed down
     *  out of its way. */
    const placeFixed = (cards, active) =>
        pushDown([fit(active)], cards.filter((c) => c.id !== active.id).sort(byPosition));

    /**
     * The layout with `active` moved to (active.x, active.y). It lands where it
     * was dropped, except over a card whose middle sits above its own: there it
     * settles just below that card instead of shoving it, which is how a card is
     * dragged down past a neighbour. Cards it covers are pushed down; none move
     * up. `active` need not be in `cards` yet, which is how a card dragged in
     * from the widget list is placed.
     */
    function arrangeMove(cards, active) {
        const others = cards.filter((c) => c.id !== active.id);
        const mid = (c) => c.y + c.h / 2;
        const card = fit(active);
        for (;;) {
            const above = others.filter((o) => overlaps(o, card) && mid(o) < mid(card));
            if (!above.length) break;
            card.y = Math.max(...above.map((o) => o.y + o.h));
        }
        return placeFixed(others, card);
    }

    /** A card resized or re-shaped where it stands: it keeps its spot, and
     *  only what it now covers is pushed down. */
    const arrangeInPlace = placeFixed;

    /** One row up (dir -1) or down (dir 1), pushing down whatever it lands on
     *  — the keyboard's up and down. null when it cannot go: at the top row, or
     *  going down with nothing but empty rows below. */
    function moveVertical(cards, id, dir) {
        const card = cards.find((c) => c.id === id);
        if (!card) return null;
        const y = card.y + dir;
        const others = cards.filter((c) => c.id !== id);
        if (y < 0 || (dir > 0 && y > bottom(others))) return null;
        return placeFixed(others, { ...card, y });
    }

    /** The highest open spot for a new card `w` columns by `h` rows, leftmost
     *  on a tie: where a card added from the widget list lands. A hole in the
     *  layout counts when the card fits in it. */
    function firstFit(cards, w, h = 1) {
        const width = Math.min(Math.max(w, 1), COLS);
        const height = Math.max(h, 1);
        for (let y = 0; ; y++) {
            for (let x = 0; x <= COLS - width; x++) {
                const spot = { x, y, w: width, h: height };
                if (!cards.some((c) => overlaps(c, spot))) return { x, y };
            }
        }
    }

    /** The row just below the lowest card; 0 for an empty layout. */
    const bottom = (cards) => cards.reduce((m, c) => Math.max(m, c.y + c.h), 0);

    const DashGrid = { COLS, stack, pack, settle, arrangeMove, arrangeInPlace, moveVertical, firstFit, bottom, byPosition };

    if (typeof module !== 'undefined' && module.exports) module.exports = DashGrid;
    else window.DashGrid = DashGrid;
}());
