'use strict';

// ─── format.js ──────────────────────────────────────────────────────────────
// Number formatting for the Plan section. Projections are estimates, so money
// shows in whole units by default; inputs still accept decimals.
//
// The choices (currency symbol, its position, the digit separators) are the
// user's Format preferences, read live from core/currency.js on every call, so
// a change in Preferences needs no reload here: views redraw on Manage's
// 'currencychange' event and pick it up.
//
//   Fmt.money(1234.5)                     '$1,235'
//   Fmt.money(-80, { sign: true })        '-$80'
//   Fmt.money(1250000, { compact: true }) '$1.25M'
//   Fmt.pct(4.5)                          '4.5%'
//   Fmt.parseNumber('1.234,5')            1234.5 (with the 'eu' format)
//
// Needs: core/currency.js (currencyFormat).

(function () {
    function group(intDigits, sep) {
        return intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
    }

    /** A plain number with grouping: 1234.5 → '1,234.5' (up to `decimals`). */
    function number(v, decimals = 0) {
        if (!Number.isFinite(v)) return '—';
        const { group: g, decimal: d } = currencyFormat();
        const fixed = Math.abs(v).toFixed(decimals);
        let [int, dec = ''] = fixed.split('.');
        dec = dec.replace(/0+$/, '');
        const body = group(int, g) + (dec ? d + dec : '');
        return (v < 0 && Number(fixed) !== 0 ? '-' : '') + body;
    }

    function withSymbol(body) {
        const { symbol, position } = currencyFormat();
        if (!symbol) return body;
        return position === 'suffix' ? `${body}\u00a0${symbol}` : `${symbol}${body}`;
    }

    const UNITS = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];

    function compactBody(abs) {
        for (const [size, unit] of UNITS) {
            if (abs >= size * 0.9995) {
                const scaled = abs / size;
                const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
                return number(Number(scaled.toFixed(digits)), digits) + unit;
            }
        }
        return number(Math.round(abs));
    }

    function money(v, { compact = false, sign = false, decimals = 0 } = {}) {
        if (!Number.isFinite(v)) return '—';
        const rounded = Number(v.toFixed(decimals));
        const abs = Math.abs(rounded);
        const body = compact ? compactBody(abs) : number(abs, decimals);
        const prefix = rounded < 0 ? '-' : (sign && rounded > 0 ? '+' : '');
        return prefix + withSymbol(body);
    }

    function pct(v, { sign = false, decimals = 2 } = {}) {
        if (!Number.isFinite(v)) return '—';
        const s = number(Math.abs(v), decimals);
        const prefix = v < 0 ? '-' : (sign && v > 0 ? '+' : '');
        return `${prefix}${s}%`;
    }

    /** Parse what someone typed into an amount field. Returns NaN when the
     *  text holds no number. Accepts the active separators, a symbol, spaces. */
    function parseNumber(text) {
        const { group: g, decimal: d } = currencyFormat();
        let s = String(text ?? '').trim();
        if (!s) return NaN;
        const negative = /^[-−(]/.test(s);
        s = s.split(g).join('').replace(/\s/g, '');
        if (d !== '.') s = s.split(d).join('.');
        s = s.replace(/[^0-9.]/g, '');
        if (!s || s === '.') return NaN;
        const n = Number(s);
        return negative ? -n : n;
    }

    /** A number as it should sit in an editable field: grouped, no symbol,
     *  decimals kept only when present. */
    function inputValue(v, decimals = 2) {
        return Number.isFinite(v) ? number(v, decimals) : '';
    }

    /** Tidy an amount as it is typed: only digits, one decimal separator and
     *  (when allowed) a leading minus survive, and the whole part is grouped.
     *  Typed group separators are dropped, since grouping is automatic. */
    function formatTyping(text, { negative = false, decimals = true } = {}) {
        const { group: g, decimal: d } = currencyFormat();
        const s = String(text ?? '');
        let whole = '';
        let frac = '';
        let hasDecimal = false;
        for (const ch of s) {
            if (ch >= '0' && ch <= '9') { if (hasDecimal) frac += ch; else whole += ch; }
            else if (ch === d && decimals && !hasDecimal) hasDecimal = true;
        }
        whole = whole.replace(/^0+(?=\d)/, '');
        const minus = negative && /^\s*[-−]/.test(s) ? '-' : '';
        return minus + group(whole, g) + (hasDecimal ? d + frac : '');
    }

    function symbolParts() {
        const { symbol, position } = currencyFormat();
        return { symbol, suffix: position === 'suffix' };
    }

    window.Fmt = { money, pct, number, parseNumber, inputValue, formatTyping, symbolParts };
}());
