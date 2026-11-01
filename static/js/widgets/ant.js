'use strict';
// ============================================================================
// ant.js — Ant Design's interactive pieces, for the pages drawn in it.
// ============================================================================
// The frontend has no framework (see CLAUDE.md), so Ant Design is rebuilt
// rather than imported: static/css/ant.css draws it, and this file is the part
// that needs script. Loaded per page after the shared block, because Modal is
// UI.dialog (shell/ui.js) underneath: Escape, stacking and the backdrop behave
// exactly like every other dialog in the app.
//
//   Ant.icon(name)                → icon markup (Ant Design Icons, MIT, inlined:
//                                   CSP allows no data: images or icon fonts)
//   Ant.empty({ title, desc, compact, action: { label, href } | { label, name } })
//                                 → Empty markup, with Ant's simple image; a
//                                   `name` action is a button carrying
//                                   data-empty-action="name"
//   Ant.modal({ title, body, footer, width, className, onClose, canClose })
//                                 → { overlay, dialog, close, setTitle(text) }.
//                                   body/footer are trusted markup; escape what
//                                   goes into them. canClose() → false keeps it
//                                   open (a write in flight).
//   Ant.confirm({ title, content, okText, cancelText, danger })
//                                 → Promise<boolean>, Modal.confirm. content is
//                                   trusted markup.
//   Ant.popconfirm(anchor, { title, desc, okText, cancelText, danger })
//                                 → Promise<boolean>, true when confirmed
//   Ant.monthPicker(anchor, { value: 'YYYY-MM', onPick(ym), max: 'YYYY-MM' })
//                                 → DatePicker's month panel under `anchor`;
//                                   months after `max` (optional) are disabled
//   Ant.monthPanel(host, { value, onPick(ym), max })
//                                 → { focus() }; the same panel drawn into
//                                   `host`, for a pop-up of the page's own
//   Ant.message.success(text) / .error(text) / .info(text), each with an
//                                 optional { duration } in ms
//   Ant.tabs(list, { onChange(key) })
//                                 → select(key); line Tabs' keys and selection
//                                   over role="tab" buttons carrying data-tab
//   Ant.whileLoading(btn, task)   → task's result, null if it threw; `btn`
//                                   shows Button.loading meanwhile
//   Ant.isLoading(btn)            → true while it does
//   Ant.popover(anchor, { title, content, className, placement, align, onClose })
//                                 → { el, body, close, reposition }, or null
//                                   when pressing the anchor again closed it
//   Ant.multiSelect(root, { options, value, placeholder, ariaLabel, search, onChange })
//                                 → { setValue, setOptions, value }. Select
//                                   mode="multiple" with responsive tags;
//                                   options are { value, label, grouped } and
//                                   { group } headings
//   Ant.autocomplete(input, { source(text) → strings, max, onPick })
//   Ant.rangePicker(root, { value: [from, to], presets, format, placeholder,
//                   ariaLabel, weekStart, onChange([from, to]) }) → { setValue }
//   Ant.pagination(ul, { current, pageSize, total, pageSizeOptions, showTotal,
//                  onChange(current, pageSize) }) → { update(state) }
//   Ant.notification({ key, title, description, icon, iconClass, actions:
//                     [{ label, primary, onClick }], duration }) → { close }
//   Ant.steps(titles, current)    → small Steps markup
//   Ant.slider(rangeInput)        → sync(); the filled part follows the value
//   Ant.spin(tip)                 → Spin markup
//   Ant.dropdown(anchor, { items: [{ label, icon, danger, disabled }], onPick(item, i), align })
//                                 → { el, close }; Dropdown's menu
//   Ant.drawer({ title, body, width, className, onClose })
//                                 → { el, body, close, setAway(on) }; a Drawer
//                                   from the right edge over a mask
//   Ant.categoryHue(key)          → a category's colour (AntV's palette)
//   Tooltips: any element with data-tip="…" shows one on hover and on keyboard
//   focus (data-tip-placement="left" to put it beside rather than above).
//   Icons in static markup: <span class="anticon" data-ant-icon="name"> is
//   filled in at DOMContentLoaded.
//
// Globals used: UI (ui.js), escapeHtml (escape.js).
// ============================================================================

(function () {
    // ── Icons ────────────────────────────────────────────────────────────────
    // Paths from @ant-design/icons-svg 4.4.2 (MIT), the set Ant Design's own
    // icon components draw. Only the ones the Ant pages use.
    const ICON_PATHS = {
        left: 'M724 218.3V141c0-6.7-7.7-10.4-12.9-6.3L260.3 486.8a31.86 31.86 0 000 50.3l450.8 352.1c5.3 4.1 12.9.4 12.9-6.3v-77.3c0-4.9-2.3-9.6-6.1-12.6l-360-281 360-281.1c3.8-3 6.1-7.7 6.1-12.6z',
        right: 'M765.7 486.8L314.9 134.7A7.97 7.97 0 00302 141v77.3c0 4.9 2.3 9.6 6.1 12.6l360 281.1-360 281.1c-3.9 3-6.1 7.7-6.1 12.6V883c0 6.7 7.7 10.4 12.9 6.3l450.8-352.1a31.96 31.96 0 000-50.4z',
        'double-left': 'M272.9 512l265.4-339.1c4.1-5.2.4-12.9-6.3-12.9h-77.3c-4.9 0-9.6 2.3-12.6 6.1L186.8 492.3a31.99 31.99 0 000 39.5l255.3 326.1c3 3.9 7.7 6.1 12.6 6.1H532c6.7 0 10.4-7.7 6.3-12.9L272.9 512zm304 0l265.4-339.1c4.1-5.2.4-12.9-6.3-12.9h-77.3c-4.9 0-9.6 2.3-12.6 6.1L490.8 492.3a31.99 31.99 0 000 39.5l255.3 326.1c3 3.9 7.7 6.1 12.6 6.1H836c6.7 0 10.4-7.7 6.3-12.9L576.9 512z',
        'double-right': 'M533.2 492.3L277.9 166.1c-3-3.9-7.7-6.1-12.6-6.1H188c-6.7 0-10.4 7.7-6.3 12.9L447.1 512 181.7 851.1A7.98 7.98 0 00188 864h77.3c4.9 0 9.6-2.3 12.6-6.1l255.3-326.1c9.1-11.7 9.1-27.9 0-39.5zm304 0L581.9 166.1c-3-3.9-7.7-6.1-12.6-6.1H492c-6.7 0-10.4 7.7-6.3 12.9L751.1 512 485.7 851.1A7.98 7.98 0 00492 864h77.3c4.9 0 9.6-2.3 12.6-6.1l255.3-326.1c9.1-11.7 9.1-27.9 0-39.5z',
        down: 'M884 256h-75c-5.1 0-9.9 2.5-12.9 6.6L512 654.2 227.9 262.6c-3-4.1-7.8-6.6-12.9-6.6h-75c-6.5 0-10.3 7.4-6.5 12.7l352.6 486.1c12.8 17.6 39 17.6 51.7 0l352.6-486.1c3.9-5.3.1-12.7-6.4-12.7z',
        calendar: 'M880 184H712v-64c0-4.4-3.6-8-8-8h-56c-4.4 0-8 3.6-8 8v64H384v-64c0-4.4-3.6-8-8-8h-56c-4.4 0-8 3.6-8 8v64H144c-17.7 0-32 14.3-32 32v664c0 17.7 14.3 32 32 32h736c17.7 0 32-14.3 32-32V216c0-17.7-14.3-32-32-32zm-40 656H184V460h656v380zM184 392V256h128v48c0 4.4 3.6 8 8 8h56c4.4 0 8-3.6 8-8v-48h256v48c0 4.4 3.6 8 8 8h56c4.4 0 8-3.6 8-8v-48h128v136H184z',
        plus: 'M482 152h60q8 0 8 8v704q0 8-8 8h-60q-8 0-8-8V160q0-8 8-8zM192 474h672q8 0 8 8v60q0 8-8 8H160q-8 0-8-8v-60q0-8 8-8z',
        'radar-chart': 'M926.8 397.1l-396-288a31.81 31.81 0 00-37.6 0l-396 288a31.99 31.99 0 00-11.6 35.8l151.3 466a32 32 0 0030.4 22.1h489.5c13.9 0 26.1-8.9 30.4-22.1l151.3-466c4.2-13.2-.5-27.6-11.7-35.8zM838.6 417l-98.5 32-200-144.7V199.9L838.6 417zM466 567.2l-89.1 122.3-55.2-169.2L466 567.2zm-116.3-96.8L484 373.3v140.8l-134.3-43.7zM512 599.2l93.9 128.9H418.1L512 599.2zm28.1-225.9l134.2 97.1L540.1 514V373.3zM558 567.2l144.3-46.9-55.2 169.2L558 567.2zm-74-367.3v104.4L283.9 449l-98.5-32L484 199.9zM169.3 470.8l86.5 28.1 80.4 246.4-53.8 73.9-113.1-348.4zM327.1 853l50.3-69h269.3l50.3 69H327.1zm414.5-33.8l-53.8-73.9 80.4-246.4 86.5-28.1-113.1 348.4z',
        delete: 'M360 184h-8c4.4 0 8-3.6 8-8v8h304v-8c0 4.4 3.6 8 8 8h-8v72h72v-80c0-35.3-28.7-64-64-64H352c-35.3 0-64 28.7-64 64v80h72v-72zm504 72H160c-17.7 0-32 14.3-32 32v32c0 4.4 3.6 8 8 8h60.4l24.7 523c1.6 34.1 29.8 61 63.9 61h454c34.2 0 62.3-26.8 63.9-61l24.7-523H888c4.4 0 8-3.6 8-8v-32c0-17.7-14.3-32-32-32zM731.3 840H292.7l-24.2-512h487l-24.2 512z',
        close: 'M799.86 166.31c.02 0 .04.02.08.06l57.69 57.7c.04.03.05.05.06.08a.12.12 0 010 .06c0 .03-.02.05-.06.09L569.93 512l287.7 287.7c.04.04.05.06.06.09a.12.12 0 010 .07c0 .02-.02.04-.06.08l-57.7 57.69c-.03.04-.05.05-.07.06a.12.12 0 01-.07 0c-.03 0-.05-.02-.09-.06L512 569.93l-287.7 287.7c-.04.04-.06.05-.09.06a.12.12 0 01-.07 0c-.02 0-.04-.02-.08-.06l-57.69-57.7c-.04-.03-.05-.05-.06-.07a.12.12 0 010-.07c0-.03.02-.05.06-.09L454.07 512l-287.7-287.7c-.04-.04-.05-.06-.06-.09a.12.12 0 010-.07c0-.02.02-.04.06-.08l57.7-57.69c.03-.04.05-.05.07-.06a.12.12 0 01.07 0c.03 0 .05.02.09.06L512 454.07l287.7-287.7c.04-.04.06-.05.09-.06a.12.12 0 01.07 0z',
        'exclamation-circle': 'M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64zm-32 232c0-4.4 3.6-8 8-8h48c4.4 0 8 3.6 8 8v272c0 4.4-3.6 8-8 8h-48c-4.4 0-8-3.6-8-8V296zm32 440a48.01 48.01 0 010-96 48.01 48.01 0 010 96z',
        'check-circle': 'M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64zm193.5 301.7l-210.6 292a31.8 31.8 0 01-51.7 0L318.5 484.9c-3.8-5.3 0-12.7 6.5-12.7h46.9c10.2 0 19.9 4.9 25.9 13.3l71.2 98.8 157.2-218c6-8.3 15.6-13.3 25.9-13.3H699c6.5 0 10.3 7.4 6.5 12.7z',
        'close-circle': 'M512 64c247.4 0 448 200.6 448 448S759.4 960 512 960 64 759.4 64 512 264.6 64 512 64zm127.98 274.82h-.04l-.08.06L512 466.75 384.14 338.88c-.04-.05-.06-.06-.08-.06a.12.12 0 00-.07 0c-.03 0-.05.01-.09.05l-45.02 45.02a.2.2 0 00-.05.09.12.12 0 000 .07v.02a.27.27 0 00.06.06L466.75 512 338.88 639.86c-.05.04-.06.06-.06.08a.12.12 0 000 .07c0 .03.01.05.05.09l45.02 45.02a.2.2 0 00.09.05.12.12 0 00.07 0c.02 0 .04-.01.08-.05L512 557.25l127.86 127.87c.04.04.06.05.08.05a.12.12 0 00.07 0c.03 0 .05-.01.09-.05l45.02-45.02a.2.2 0 00.05-.09.12.12 0 000-.07v-.02a.27.27 0 00-.05-.06L557.25 512l127.87-127.86c.04-.04.05-.06.05-.08a.12.12 0 000-.07c0-.03-.01-.05-.05-.09l-45.02-45.02a.2.2 0 00-.09-.05.12.12 0 00-.07 0z',
        'info-circle': 'M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64zm32 664c0 4.4-3.6 8-8 8h-48c-4.4 0-8-3.6-8-8V456c0-4.4 3.6-8 8-8h48c4.4 0 8 3.6 8 8v272zm-32-344a48.01 48.01 0 010-96 48.01 48.01 0 010 96z',
        edit: 'M257.7 752c2 0 4-.2 6-.5L431.9 722c2-.4 3.9-1.3 5.3-2.8l423.9-423.9a9.96 9.96 0 000-14.1L694.9 114.9c-1.9-1.9-4.4-2.9-7.1-2.9s-5.2 1-7.1 2.9L256.8 538.8c-1.5 1.5-2.4 3.3-2.8 5.3l-29.5 168.2a33.5 33.5 0 009.4 29.8c6.6 6.4 14.9 9.9 23.8 9.9zm67.4-174.4L687.8 215l73.3 73.3-362.7 362.6-88.9 15.7 15.6-89zM880 836H144c-17.7 0-32 14.3-32 32v36c0 4.4 3.6 8 8 8h784c4.4 0 8-3.6 8-8v-36c0-17.7-14.3-32-32-32z',
        'caret-up': 'M858.9 689L530.5 308.2c-9.4-10.9-27.5-10.9-37 0L165.1 689c-12.2 14.2-1.2 35 18.5 35h656.8c19.7 0 30.7-20.8 18.5-35z',
        'caret-down': 'M840.4 300H183.6c-19.7 0-30.7 20.8-18.5 35l328.4 380.8c9.4 10.9 27.5 10.9 37 0L858.9 335c12.2-14.2 1.2-35-18.5-35z',
        // InfoCircleOutlined: the ring and the "i", two paths joined into one.
        'info-circle-outlined': 'M512 64C264.6 64 64 264.6 64 512s200.6 448 448 448 448-200.6 448-448S759.4 64 512 64zm0 820c-205.4 0-372-166.6-372-372s166.6-372 372-372 372 166.6 372 372-166.6 372-372 372zM464 336a48 48 0 1096 0 48 48 0 10-96 0zm72 112h-48c-4.4 0-8 3.6-8 8v272c0 4.4 3.6 8 8 8h48c4.4 0 8-3.6 8-8V456c0-4.4-3.6-8-8-8z',
        more: 'M456 231a56 56 0 10112 0 56 56 0 10-112 0zm0 280a56 56 0 10112 0 56 56 0 10-112 0zm0 280a56 56 0 10112 0 56 56 0 10-112 0z',
        check: 'M912 190h-69.9c-9.8 0-19.1 4.5-25.1 12.2L404.7 724.5 207 474a32 32 0 00-25.1-12.2H112c-6.7 0-10.4 7.7-6.3 12.9l273.9 347c12.8 16.2 37.4 16.2 50.3 0l488.4-618.9c4.1-5.1.4-12.8-6.3-12.8z',
        appstore: 'M464 144H160c-8.8 0-16 7.2-16 16v304c0 8.8 7.2 16 16 16h304c8.8 0 16-7.2 16-16V160c0-8.8-7.2-16-16-16zm-52 268H212V212h200v200zm452-268H560c-8.8 0-16 7.2-16 16v304c0 8.8 7.2 16 16 16h304c8.8 0 16-7.2 16-16V160c0-8.8-7.2-16-16-16zm-52 268H612V212h200v200zM464 544H160c-8.8 0-16 7.2-16 16v304c0 8.8 7.2 16 16 16h304c8.8 0 16-7.2 16-16V560c0-8.8-7.2-16-16-16zm-52 268H212V612h200v200zm452-268H560c-8.8 0-16 7.2-16 16v304c0 8.8 7.2 16 16 16h304c8.8 0 16-7.2 16-16V560c0-8.8-7.2-16-16-16zm-52 268H612V612h200v200z',
        'unordered-list': 'M912 192H328c-4.4 0-8 3.6-8 8v56c0 4.4 3.6 8 8 8h584c4.4 0 8-3.6 8-8v-56c0-4.4-3.6-8-8-8zm0 284H328c-4.4 0-8 3.6-8 8v56c0 4.4 3.6 8 8 8h584c4.4 0 8-3.6 8-8v-56c0-4.4-3.6-8-8-8zm0 284H328c-4.4 0-8 3.6-8 8v56c0 4.4 3.6 8 8 8h584c4.4 0 8-3.6 8-8v-56c0-4.4-3.6-8-8-8zM104 228a56 56 0 10112 0 56 56 0 10-112 0zm0 284a56 56 0 10112 0 56 56 0 10-112 0zm0 284a56 56 0 10112 0 56 56 0 10-112 0z',
        undo: 'M511.4 124C290.5 124.3 112 303 112 523.9c0 128 60.2 242 153.8 315.2l-37.5 48c-4.1 5.3-.3 13 6.3 12.9l167-.8c5.2 0 9-4.9 7.7-9.9L369.8 727a8 8 0 00-14.1-3L315 776.1c-10.2-8-20-16.7-29.3-26a318.64 318.64 0 01-68.6-101.7C200.4 609 192 567.1 192 523.9s8.4-85.1 25.1-124.5c16.1-38.1 39.2-72.3 68.6-101.7 29.4-29.4 63.6-52.5 101.7-68.6C426.9 212.4 468.8 204 512 204s85.1 8.4 124.5 25.1c38.1 16.1 72.3 39.2 101.7 68.6 29.4 29.4 52.5 63.6 68.6 101.7 16.7 39.4 25.1 81.3 25.1 124.5s-8.4 85.1-25.1 124.5a318.64 318.64 0 01-68.6 101.7c-7.5 7.5-15.3 14.5-23.4 21.2a7.93 7.93 0 00-1.2 11.1l39.4 50.5c2.8 3.5 7.9 4.1 11.4 1.3C854.5 760.8 912 649.1 912 523.9c0-221.1-179.4-400.2-400.6-399.9z',
        'arrow-up': 'M868 545.5L536.1 163a31.96 31.96 0 00-48.3 0L156 545.5a7.97 7.97 0 006 13.2h81c4.6 0 9-2 12.1-5.5L474 300.9V864c0 4.4 3.6 8 8 8h60c4.4 0 8-3.6 8-8V300.9l218.9 252.3c3 3.5 7.4 5.5 12.1 5.5h81c6.8 0 10.5-8 6-13.2z',
        'arrow-down': 'M862 465.3h-81c-4.6 0-9 2-12.1 5.5L550 723.1V160c0-4.4-3.6-8-8-8h-60c-4.4 0-8 3.6-8 8v563.1L255.1 470.8c-3-3.5-7.4-5.5-12.1-5.5h-81c-6.8 0-10.5 8.1-6 13.2L487.9 861a31.96 31.96 0 0048.3 0L868 478.5c4.5-5.2.8-13.2-6-13.2z',
        lock: 'M832 464h-68V240c0-70.7-57.3-128-128-128H388c-70.7 0-128 57.3-128 128v224h-68c-17.7 0-32 14.3-32 32v384c0 17.7 14.3 32 32 32h640c17.7 0 32-14.3 32-32V496c0-17.7-14.3-32-32-32zM332 240c0-30.9 25.1-56 56-56h248c30.9 0 56 25.1 56 56v224H332V240zm460 600H232V536h560v304zM484 701v53c0 4.4 3.6 8 8 8h40c4.4 0 8-3.6 8-8v-53a48.01 48.01 0 10-56 0z',
        'search': 'M909.6 854.5L649.9 594.8C690.2 542.7 712 479 712 412c0-80.2-31.3-155.4-87.9-212.1-56.6-56.7-132-87.9-212.1-87.9s-155.5 31.3-212.1 87.9C143.2 256.5 112 331.8 112 412c0 80.1 31.3 155.5 87.9 212.1C256.5 680.8 331.8 712 412 712c67 0 130.6-21.8 182.7-62l259.7 259.6a8.2 8.2 0 0011.6 0l43.6-43.5a8.2 8.2 0 000-11.6zM570.4 570.4C528 612.7 471.8 636 412 636s-116-23.3-158.4-65.6C211.3 528 188 471.8 188 412s23.3-116.1 65.6-158.4C296 211.3 352.2 188 412 188s116.1 23.2 158.4 65.6S636 352.2 636 412s-23.3 116.1-65.6 158.4z',
        'filter': 'M880.1 154H143.9c-24.5 0-39.8 26.7-27.5 48L349 597.4V838c0 17.7 14.2 32 31.8 32h262.4c17.6 0 31.8-14.3 31.8-32V597.4L907.7 202c12.2-21.3-3.1-48-27.6-48zM603.4 798H420.6V642h182.9v156zm9.6-236.6l-9.5 16.6h-183l-9.5-16.6L212.7 226h598.6L613 561.4z',
        'upload': 'M400 317.7h73.9V656c0 4.4 3.6 8 8 8h60c4.4 0 8-3.6 8-8V317.7H624c6.7 0 10.4-7.7 6.3-12.9L518.3 163a8 8 0 00-12.6 0l-112 141.7c-4.1 5.3-.4 13 6.3 13zM878 626h-60c-4.4 0-8 3.6-8 8v154H214V634c0-4.4-3.6-8-8-8h-60c-4.4 0-8 3.6-8 8v198c0 17.7 14.3 32 32 32h684c17.7 0 32-14.3 32-32V634c0-4.4-3.6-8-8-8z',
        'download': 'M505.7 661a8 8 0 0012.6 0l112-141.7c4.1-5.2.4-12.9-6.3-12.9h-74.1V168c0-4.4-3.6-8-8-8h-60c-4.4 0-8 3.6-8 8v338.3H400c-6.7 0-10.4 7.7-6.3 12.9l112 141.8zM878 626h-60c-4.4 0-8 3.6-8 8v154H214V634c0-4.4-3.6-8-8-8h-60c-4.4 0-8 3.6-8 8v198c0 17.7 14.3 32 32 32h684c17.7 0 32-14.3 32-32V634c0-4.4-3.6-8-8-8z',
        'inbox': 'M885.2 446.3l-.2-.8-112.2-285.1c-5-16.1-19.9-27.2-36.8-27.2H281.2c-17 0-32.1 11.3-36.9 27.6L139.4 443l-.3.7-.2.8c-1.3 4.9-1.7 9.9-1 14.8-.1 1.6-.2 3.2-.2 4.8V830a60.9 60.9 0 0060.8 60.8h627.2c33.5 0 60.8-27.3 60.9-60.8V464.1c0-1.3 0-2.6-.1-3.7.4-4.9 0-9.6-1.3-14.1zm-295.8-43l-.3 15.7c-.8 44.9-31.8 75.1-77.1 75.1-22.1 0-41.1-7.1-54.8-20.6S436 441.2 435.6 419l-.3-15.7H229.5L309 210h399.2l81.7 193.3H589.4zm-375 76.8h157.3c24.3 57.1 76 90.8 140.4 90.8 33.7 0 65-9.4 90.3-27.2 22.2-15.6 39.5-37.4 50.7-63.6h156.5V814H214.4V480.1z',
        'thunderbolt': 'M848 359.3H627.7L825.8 109c4.1-5.3.4-13-6.3-13H436c-2.8 0-5.5 1.5-6.9 4L170 547.5c-3.1 5.3.7 12 6.9 12h174.4l-89.4 357.6c-1.9 7.8 7.5 13.3 13.3 7.7L853.5 373c5.2-4.9 1.7-13.7-5.5-13.7zM378.2 732.5l60.3-241H281.1l189.6-327.4h224.6L487 427.4h211L378.2 732.5z',
        'file-text': 'M854.6 288.6L639.4 73.4c-6-6-14.1-9.4-22.6-9.4H192c-17.7 0-32 14.3-32 32v832c0 17.7 14.3 32 32 32h640c17.7 0 32-14.3 32-32V311.3c0-8.5-3.4-16.7-9.4-22.7zM790.2 326H602V137.8L790.2 326zm1.8 562H232V136h302v216a42 42 0 0042 42h216v494zM504 618H320c-4.4 0-8 3.6-8 8v48c0 4.4 3.6 8 8 8h184c4.4 0 8-3.6 8-8v-48c0-4.4-3.6-8-8-8zM312 490v48c0 4.4 3.6 8 8 8h384c4.4 0 8-3.6 8-8v-48c0-4.4-3.6-8-8-8H320c-4.4 0-8 3.6-8 8z',
        'swap-right': 'M873.1 596.2l-164-208A32 32 0 00684 376h-64.8c-6.7 0-10.4 7.7-6.3 13l144.3 183H152c-4.4 0-8 3.6-8 8v60c0 4.4 3.6 8 8 8h695.9c26.8 0 41.7-30.8 25.2-51.8z',
        'enter': 'M864 170h-60c-4.4 0-8 3.6-8 8v518H310v-73c0-6.7-7.8-10.5-13-6.3l-141.9 112a8 8 0 000 12.6l141.9 112c5.3 4.2 13 .4 13-6.3v-75h498c35.3 0 64-28.7 64-64V178c0-4.4-3.6-8-8-8z',
        'insert-row-right': 'M856 112h-80c-4.4 0-8 3.6-8 8v784c0 4.4 3.6 8 8 8h80c4.4 0 8-3.6 8-8V120c0-4.4-3.6-8-8-8zm-200 0H192c-17.7 0-32 14.9-32 33.3v733.3c0 18.4 14.3 33.3 32 33.3h464c17.7 0 32-14.9 32-33.3V145.3c0-18.4-14.3-33.3-32-33.3zM392 840H232V664h160v176zm0-240H232V424h160v176zm0-240H232V184h160v176zm224 480H456V664h160v176zm0-240H456V424h160v176zm0-240H456V184h160v176z',
        holder: 'M300 276.5a56 56 0 1056-97 56 56 0 00-56 97zm0 284a56 56 0 1056-97 56 56 0 00-56 97zM640 228a56 56 0 10112 0 56 56 0 00-112 0zm0 284a56 56 0 10112 0 56 56 0 00-112 0zM300 844.5a56 56 0 1056-97 56 56 0 00-56 97zM640 796a56 56 0 10112 0 56 56 0 00-112 0z',
        setting: 'M924.8 625.7l-65.5-56c3.1-19 4.7-38.4 4.7-57.8s-1.6-38.8-4.7-57.8l65.5-56a32.03 32.03 0 009.3-35.2l-.9-2.6a443.74 443.74 0 00-79.7-137.9l-1.8-2.1a32.12 32.12 0 00-35.1-9.5l-81.3 28.9c-30-24.6-63.5-44-99.7-57.6l-15.7-85a32.05 32.05 0 00-25.8-25.7l-2.7-.5c-52.1-9.4-106.9-9.4-159 0l-2.7.5a32.05 32.05 0 00-25.8 25.7l-15.8 85.4a351.86 351.86 0 00-99 57.4l-81.9-29.1a32 32 0 00-35.1 9.5l-1.8 2.1a446.02 446.02 0 00-79.7 137.9l-.9 2.6c-4.5 12.5-.8 26.5 9.3 35.2l66.3 56.6c-3.1 18.8-4.6 38-4.6 57.1 0 19.2 1.5 38.4 4.6 57.1L99 625.5a32.03 32.03 0 00-9.3 35.2l.9 2.6c18.1 50.4 44.9 96.9 79.7 137.9l1.8 2.1a32.12 32.12 0 0035.1 9.5l81.9-29.1c29.8 24.5 63.1 43.9 99 57.4l15.8 85.4a32.05 32.05 0 0025.8 25.7l2.7.5a449.4 449.4 0 00159 0l2.7-.5a32.05 32.05 0 0025.8-25.7l15.7-85a350 350 0 0099.7-57.6l81.3 28.9a32 32 0 0035.1-9.5l1.8-2.1c34.8-41.1 61.6-87.5 79.7-137.9l.9-2.6c4.5-12.3.8-26.3-9.3-35zM788.3 465.9c2.5 15.1 3.8 30.6 3.8 46.1s-1.3 31-3.8 46.1l-6.6 40.1 74.7 63.9a370.03 370.03 0 01-42.6 73.6L721 702.8l-31.4 25.8c-23.9 19.6-50.5 35-79.3 45.8l-38.1 14.3-17.9 97a377.5 377.5 0 01-85 0l-17.9-97.2-37.8-14.5c-28.5-10.8-55-26.2-78.7-45.7l-31.4-25.9-93.4 33.2c-17-22.9-31.2-47.6-42.6-73.6l75.5-64.5-6.5-40c-2.4-14.9-3.7-30.3-3.7-45.5 0-15.3 1.2-30.6 3.7-45.5l6.5-40-75.5-64.5c11.3-26.1 25.6-50.7 42.6-73.6l93.4 33.2 31.4-25.9c23.7-19.5 50.2-34.9 78.7-45.7l37.9-14.3 17.9-97.2c28.1-3.2 56.8-3.2 85 0l17.9 97 38.1 14.3c28.7 10.8 55.4 26.2 79.3 45.8l31.4 25.8 92.8-32.9c17 22.9 31.2 47.6 42.6 73.6L781.8 426l6.5 39.9zM512 326c-97.2 0-176 78.8-176 176s78.8 176 176 176 176-78.8 176-176-78.8-176-176-176zm79.2 255.2A111.6 111.6 0 01512 614c-29.9 0-58-11.7-79.2-32.8A111.6 111.6 0 01400 502c0-29.9 11.7-58 32.8-79.2C454 401.6 482.1 390 512 390c29.9 0 58 11.6 79.2 32.8A111.6 111.6 0 01624 502c0 29.9-11.7 58-32.8 79.2z',
        'appstore-add': 'M464 144H160c-8.8 0-16 7.2-16 16v304c0 8.8 7.2 16 16 16h304c8.8 0 16-7.2 16-16V160c0-8.8-7.2-16-16-16zm-52 268H212V212h200v200zm452-268H560c-8.8 0-16 7.2-16 16v304c0 8.8 7.2 16 16 16h304c8.8 0 16-7.2 16-16V160c0-8.8-7.2-16-16-16zm-52 268H612V212h200v200zm52 132H560c-8.8 0-16 7.2-16 16v304c0 8.8 7.2 16 16 16h304c8.8 0 16-7.2 16-16V560c0-8.8-7.2-16-16-16zm-52 268H612V612h200v200zM424 712H296V584c0-4.4-3.6-8-8-8h-48c-4.4 0-8 3.6-8 8v128H104c-4.4 0-8 3.6-8 8v48c0 4.4 3.6 8 8 8h128v128c0 4.4 3.6 8 8 8h48c4.4 0 8-3.6 8-8V776h128c4.4 0 8-3.6 8-8v-48c0-4.4-3.6-8-8-8z',
        link: 'M574 665.4a8.03 8.03 0 00-11.3 0L446.5 781.6c-53.8 53.8-144.6 59.5-204 0-59.5-59.5-53.8-150.2 0-204l116.2-116.2c3.1-3.1 3.1-8.2 0-11.3l-39.8-39.8a8.03 8.03 0 00-11.3 0L191.4 526.5c-84.6 84.6-84.6 221.5 0 306s221.5 84.6 306 0l116.2-116.2c3.1-3.1 3.1-8.2 0-11.3L574 665.4zm258.6-474c-84.6-84.6-221.5-84.6-306 0L410.3 307.6a8.03 8.03 0 000 11.3l39.7 39.7c3.1 3.1 8.2 3.1 11.3 0l116.2-116.2c53.8-53.8 144.6-59.5 204 0 59.5 59.5 53.8 150.2 0 204L665.3 562.6a8.03 8.03 0 000 11.3l39.8 39.8c3.1 3.1 8.2 3.1 11.3 0l116.2-116.2c84.5-84.6 84.5-221.5 0-306.1zM610.1 372.3a8.03 8.03 0 00-11.3 0L372.3 598.7a8.03 8.03 0 000 11.3l39.6 39.6c3.1 3.1 8.2 3.1 11.3 0l226.4-226.4c3.1-3.1 3.1-8.2 0-11.3l-39.5-39.6z',
    };
    // Drawn with even-odd fill: the cut-outs are holes in a single outline.
    const EVEN_ODD = new Set(['close', 'close-circle']);
    // Most icons are drawn in the 64–960 box; the carets, the inbox and the
    // range arrow fill the whole 1024.
    const FULL_BOX = new Set(['caret-up', 'caret-down', 'inbox', 'swap-right']);

    function iconSvg(name) {
        const d = ICON_PATHS[name];
        if (!d) throw new Error(`Ant.icon: no icon named "${name}"`);
        const rule = EVEN_ODD.has(name) ? ' fill-rule="evenodd"' : '';
        const box = FULL_BOX.has(name) ? '0 0 1024 1024' : '64 64 896 896';
        return `<svg viewBox="${box}" focusable="false" aria-hidden="true"${rule}><path d="${d}"/></svg>`;
    }

    function icon(name) {
        return `<span class="anticon anticon-${name}" aria-hidden="true">${iconSvg(name)}</span>`;
    }

    // ── Empty ────────────────────────────────────────────────────────────────
    // Ant's PRESENTED_IMAGE_SIMPLE, its tones set by ant.css so it follows the
    // theme the way Ant's follows its algorithm.
    const EMPTY_IMAGE = '<svg width="64" height="41" viewBox="0 0 64 41" focusable="false" aria-hidden="true">'
        + '<g transform="translate(0 1)" fill="none" fill-rule="evenodd">'
        + '<ellipse class="ant-empty-img-shadow" cx="32" cy="33" rx="32" ry="7"/>'
        + '<g class="ant-empty-img-stroke" fill-rule="nonzero">'
        + '<path d="M55 12.76L44.854 1.258C44.367.474 43.656 0 42.907 0H21.093c-.749 0-1.46.474-1.947 1.257L9 12.761V22h46v-9.24z"/>'
        + '<path class="ant-empty-img-content" d="M41.613 15.931c0-1.605.994-2.93 2.227-2.931H55v18.137C55 33.26 53.68 35 52.05 35h-40.1C10.32 35 9 33.259 9 31.137V13h11.16c1.233 0 2.227 1.323 2.227 2.928v.022c0 1.605 1.005 2.901 2.237 2.901h14.752c1.232 0 2.237-1.308 2.237-2.913v-.007z"/>'
        + '</g></g></svg>';

    /** `action` adds Empty's footer: one primary button. `{ label, href }` is a
     *  link to the page where the missing data is added; `{ label, name }` is a
     *  button carrying data-empty-action="name" for the page to handle. */
    function emptyAction({ label, href, name }) {
        return href
            ? `<a class="ant-btn ant-btn-primary" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`
            : `<button type="button" class="ant-btn ant-btn-primary" data-empty-action="${escapeHtml(name)}">${escapeHtml(label)}</button>`;
    }

    function empty({ title, desc = '', compact = false, action = null }) {
        const footer = action ? `<div class="ant-empty-footer">${emptyAction(action)}</div>` : '';
        return `<div class="ant-empty${compact ? ' ant-empty-compact' : ''}">
            <div class="ant-empty-image">${EMPTY_IMAGE}</div>
            <div class="ant-empty-title">${escapeHtml(title)}</div>
            ${desc ? `<div class="ant-empty-desc">${escapeHtml(desc)}</div>` : ''}
            ${footer}
        </div>`;
    }

    // ── Button loading ───────────────────────────────────────────────────────
    // Button's loading state: dimmed, spinning and deaf to the pointer, so a
    // slow request cannot be sent twice. Keyboard activation still fires a
    // click, which is why handlers check isLoading() too.
    function setLoading(btn, on) {
        btn.classList.toggle('ant-btn-loading', on);
        if (on) btn.setAttribute('aria-busy', 'true');
        else btn.removeAttribute('aria-busy');
    }

    const isLoading = (btn) => btn.classList.contains('ant-btn-loading');

    /** Run `task` with `btn` loading. Resolves to what the task returns, or to
     *  null when it threw (logged), so the caller has one failure path to
     *  report and the button is never left spinning. */
    async function whileLoading(btn, task) {
        setLoading(btn, true);
        try {
            return await task();
        } catch (err) {
            console.error('[ant] action failed:', err);
            return null;
        } finally {
            setLoading(btn, false);
        }
    }

    // ── Placement ────────────────────────────────────────────────────────────
    // Shared by Tooltip, Popconfirm and the month picker. Every pop-up is fixed
    // to the viewport at 0,0 and moved by transform, so no scroll container can
    // clip it and moving it never reflows the page.
    const EDGE = 8;   // nearest a pop-up comes to the window edge

    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

    /**
     * Put `pop` beside `anchor`: centred above it ('top'), below it ('bottom')
     * or to its left ('left'), flipping to the other side when the first
     * choice would leave the window, then pushed back inside it. `align:
     * 'start'` lines its left edge up with the anchor's instead of centring it.
     * Writes --ant-arrow-x/-y so the arrow still points at the anchor's centre.
     * `pop` must already be visible: its size is measured, not assumed.
     */
    function place(pop, anchor, { placement = 'top', align = 'center', gap = 10 } = {}) {
        const a = anchor.getBoundingClientRect();
        const p = pop.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        let side = placement;
        if (side === 'left' && a.left - p.width - gap < EDGE) side = 'top';
        const fitsAbove = a.top - p.height - gap >= EDGE;
        const fitsBelow = a.bottom + p.height + gap <= vh - EDGE;
        if (side === 'top' && !fitsAbove && fitsBelow) side = 'bottom';
        if (side === 'bottom' && !fitsBelow && fitsAbove) side = 'top';

        let left;
        let top;
        if (side === 'left') {
            left = a.left - p.width - gap;
            top = clamp(a.top + a.height / 2 - p.height / 2, EDGE, vh - p.height - EDGE);
            pop.style.setProperty('--ant-arrow-y', `${Math.round(a.top + a.height / 2 - top)}px`);
        } else {
            top = side === 'top' ? a.top - p.height - gap : a.bottom + gap;
            left = clamp(align === 'start' ? a.left : a.left + a.width / 2 - p.width / 2,
                EDGE, vw - p.width - EDGE);
            pop.style.setProperty('--ant-arrow-x',
                `${Math.round(clamp(a.left + a.width / 2 - left, 12, p.width - 12))}px`);
        }
        pop.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
        pop.classList.remove('ant-placement-top', 'ant-placement-bottom', 'ant-placement-left');
        pop.classList.add(`ant-placement-${side}`);
    }

    // ── Modal ────────────────────────────────────────────────────────────────
    // Ant's Modal on the app's dialog shell. What it adds: the header and footer
    // markup, the dialog role and its label, Ant's close icon, Tab kept inside
    // the dialog, and focus handed back to whatever opened it.
    const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled):not([type="hidden"]), '
        + 'select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
    let modalSeq = 0;

    /** Tab and Shift+Tab wrap at the dialog's ends instead of leaving it.
     *  Only tab stops count: a roving tabindex="-1" member is not an end. */
    function keepTabInside(e, root) {
        if (e.key !== 'Tab') return;
        const items = [...root.querySelectorAll(FOCUSABLE)]
            .filter((n) => n.tabIndex >= 0 && n.getClientRects().length);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    }

    function modal({ title, body, footer = '', width = 520, className = '', onClose = null, canClose = null }) {
        const titleId = `ant-modal-title-${++modalSeq}`;
        const opener = document.activeElement;
        const { overlay, close } = UI.dialog(`
            <div class="ant-modal-header"><div class="ant-modal-title" id="${titleId}">${escapeHtml(title)}</div></div>
            <div class="ant-modal-body">${body}</div>
            ${footer ? `<div class="ant-modal-footer">${footer}</div>` : ''}`, {
            className: `ant-modal ant-scope ${className}`.trim(),
            canClose,
            onClose: () => {
                if (onClose) onClose();
                if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
            },
        });
        overlay.classList.add('ant-modal-wrap');

        const dialog = overlay.querySelector('.confirm-dialog');
        dialog.style.width = `${width}px`;
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        dialog.setAttribute('aria-labelledby', titleId);

        const closeBtn = dialog.querySelector('.dialog-close-btn');
        closeBtn.type = 'button';
        closeBtn.classList.add('ant-modal-close');
        closeBtn.innerHTML = icon('close');

        overlay.addEventListener('keydown', (e) => keepTabInside(e, dialog));
        const setTitle = (text) => { dialog.querySelector('.ant-modal-title').textContent = text; };
        return { overlay, dialog, close, setTitle };
    }

    // ── Confirm ──────────────────────────────────────────────────────────────
    // Modal.confirm: the warning icon beside the question, what it does under
    // it, then Cancel and the action. For a choice that is not tied to one
    // button on screen, where a Popconfirm would have nothing to point at.
    // Cancel takes focus, as in Popconfirm.

    /** → Promise<boolean>, true when confirmed. `content` is trusted markup. */
    function confirm({ title, content = '', okText = 'OK', cancelText = 'Cancel', danger = false }) {
        return new Promise((resolve) => {
            let confirmed = false;
            const { dialog, close } = modal({
                title,
                body: content,
                width: 416,
                className: 'ant-modal-confirm',
                footer: `<button type="button" class="ant-btn ant-btn-default" data-choice="cancel">${escapeHtml(cancelText)}</button>
                    <button type="button" class="ant-btn ant-btn-primary${danger ? ' ant-btn-dangerous' : ''}" data-choice="ok">${escapeHtml(okText)}</button>`,
                onClose: () => resolve(confirmed),
            });
            dialog.querySelector('.ant-modal-header').insertAdjacentHTML('afterbegin', icon('exclamation-circle'));
            dialog.addEventListener('click', (e) => {
                const choice = e.target.closest('[data-choice]');
                if (!choice) return;
                confirmed = choice.dataset.choice === 'ok';
                close();
            });
            dialog.querySelector('[data-choice="cancel"]').focus();
        });
    }

    // ── Tooltip ──────────────────────────────────────────────────────────────
    // One tooltip element for the whole page, driven by delegation from
    // data-tip, so markup that is re-rendered needs no wiring of its own. It
    // opens after Ant's 100ms hover delay or at once on keyboard focus, and any
    // press, scroll or Escape closes it. While open it describes its anchor
    // (aria-describedby), the ARIA tooltip pattern.
    const TIP_DELAY_MS = 100;
    let tip = null;
    let tipAnchor = null;
    let tipTimer = 0;

    function tipElement() {
        if (!tip) {
            tip = document.createElement('div');
            tip.id = 'ant-tooltip';
            tip.className = 'ant-tooltip ant-scope';
            tip.setAttribute('role', 'tooltip');
            tip.hidden = true;
            tip.innerHTML = '<div class="ant-tooltip-arrow"></div><div class="ant-tooltip-inner"></div>';
            document.body.appendChild(tip);
        }
        return tip;
    }

    function showTip(anchor) {
        const text = anchor.dataset.tip;
        if (!text || !anchor.isConnected) return;
        const el = tipElement();
        el.querySelector('.ant-tooltip-inner').textContent = text;
        el.hidden = false;
        place(el, anchor, { placement: anchor.dataset.tipPlacement || 'top' });
        tipAnchor = anchor;
        if (!anchor.hasAttribute('aria-describedby')) anchor.setAttribute('aria-describedby', el.id);
    }

    function hideTip() {
        clearTimeout(tipTimer);
        if (tipAnchor && tipAnchor.getAttribute('aria-describedby') === 'ant-tooltip') {
            tipAnchor.removeAttribute('aria-describedby');
        }
        tipAnchor = null;
        if (tip) tip.hidden = true;
    }

    /** Swap to `anchor` (or to nothing) after the hover delay. */
    function queueTip(anchor) {
        clearTimeout(tipTimer);
        if (anchor === tipAnchor) return;
        tipTimer = setTimeout(() => {
            hideTip();
            if (anchor) showTip(anchor);
        }, TIP_DELAY_MS);
    }

    document.addEventListener('pointerover', (e) => {
        queueTip(e.target.closest('[data-tip]'));
    });
    document.addEventListener('pointerout', (e) => {
        if (!e.relatedTarget) queueTip(null);   // left the window
    });
    document.addEventListener('focusin', (e) => {
        const anchor = e.target.closest('[data-tip]');
        if (!anchor || !e.target.matches(':focus-visible')) return;
        hideTip();
        showTip(anchor);
    });
    document.addEventListener('focusout', (e) => {
        if (tipAnchor && tipAnchor.contains(e.target)) hideTip();
    });
    document.addEventListener('pointerdown', hideTip, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTip(); }, true);
    window.addEventListener('scroll', hideTip, true);
    window.addEventListener('blur', hideTip);

    // ── Pop-up dismissal ─────────────────────────────────────────────────────
    // Popconfirm and the month picker both close on Escape and on a press
    // outside them, and both claim Escape first: their listener is a capture
    // on the document, so a dialog underneath (whose Escape listener bubbles on
    // the document) is not closed along with them.

    /** Wire Escape, an outside press and Tab-wrapping for one open pop-up.
     *  Returns the function that unwires them. */
    function dismissible(pop, anchor, onDismiss) {
        function onKey(e) {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopImmediatePropagation();
                onDismiss();
            } else if (pop.contains(document.activeElement)) {
                keepTabInside(e, pop);
            }
        }
        function onPress(e) {
            if (!pop.contains(e.target) && !anchor.contains(e.target)) onDismiss();
        }
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('pointerdown', onPress, true);
        return () => {
            document.removeEventListener('keydown', onKey, true);
            document.removeEventListener('pointerdown', onPress, true);
        };
    }

    // ── Popconfirm ───────────────────────────────────────────────────────────
    // A small confirm above the button that asked, rather than a second
    // dialog stacked on the first. Cancel takes focus: the safe choice is the
    // one a stray Enter lands on. Pressing the button again closes it.
    let openPop = null;
    let popSeq = 0;

    function popconfirm(anchor, { title, desc = '', okText = 'OK', cancelText = 'Cancel', danger = false }) {
        if (openPop) {
            const again = openPop.anchor === anchor;
            openPop.finish(false);
            if (again) return Promise.resolve(false);
        }
        return new Promise((resolve) => {
            const id = `ant-popconfirm-${++popSeq}`;
            const pop = document.createElement('div');
            pop.className = 'ant-popover ant-popconfirm ant-scope';
            pop.setAttribute('role', 'alertdialog');
            pop.setAttribute('aria-labelledby', `${id}-title`);
            if (desc) pop.setAttribute('aria-describedby', `${id}-desc`);
            pop.innerHTML = `<div class="ant-popover-arrow"></div>
                <div class="ant-popover-inner">
                    <div class="ant-popconfirm-message">${icon('exclamation-circle')}
                        <div>
                            <div class="ant-popconfirm-title" id="${id}-title">${escapeHtml(title)}</div>
                            ${desc ? `<div class="ant-popconfirm-description" id="${id}-desc">${escapeHtml(desc)}</div>` : ''}
                        </div>
                    </div>
                    <div class="ant-popconfirm-buttons">
                        <button type="button" class="ant-btn ant-btn-default ant-btn-sm" data-choice="cancel">${escapeHtml(cancelText)}</button>
                        <button type="button" class="ant-btn ant-btn-primary ant-btn-sm${danger ? ' ant-btn-dangerous' : ''}" data-choice="ok">${escapeHtml(okText)}</button>
                    </div>
                </div>`;
            document.body.appendChild(pop);
            place(pop, anchor, { placement: 'top' });
            anchor.setAttribute('aria-expanded', 'true');

            const unwire = dismissible(pop, anchor, () => finish(false));
            function finish(ok) {
                if (!openPop || openPop.pop !== pop) return;
                openPop = null;
                unwire();
                pop.remove();
                anchor.setAttribute('aria-expanded', 'false');
                if (!ok && anchor.isConnected) anchor.focus();
                resolve(ok);
            }
            pop.addEventListener('click', (e) => {
                const choice = e.target.closest('[data-choice]');
                if (choice) finish(choice.dataset.choice === 'ok');
            });
            openPop = { anchor, pop, finish };
            pop.querySelector('[data-choice="cancel"]').focus();
        });
    }

    // ── Month picker ─────────────────────────────────────────────────────────
    // DatePicker's month panel, dropped under its trigger: the year between
    // « and », the twelve months three to a row. This month wears the primary
    // hairline, the chosen one is filled. The arrows move through the months
    // and across the year's ends, PageUp/PageDown move a year, Enter picks.
    // `max` ('YYYY-MM') is DatePicker's disabledDate for everything after it:
    // later months are drawn disabled and the keys and » stop short of them.
    const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
        'September', 'October', 'November', 'December'];
    const ARROW_STEPS = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3, PageUp: -12, PageDown: 12 };
    let openPicker = null;

    const ymOf = (year, month) => `${year}-${String(month).padStart(2, '0')}`;

    /** The month `steps` away from `ym`, across year ends. */
    function stepYm(ym, steps) {
        const [y, m] = ym.split('-').map(Number);
        const total = y * 12 + (m - 1) + steps;
        return ymOf(Math.floor(total / 12), (total % 12) + 1);
    }

    /**
     * The month panel itself, drawn into `host`: the picker below drops it
     * under a trigger, and a page may set it inside a pop-up of its own (the
     * Dashboard's period picker). `value` ('YYYY-MM') is the chosen month, or
     * null for none. → { focus() }, which puts the focus on its month.
     */
    function monthPanel(host, { value = null, onPick, max = null }) {
        const now = new Date();
        const today = ymOf(now.getFullYear(), now.getMonth() + 1);
        let year = Number((value || today).slice(0, 4));
        // 'YYYY-MM' strings order the same as the months they name.
        const isAfterMax = (ym) => max !== null && ym > max;

        /** Draw `year`, with the month `focusYm` as the grid's one tab stop. */
        function render(focusYm) {
            const cells = MONTH_SHORT.map((short, i) => {
                const ym = ymOf(year, i + 1);
                return `<button type="button" class="ant-picker-cell-inner" data-ym="${ym}"
                    aria-label="${MONTH_LONG[i]} ${year}" aria-pressed="${ym === value}"
                    ${ym === today ? 'aria-current="date"' : ''} tabindex="${ym === focusYm ? 0 : -1}"
                    ${isAfterMax(ym) ? 'disabled' : ''}>${short}</button>`;
            }).join('');
            host.innerHTML = `<div class="ant-picker-panel">
                <div class="ant-picker-header">
                    <button type="button" class="ant-picker-header-btn" data-year-step="-1" aria-label="Previous year">${icon('double-left')}</button>
                    <div class="ant-picker-header-view" aria-live="polite">${year}</div>
                    <button type="button" class="ant-picker-header-btn" data-year-step="1" aria-label="Next year"
                        ${isAfterMax(ymOf(year + 1, 1)) ? 'disabled' : ''}>${icon('double-right')}</button>
                </div>
                <div class="ant-picker-body"><div class="ant-picker-months">${cells}</div></div>
            </div>`;
        }

        /** The month a year view opens on: the chosen one, else this one, else January. */
        const landingYm = () => [value, today].find((ym) => ym && ym.startsWith(`${year}-`)) || ymOf(year, 1);

        function focusMonth(ym) {
            const target = Number(ym.slice(0, 4));
            if (target !== year) {
                year = target;
                render(ym);
            }
            host.querySelectorAll('[data-ym]').forEach((b) => { b.tabIndex = b.dataset.ym === ym ? 0 : -1; });
            host.querySelector(`[data-ym="${ym}"]`).focus();
        }

        host.addEventListener('click', (e) => {
            const yearBtn = e.target.closest('[data-year-step]');
            if (yearBtn) {
                year += Number(yearBtn.dataset.yearStep);
                render(landingYm());
                // » goes disabled on reaching max's year; focus then moves to
                // the months rather than being dropped with the old button.
                const again = host.querySelector(`[data-year-step="${yearBtn.dataset.yearStep}"]`);
                (again.disabled ? host.querySelector('[data-ym][tabindex="0"]') : again).focus();
                return;
            }
            const cell = e.target.closest('[data-ym]');
            if (cell && !cell.disabled) onPick(cell.dataset.ym);
        });
        host.addEventListener('keydown', (e) => {
            const steps = ARROW_STEPS[e.key];
            const cell = e.target.closest('[data-ym]');
            if (!steps || !cell) return;
            e.preventDefault();
            const next = stepYm(cell.dataset.ym, steps);
            if (!isAfterMax(next)) focusMonth(next);
        });

        render(landingYm());
        return { focus: () => host.querySelector('[data-ym][tabindex="0"]')?.focus() };
    }

    function monthPicker(anchor, { value, onPick, max = null }) {
        if (openPicker) {
            const again = openPicker.anchor === anchor;
            openPicker.close();
            if (again) return;
        }
        const panel = document.createElement('div');
        panel.className = 'ant-picker-dropdown ant-scope';
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Choose a month');

        function close() {
            if (openPicker?.panel !== panel) return;
            openPicker = null;
            unwire();
            panel.remove();
            anchor.classList.remove('ant-picker-focused');
            anchor.setAttribute('aria-expanded', 'false');
        }

        const view = monthPanel(panel, {
            value,
            max,
            onPick: (ym) => {
                close();
                anchor.focus();
                onPick(ym);
            },
        });
        document.body.appendChild(panel);
        place(panel, anchor, { placement: 'bottom', align: 'start', gap: 4 });
        anchor.classList.add('ant-picker-focused');
        anchor.setAttribute('aria-expanded', 'true');
        const unwire = dismissible(panel, anchor, () => {
            close();
            anchor.focus();
        });
        openPicker = { anchor, panel, close };
        view.focus();
    }

    // ── Message ──────────────────────────────────────────────────────────────
    // The notice that drops in at the top centre after an action and leaves on
    // its own. The holder is a polite live region; an error is an alert. At
    // most three stay up, so a burst of them cannot stack down the window.
    const MESSAGE_MS = { success: 3000, info: 3000, error: 4500 };
    const MESSAGE_ICON = { success: 'check-circle', error: 'close-circle', info: 'info-circle' };
    const MESSAGE_MAX = 3;
    let messageHolder = null;

    function leave(notice) {
        if (!notice.isConnected) return;
        notice.classList.add('ant-message-notice-leave');
        notice.addEventListener('animationend', () => notice.remove(), { once: true });
        // Reduced motion has no animation to end.
        setTimeout(() => notice.remove(), 400);
    }

    function notify(type, text, { duration = MESSAGE_MS[type] } = {}) {
        if (!messageHolder) {
            messageHolder = document.createElement('div');
            messageHolder.className = 'ant-message ant-scope';
            messageHolder.setAttribute('aria-live', 'polite');
            document.body.appendChild(messageHolder);
        }
        const notice = document.createElement('div');
        notice.className = 'ant-message-notice';
        if (type === 'error') notice.setAttribute('role', 'alert');
        notice.innerHTML = `<div class="ant-message-notice-content ant-message-${type}">${icon(MESSAGE_ICON[type])}<span class="ant-message-text"></span></div>`;
        notice.querySelector('.ant-message-text').textContent = text;
        messageHolder.appendChild(notice);
        while (messageHolder.children.length > MESSAGE_MAX) messageHolder.firstElementChild.remove();
        setTimeout(() => leave(notice), duration);
    }

    const message = {
        success: (text, opts) => notify('success', text, opts),
        error: (text, opts) => notify('error', text, opts),
        info: (text, opts) => notify('info', text, opts),
    };

    // ── Tabs ─────────────────────────────────────────────────────────────────
    // The line Tabs' behaviour over a role="tablist" holding role="tab" buttons
    // that carry data-tab (ant.css draws them as .ant-tabs-tab): a press or the
    // arrow, Home and End keys select a tab, which moves aria-selected and the
    // roving tabindex. The panels are the caller's to show, in onChange.

    /** Wire `list`. Returns select(key), which selects without focusing. */
    function tabs(list, { onChange }) {
        const all = () => [...list.querySelectorAll('[role="tab"]')];
        function select(key, focus = false) {
            all().forEach((tab) => {
                const on = tab.dataset.tab === key;
                tab.setAttribute('aria-selected', String(on));
                tab.tabIndex = on ? 0 : -1;
                if (on && focus) tab.focus();
            });
            onChange(key);
        }
        list.addEventListener('click', (e) => {
            const tab = e.target.closest('[role="tab"]');
            if (tab && list.contains(tab)) select(tab.dataset.tab);
        });
        list.addEventListener('keydown', (e) => {
            const items = all();
            const i = items.indexOf(document.activeElement);
            if (i < 0) return;
            const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
            let j = -1;
            if (step) j = (i + step + items.length) % items.length;
            else if (e.key === 'Home') j = 0;
            else if (e.key === 'End') j = items.length - 1;
            if (j < 0) return;
            e.preventDefault();
            select(items[j].dataset.tab, true);
        });
        return select;
    }

    // ── Popover ──────────────────────────────────────────────────────────────
    // Ant's click Popover: a titled pop-up under the control that opened it,
    // holding whatever the page puts in it. One at a time; Escape, a press
    // outside it, or pressing the control again closes it.
    let openPopover = null;

    /** → { el, body, close, reposition } or null when this press closed it.
     *  `content` is a node, or trusted markup. `gap` is the space between the
     *  pop-up and its anchor (a dropdown-style pop-up without an arrow uses 4). */
    function popover(anchor, { title = '', content = '', className = '', placement = 'bottom', align = 'start', gap = 10, onClose = null }) {
        if (openPopover) {
            const again = openPopover.anchor === anchor;
            openPopover.close();
            if (again) return null;
        }
        const pop = document.createElement('div');
        pop.className = `ant-popover ant-scope ${className}`.trim();
        pop.setAttribute('role', 'dialog');
        if (title) pop.setAttribute('aria-label', title);
        pop.innerHTML = `<div class="ant-popover-arrow"></div>
            <div class="ant-popover-inner">
                ${title ? `<div class="ant-popover-title">${escapeHtml(title)}</div>` : ''}
                <div class="ant-popover-inner-content"></div>
            </div>`;
        const body = pop.querySelector('.ant-popover-inner-content');
        if (typeof content === 'string') body.innerHTML = content;
        else body.append(content);
        document.body.appendChild(pop);
        const reposition = () => place(pop, anchor, { placement, align, gap });
        reposition();
        anchor.setAttribute('aria-expanded', 'true');

        const unwire = dismissible(pop, anchor, () => {
            close();
            anchor.focus();
        });
        function close() {
            if (openPopover?.pop !== pop) return;
            openPopover = null;
            unwire();
            pop.remove();
            anchor.setAttribute('aria-expanded', 'false');
            if (onClose) onClose();
        }
        openPopover = { anchor, pop, close };
        return { el: pop, body, close, reposition };
    }

    // ── Listbox ──────────────────────────────────────────────────────────────
    // The options list Select and AutoComplete drop under their box. Focus
    // stays in the box, which is the combobox; the list follows it through
    // aria-activedescendant, and the box forwards the arrow keys here. Items
    // are { value, label, grouped } options and { group } headings, flat.
    let listboxSeq = 0;

    /** `anchor` is the combobox (it keeps the focus); `box`, the element the
     *  list hangs under and whose presses do not dismiss it, defaults to it. */
    function listbox(anchor, { box = anchor, items, multiple = false, isSelected = () => false, onPick, onDismiss, emptyText = 'No matches' }) {
        const id = `ant-listbox-${++listboxSeq}`;
        const el = document.createElement('div');
        el.className = 'ant-select-dropdown ant-scope';
        el.id = id;
        el.setAttribute('role', 'listbox');
        if (multiple) el.setAttribute('aria-multiselectable', 'true');
        let options = [];
        let active = -1;

        function render(next) {
            items = next;
            options = items.filter((it) => it.group == null);
            let n = 0;
            el.innerHTML = options.length ? items.map((it) => {
                if (it.group != null) {
                    return `<div class="ant-select-item ant-select-item-group" role="presentation">${escapeHtml(it.group)}</div>`;
                }
                const i = n++;
                const on = isSelected(it.value);
                return `<div class="ant-select-item ant-select-item-option${it.grouped ? ' ant-select-item-option-grouped' : ''}${on ? ' ant-select-item-option-selected' : ''}"
                    role="option" id="${id}-${i}" data-index="${i}" aria-selected="${on}">
                    <div class="ant-select-item-option-content">${escapeHtml(it.label)}</div>
                    ${multiple ? `<span class="ant-select-item-option-state" aria-hidden="true">${icon('check')}</span>` : ''}
                </div>`;
            }).join('') : `<div class="ant-select-item-empty">${escapeHtml(emptyText)}</div>`;
            setActive(Math.min(Math.max(active, 0), options.length - 1));
        }

        function setActive(i, scroll = true) {
            active = i;
            el.querySelectorAll('.ant-select-item-option-active').forEach((o) => o.classList.remove('ant-select-item-option-active'));
            const opt = i >= 0 ? el.querySelector(`[data-index="${i}"]`) : null;
            if (opt) {
                opt.classList.add('ant-select-item-option-active');
                if (scroll) opt.scrollIntoView({ block: 'nearest' });
                anchor.setAttribute('aria-activedescendant', opt.id);
            } else {
                anchor.removeAttribute('aria-activedescendant');
            }
        }

        // The pointer moves the highlight; a press must not take focus out of
        // the box, so the box keeps its keyboard.
        el.addEventListener('mousedown', (e) => e.preventDefault());
        el.addEventListener('mousemove', (e) => {
            const opt = e.target.closest('[data-index]');
            if (opt && Number(opt.dataset.index) !== active) setActive(Number(opt.dataset.index), false);
        });
        el.addEventListener('click', (e) => {
            const opt = e.target.closest('[data-index]');
            if (opt) onPick(options[Number(opt.dataset.index)]);
        });

        render(items);
        document.body.appendChild(el);
        el.style.minWidth = `${Math.round(box.getBoundingClientRect().width)}px`;
        const reposition = () => place(el, box, { placement: 'bottom', align: 'start', gap: 4 });
        reposition();
        anchor.setAttribute('aria-controls', id);
        const unwire = dismissible(el, box, () => onDismiss());

        return {
            el,
            update: (next) => { render(next); reposition(); },
            /** Redraw the ticks after a pick, keeping the highlight. */
            refresh: () => render(items),
            move: (step) => {
                if (!options.length) return;
                setActive(active < 0 ? 0 : (active + step + options.length) % options.length);
            },
            activeItem: () => options[active] || null,
            close: () => {
                unwire();
                el.remove();
                anchor.removeAttribute('aria-activedescendant');
            },
        };
    }

    // ── Select, multiple ─────────────────────────────────────────────────────
    // Select mode="multiple": the picked options as tags in the box (as many
    // as fit, then one "+ N …" tag), the list under it staying open while
    // options are ticked. With `search`, typing in the box narrows the list.
    // allowClear's × clears every pick. The box's input is the combobox.

    /** `options` are Listbox items. → { setValue(values), setOptions(items), value() } */
    function multiSelect(root, { options = [], value = [], placeholder = '', ariaLabel = '', search = false, onChange }) {
        let items = options;
        let values = [...value];
        let list = null;
        const name = ariaLabel || placeholder;

        root.classList.add('ant-select', 'ant-select-multiple');
        root.innerHTML = `<div class="ant-select-selector">
                <input class="ant-select-selection-search" role="combobox" aria-haspopup="listbox"
                    aria-expanded="false" aria-autocomplete="list" aria-label="${escapeHtml(name)}"
                    autocomplete="off" spellcheck="false"${search ? '' : ' readonly'}>
                <span class="ant-select-selection-placeholder">${escapeHtml(placeholder)}</span>
            </div>
            <span class="ant-select-arrow">${icon('down')}</span>
            <button type="button" class="ant-select-clear" tabindex="-1" aria-label="Clear ${escapeHtml(name)}">${icon('close-circle')}</button>`;
        const box = root.querySelector('.ant-select-selector');
        const input = root.querySelector('input');
        const placeholderEl = root.querySelector('.ant-select-selection-placeholder');

        const choices = () => items.filter((it) => it.group == null);
        const labelOf = (v) => choices().find((o) => o.value === v)?.label ?? String(v);
        const order = (vs) => {
            const pos = new Map(choices().map((o, i) => [o.value, i]));
            return [...vs].sort((a, b) => (pos.get(a) ?? 1e9) - (pos.get(b) ?? 1e9));
        };

        /** Items matching the search, each heading kept only above a match. */
        function visibleItems() {
            const q = input.value.trim().toLowerCase();
            if (!q) return items;
            const out = [];
            let heading = null;
            for (const it of items) {
                if (it.group != null) { heading = it; continue; }
                if (!String(it.label).toLowerCase().includes(q)) continue;
                if (heading) { out.push(heading); heading = null; }
                out.push(it);
            }
            return out;
        }

        function renderTags() {
            box.querySelectorAll('.ant-select-selection-item').forEach((t) => t.remove());
            const tags = values.map((v) => {
                const tag = document.createElement('span');
                tag.className = 'ant-select-selection-item';
                tag.title = labelOf(v);
                tag.innerHTML = `<span class="ant-select-selection-item-content"></span>
                    <button type="button" class="ant-select-selection-item-remove" tabindex="-1" aria-label="Remove ${escapeHtml(labelOf(v))}">${icon('close')}</button>`;
                tag.firstElementChild.textContent = labelOf(v);
                tag.dataset.value = String(v);
                box.insertBefore(tag, input);
                return tag;
            });
            root.classList.toggle('ant-select-has-value', values.length > 0);
            placeholderEl.hidden = values.length > 0 || input.value !== '';
            // maxTagCount="responsive": hide tags from the end until the rest
            // fit, and count them in one tag of their own.
            if (tags.length > 1) {
                const rest = document.createElement('span');
                rest.className = 'ant-select-selection-item ant-select-selection-rest';
                box.insertBefore(rest, input);
                let hidden = 0;
                rest.hidden = true;
                while (box.scrollWidth > box.clientWidth + 1 && hidden < tags.length - 1) {
                    hidden++;
                    tags[tags.length - hidden].hidden = true;
                    rest.hidden = false;
                    rest.textContent = `+ ${hidden} …`;
                }
                if (!hidden) rest.remove();
            }
        }

        function emit() {
            renderTags();
            if (list) list.refresh();
            onChange([...values]);
        }

        function toggle(v) {
            values = values.includes(v) ? values.filter((x) => x !== v) : order([...values, v]);
            if (input.value) {
                input.value = '';
                if (list) list.update(visibleItems());
            }
            emit();
        }

        function open() {
            if (list) return;
            list = listbox(input, {
                box: root,
                items: visibleItems(),
                multiple: true,
                isSelected: (v) => values.includes(v),
                onPick: (it) => toggle(it.value),
                onDismiss: close,
            });
            root.classList.add('ant-select-open');
            input.setAttribute('aria-expanded', 'true');
        }

        function close() {
            if (!list) return;
            list.close();
            list = null;
            root.classList.remove('ant-select-open');
            input.setAttribute('aria-expanded', 'false');
            if (input.value) {
                input.value = '';
                renderTags();
            }
        }

        box.addEventListener('mousedown', (e) => {
            if (e.target.closest('.ant-select-selection-item-remove')) return;
            e.preventDefault();
            input.focus();
            if (list) close();
            else open();
        });
        box.addEventListener('click', (e) => {
            const remove = e.target.closest('.ant-select-selection-item-remove');
            if (!remove) return;
            values = values.filter((v) => String(v) !== remove.closest('[data-value]').dataset.value);
            emit();
        });
        root.querySelector('.ant-select-clear').addEventListener('click', () => {
            values = [];
            emit();
            input.focus();
        });
        input.addEventListener('input', () => {
            open();
            list.update(visibleItems());
            placeholderEl.hidden = values.length > 0 || input.value !== '';
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                if (!list) open();
                else list.move(e.key === 'ArrowDown' ? 1 : -1);
            } else if (e.key === 'Enter' || (e.key === ' ' && !search)) {
                e.preventDefault();
                if (!list) { open(); return; }
                const it = list.activeItem();
                if (it) toggle(it.value);
            } else if (e.key === 'Backspace' && !input.value && values.length) {
                values = values.slice(0, -1);
                emit();
            } else if (e.key === 'Tab') {
                close();
            }
        });
        input.addEventListener('blur', () => close());
        renderTags();

        return {
            setValue(next) {
                values = order(next);
                renderTags();
                if (list) list.refresh();
            },
            setOptions(next) {
                items = next;
                values = values.filter((v) => choices().some((o) => o.value === v));
                renderTags();
                if (list) list.update(visibleItems());
            },
            value: () => [...values],
        };
    }

    // ── AutoComplete ─────────────────────────────────────────────────────────
    // A text input that offers matches under it as it is typed: arrows move
    // through them, Enter or a press takes one. `source(text)` → strings.
    function autocomplete(input, { source, max = 8, onPick = null }) {
        let list = null;
        input.setAttribute('role', 'combobox');
        input.setAttribute('aria-autocomplete', 'list');
        input.setAttribute('aria-expanded', 'false');
        input.autocomplete = 'off';

        const itemsFor = () => source(input.value).slice(0, max).map((s) => ({ value: s, label: s }));
        function close() {
            if (!list) return;
            list.close();
            list = null;
            input.setAttribute('aria-expanded', 'false');
        }
        // A pick fires `input` for the page; the flag keeps that from
        // reopening the list.
        let picking = false;
        function pick(it) {
            input.value = it.value;
            close();
            picking = true;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            picking = false;
            if (onPick) onPick(it.value);
        }
        function show() {
            const items = itemsFor();
            if (!items.length || (items.length === 1 && items[0].value === input.value)) { close(); return; }
            if (list) { list.update(items); return; }
            list = listbox(input, { items, onPick: pick, onDismiss: close });
            list.move(0);
            input.setAttribute('aria-expanded', 'true');
        }
        input.addEventListener('input', () => { if (!picking) show(); });
        input.addEventListener('keydown', (e) => {
            if (!list) return;
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                list.move(e.key === 'ArrowDown' ? 1 : -1);
            } else if (e.key === 'Enter') {
                const it = list.activeItem();
                if (!it) return;
                e.preventDefault();
                pick(it);
            } else if (e.key === 'Tab') {
                close();
            }
        });
        input.addEventListener('blur', close);
        return { close };
    }

    // ── RangePicker ──────────────────────────────────────────────────────────
    // DatePicker.RangePicker: two read-only fields either side of an arrow
    // that open the presets beside a month of days. The first day picked is
    // the start, the second the end (the days between are previewed under
    // the pointer); picking an end before the start starts over from it.
    // Either end may stay empty. Dates are 'YYYY-MM-DD'; `format` draws them.
    // The month moves with ‹ › and the year with « »; in the grid the arrows
    // move a day or a week, PageUp/PageDown a month, Enter picks.
    const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
    const pad2 = (n) => String(n).padStart(2, '0');
    const isoOf = (date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
    const dateOf = (iso) => {
        const [y, m, d] = iso.split('-').map(Number);
        return new Date(y, m - 1, d);
    };
    const shiftIso = (iso, days) => {
        const d = dateOf(iso);
        d.setDate(d.getDate() + days);
        return isoOf(d);
    };

    /** → { setValue([from, to]) }. `presets` are { label, value: [from, to] }. */
    function rangePicker(root, {
        value = [null, null], presets = [], format = (iso) => iso, placeholder = ['Start date', 'End date'],
        ariaLabel = 'Dates', weekStart = 0, onChange,
    }) {
        let range = [...value];
        let side = 0;
        let pop = null;
        let view = null;   // first of the month on screen
        let hover = null;
        let committed = JSON.stringify(range);

        root.classList.add('ant-picker', 'ant-picker-range');
        root.innerHTML = `
            <div class="ant-picker-input"><input readonly placeholder="${escapeHtml(placeholder[0])}" aria-label="${escapeHtml(ariaLabel)}: ${escapeHtml(placeholder[0])}" aria-haspopup="dialog" aria-expanded="false"></div>
            <span class="ant-picker-range-separator" aria-hidden="true">${icon('swap-right')}</span>
            <div class="ant-picker-input"><input readonly placeholder="${escapeHtml(placeholder[1])}" aria-label="${escapeHtml(ariaLabel)}: ${escapeHtml(placeholder[1])}" aria-haspopup="dialog" aria-expanded="false"></div>
            <span class="ant-picker-suffix" aria-hidden="true">${icon('calendar')}</span>
            <button type="button" class="ant-picker-clear" tabindex="-1" aria-label="Clear ${escapeHtml(ariaLabel)}">${icon('close-circle')}</button>`;
        const inputs = [...root.querySelectorAll('input')];
        const days = WEEKDAYS.slice(weekStart).concat(WEEKDAYS.slice(0, weekStart));

        function sync() {
            inputs.forEach((inp, i) => { inp.value = range[i] ? format(range[i]) : ''; });
            root.classList.toggle('ant-picker-has-value', !!(range[0] || range[1]));
            root.querySelectorAll('.ant-picker-input').forEach((wrap, i) => wrap.classList.toggle('ant-picker-input-active', !!pop && i === side));
        }

        function commit() {
            const now = JSON.stringify(range);
            if (now === committed) return;
            committed = now;
            onChange([...range]);
        }

        /** The days between the two ends, or between the end set and the day
         *  under the pointer while the other end is being picked. */
        function paint() {
            if (!pop) return;
            const [from, to] = range;
            const lo = side === 1 ? from : hover;
            const hi = side === 1 ? hover : to;
            pop.el.querySelectorAll('td[data-iso]').forEach((td) => {
                const iso = td.dataset.iso;
                const inView = !td.classList.contains('ant-picker-cell-out');
                const both = from && to;
                td.classList.toggle('ant-picker-cell-in-range', inView && !!both && iso >= from && iso <= to);
                td.classList.toggle('ant-picker-cell-range-start', inView && iso === from);
                td.classList.toggle('ant-picker-cell-range-end', inView && iso === to);
                td.classList.toggle('ant-picker-cell-in-preview', inView && !!(lo && hi && lo < hi) && iso > lo && iso < hi);
                td.firstElementChild.setAttribute('aria-pressed', String(iso === from || iso === to));
            });
        }

        function renderMonth(focusIso = null) {
            const y = view.getFullYear();
            const m = view.getMonth();
            const first = new Date(y, m, 1);
            const lead = (first.getDay() - weekStart + 7) % 7;
            const start = new Date(y, m, 1 - lead);
            const today = isoOf(new Date());
            const target = focusIso || [range[side], range[1 - side], today].find((d) => d && d.startsWith(`${y}-${pad2(m + 1)}`))
                || isoOf(first);
            let rows = '';
            for (let r = 0; r < 6; r++) {
                rows += '<tr>';
                for (let c = 0; c < 7; c++) {
                    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + r * 7 + c);
                    const iso = isoOf(d);
                    const out = d.getMonth() !== m;
                    rows += `<td class="ant-picker-cell${out ? ' ant-picker-cell-out' : ''}" data-iso="${iso}">
                        <button type="button" class="ant-picker-cell-inner" data-iso="${iso}" tabindex="${iso === target ? 0 : -1}"
                            aria-label="${d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}"
                            ${iso === today ? 'aria-current="date"' : ''}>${d.getDate()}</button></td>`;
                }
                rows += '</tr>';
            }
            const panel = pop.el.querySelector('.ant-picker-panel');
            panel.querySelector('.ant-picker-header-view').textContent = `${MONTH_SHORT[m]} ${y}`;
            panel.querySelector('tbody').innerHTML = rows;
            paint();
        }

        function focusDay(iso) {
            const d = dateOf(iso);
            if (d.getFullYear() !== view.getFullYear() || d.getMonth() !== view.getMonth()) {
                view = new Date(d.getFullYear(), d.getMonth(), 1);
                renderMonth(iso);
            }
            pop.el.querySelectorAll('.ant-picker-cell-inner').forEach((b) => { b.tabIndex = b.dataset.iso === iso ? 0 : -1; });
            pop.el.querySelector(`.ant-picker-cell-inner[data-iso="${iso}"]`)?.focus();
        }

        function pick(iso) {
            if (side === 0) {
                range[0] = iso;
                if (range[1] && range[1] < iso) range[1] = null;
                side = 1;
                hover = null;
                sync();
                paint();
                return;
            }
            if (range[0] && iso < range[0]) {
                range = [iso, null];   // an end before the start starts over from it
                paint();
                sync();
                return;
            }
            range[1] = iso;
            close(true);
        }

        function open(at) {
            side = at;
            if (pop) { sync(); paint(); return; }
            const el = document.createElement('div');
            el.className = 'ant-picker-dropdown ant-scope';
            el.setAttribute('role', 'dialog');
            el.setAttribute('aria-label', `Choose ${ariaLabel.toLowerCase()}`);
            el.innerHTML = `<div class="ant-picker-panel-container">
                ${presets.length ? `<ul class="ant-picker-presets">${presets.map((p, i) => `<li><button type="button" data-preset="${i}">${escapeHtml(p.label)}</button></li>`).join('')}</ul>` : ''}
                <div class="ant-picker-panel">
                    <div class="ant-picker-header">
                        <button type="button" class="ant-picker-header-btn ant-picker-header-super-prev" data-months="-12" aria-label="Previous year">${icon('double-left')}</button>
                        <button type="button" class="ant-picker-header-btn" data-months="-1" aria-label="Previous month">${icon('left')}</button>
                        <div class="ant-picker-header-view" aria-live="polite"></div>
                        <button type="button" class="ant-picker-header-btn" data-months="1" aria-label="Next month">${icon('right')}</button>
                        <button type="button" class="ant-picker-header-btn ant-picker-header-super-next" data-months="12" aria-label="Next year">${icon('double-right')}</button>
                    </div>
                    <div class="ant-picker-body ant-picker-date-body">
                        <table class="ant-picker-content" role="grid">
                            <thead><tr>${days.map((d) => `<th scope="col">${d}</th>`).join('')}</tr></thead>
                            <tbody></tbody>
                        </table>
                    </div>
                </div>
            </div>`;
            document.body.appendChild(el);
            const anchorDay = range[side] || range[1 - side] || isoOf(new Date());
            const a = dateOf(anchorDay);
            view = new Date(a.getFullYear(), a.getMonth(), 1);
            pop = { el };
            renderMonth();
            place(el, root, { placement: 'bottom', align: 'start', gap: 4 });
            root.classList.add('ant-picker-focused');
            inputs.forEach((inp) => inp.setAttribute('aria-expanded', 'true'));
            pop.unwire = dismissible(el, root, () => close(false));
            sync();

            el.addEventListener('click', (e) => {
                const preset = e.target.closest('[data-preset]');
                if (preset) {
                    range = [...presets[Number(preset.dataset.preset)].value];
                    close(true);
                    return;
                }
                const step = e.target.closest('[data-months]');
                if (step) {
                    view = new Date(view.getFullYear(), view.getMonth() + Number(step.dataset.months), 1);
                    renderMonth();
                    return;
                }
                const cell = e.target.closest('.ant-picker-cell-inner');
                if (cell) pick(cell.dataset.iso);
            });
            el.addEventListener('mouseover', (e) => {
                const td = e.target.closest('td[data-iso]');
                const next = td ? td.dataset.iso : null;
                if (next !== hover) { hover = next; paint(); }
            });
            el.addEventListener('mouseleave', () => { hover = null; paint(); });
            el.addEventListener('focusin', (e) => {
                const cell = e.target.closest('.ant-picker-cell-inner');
                if (cell && cell.dataset.iso !== hover) { hover = cell.dataset.iso; paint(); }
            });
            el.addEventListener('keydown', (e) => {
                const cell = e.target.closest('.ant-picker-cell-inner');
                if (!cell) return;
                const iso = cell.dataset.iso;
                const by = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    pick(iso);
                    // Picking the start moves on to the end, in the same grid.
                    pop?.el.querySelector(`.ant-picker-cell-inner[data-iso="${iso}"]`)?.focus();
                } else if (by) {
                    e.preventDefault();
                    focusDay(shiftIso(iso, by));
                } else if (e.key === 'PageUp' || e.key === 'PageDown') {
                    e.preventDefault();
                    const d = dateOf(iso);
                    d.setMonth(d.getMonth() + (e.key === 'PageUp' ? -1 : 1));
                    focusDay(isoOf(d));
                }
            });
        }

        /** `done`: a range was finished (both ends, or a preset), so the
         *  focus goes back to the field; otherwise it was dismissed. */
        function close(done) {
            if (!pop) return;
            const hadFocus = pop.el.contains(document.activeElement);
            pop.unwire();
            pop.el.remove();
            pop = null;
            hover = null;
            root.classList.remove('ant-picker-focused');
            inputs.forEach((inp) => inp.setAttribute('aria-expanded', 'false'));
            sync();
            commit();
            if (done || hadFocus) inputs[done ? 1 : side].focus();
        }

        inputs.forEach((inp, i) => {
            inp.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
                    e.preventDefault();
                    open(i);
                    pop.el.querySelector('.ant-picker-cell-inner[tabindex="0"]')?.focus();
                }
            });
        });
        root.addEventListener('click', (e) => {
            if (e.target.closest('.ant-picker-clear')) return;
            const i = inputs.indexOf(e.target);
            open(i >= 0 ? i : (range[0] && !range[1] ? 1 : 0));
        });
        root.querySelector('.ant-picker-clear').addEventListener('click', (e) => {
            e.stopPropagation();
            range = [null, null];
            if (pop) close(false);
            sync();
            commit();
        });
        sync();

        return {
            setValue(next) {
                range = [...next];
                committed = JSON.stringify(range);
                sync();
                paint();
            },
        };
    }

    // ── Pagination ───────────────────────────────────────────────────────────
    // The total, then ‹ 1 • • • 4 5 [6] 7 8 • • • 20 › and the page size. The
    // • • • jumps five pages. `root` is a <ul>; onChange(current, pageSize).
    function pagination(root, { current = 1, pageSize = 10, total = 0, pageSizeOptions = [10, 20, 50, 100], showTotal = null, onChange }) {
        const state = { current, pageSize, total };
        root.classList.add('ant-pagination');
        const pageCount = () => Math.max(1, Math.ceil(state.total / state.pageSize));

        function render() {
            const n = pageCount();
            const c = Math.min(Math.max(1, state.current), n);
            state.current = c;
            const nums = [];
            if (n <= 9) {
                for (let i = 1; i <= n; i++) nums.push(i);
            } else {
                let left = Math.max(1, c - 2);
                let right = Math.min(n, c + 2);
                if (c - 1 <= 2) right = 5;
                if (n - c <= 2) left = n - 4;
                nums.push(1);
                if (left > 2) nums.push('prev');
                for (let i = Math.max(left, 2); i <= Math.min(right, n - 1); i++) nums.push(i);
                if (right < n - 1) nums.push('next');
                nums.push(n);
            }
            const first = state.total ? (c - 1) * state.pageSize + 1 : 0;
            const last = Math.min(c * state.pageSize, state.total);
            const item = (p) => {
                if (p === 'prev' || p === 'next') {
                    const to = p === 'prev' ? Math.max(1, c - 5) : Math.min(n, c + 5);
                    return `<li><button type="button" class="ant-pagination-jump" data-page="${to}" aria-label="${p === 'prev' ? 'Previous' : 'Next'} 5 pages">
                        <span class="ant-pagination-jump-dots" aria-hidden="true">•••</span>${icon(p === 'prev' ? 'double-left' : 'double-right')}</button></li>`;
                }
                return `<li><button type="button" class="ant-pagination-item${p === c ? ' ant-pagination-item-active' : ''}" data-page="${p}"
                    ${p === c ? 'aria-current="page"' : ''} aria-label="Page ${p}">${p}</button></li>`;
            };
            root.innerHTML = `
                ${showTotal ? `<li class="ant-pagination-total-text">${escapeHtml(showTotal(state.total, [first, last]))}</li>` : ''}
                <li><button type="button" class="ant-pagination-prev" data-page="${c - 1}" aria-label="Previous page"${c <= 1 ? ' disabled' : ''}>${icon('left')}</button></li>
                ${nums.map(item).join('')}
                <li><button type="button" class="ant-pagination-next" data-page="${c + 1}" aria-label="Next page"${c >= n ? ' disabled' : ''}>${icon('right')}</button></li>
                ${pageSizeOptions.length ? `<li class="ant-pagination-options"><span class="ant-select">
                    <select class="ant-select-selector" aria-label="Rows per page">
                        ${pageSizeOptions.map((s) => `<option value="${s}"${s === state.pageSize ? ' selected' : ''}>${s} / page</option>`).join('')}
                    </select><span class="ant-select-arrow">${icon('down')}</span></span></li>` : ''}`;
        }

        root.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-page]');
            if (!btn || btn.disabled) return;
            state.current = Number(btn.dataset.page);
            render();
            root.querySelector(`[data-page="${state.current}"].ant-pagination-item`)?.focus();
            onChange(state.current, state.pageSize);
        });
        root.addEventListener('change', (e) => {
            if (!e.target.matches('select')) return;
            // Keep the first row on screen in view at the new size.
            const firstRow = (state.current - 1) * state.pageSize;
            state.pageSize = Number(e.target.value);
            state.current = Math.floor(firstRow / state.pageSize) + 1;
            render();
            onChange(state.current, state.pageSize);
        });
        render();
        return {
            update(next) {
                Object.assign(state, next);
                render();
            },
        };
    }

    // ── Notification ─────────────────────────────────────────────────────────
    // The notice in the bottom-right corner offering a follow-up: an icon, a
    // title, a line of detail and up to two actions. It leaves after
    // `duration` unless the pointer or the focus is in it. A second one with
    // the same `key` replaces the first.
    let notificationHolder = null;
    const notices = new Map();

    /** `actions`: [{ label, primary, onClick }]. → { close } */
    function notification({ key = null, title, description = '', icon: iconName = null, iconClass = '', actions = [], duration = 4500 }) {
        if (key && notices.has(key)) notices.get(key).close();
        if (!notificationHolder) {
            notificationHolder = document.createElement('div');
            notificationHolder.className = 'ant-notification ant-scope';
            notificationHolder.setAttribute('aria-live', 'polite');
            document.body.appendChild(notificationHolder);
        }
        const el = document.createElement('div');
        el.className = `ant-notification-notice${iconName ? ' ant-notification-notice-with-icon' : ''}`;
        el.setAttribute('role', 'status');
        el.innerHTML = `${iconName ? `<span class="ant-notification-notice-icon ${iconClass}" aria-hidden="true">${icon(iconName)}</span>` : ''}
            <div class="ant-notification-notice-title"></div>
            ${description ? '<div class="ant-notification-notice-description"></div>' : ''}
            ${actions.length ? `<div class="ant-notification-notice-actions">${actions.map((a, i) => `<button type="button" class="ant-btn ant-btn-sm ${a.primary ? 'ant-btn-primary' : 'ant-btn-default'}" data-action="${i}">${escapeHtml(a.label)}</button>`).join('')}</div>` : ''}
            <button type="button" class="ant-notification-notice-close" aria-label="Close">${icon('close')}</button>`;
        el.querySelector('.ant-notification-notice-title').textContent = title;
        if (description) el.querySelector('.ant-notification-notice-description').textContent = description;
        notificationHolder.appendChild(el);

        let timer = 0;
        let closed = false;
        const arm = () => { clearTimeout(timer); if (duration) timer = setTimeout(close, duration); };
        function close() {
            if (closed) return;
            closed = true;
            clearTimeout(timer);
            if (key && notices.get(key)?.el === el) notices.delete(key);
            el.classList.add('ant-notification-notice-leave');
            el.addEventListener('animationend', () => el.remove(), { once: true });
            setTimeout(() => el.remove(), 400);
        }
        el.addEventListener('mouseenter', () => clearTimeout(timer));
        el.addEventListener('mouseleave', () => { if (!el.contains(document.activeElement)) arm(); });
        el.addEventListener('focusin', () => clearTimeout(timer));
        el.addEventListener('focusout', (e) => { if (!el.contains(e.relatedTarget)) arm(); });
        el.addEventListener('click', (e) => {
            if (e.target.closest('.ant-notification-notice-close')) { close(); return; }
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            close();
            actions[Number(btn.dataset.action)].onClick?.();
        });
        arm();
        const handle = { el, close };
        if (key) notices.set(key, handle);
        return handle;
    }

    // ── Steps, Slider, Spin ──────────────────────────────────────────────────
    /** Small Steps over `titles`, `current` (0-based) in progress. */
    function steps(titles, current) {
        return `<ol class="ant-steps">${titles.map((title, i) => {
            const status = i < current ? 'finish' : i === current ? 'process' : 'wait';
            return `<li class="ant-steps-item ant-steps-item-${status}"${i === current ? ' aria-current="step"' : ''}>
                <span class="ant-steps-item-icon">${status === 'finish' ? icon('check') : i + 1}</span>
                <span class="ant-steps-item-title">${escapeHtml(title)}</span></li>`;
        }).join('')}</ol>`;
    }

    /** Keep a native range's filled part in step with its value. → sync() */
    function slider(input) {
        const sync = () => {
            const min = Number(input.min || 0);
            const max = Number(input.max || 100);
            input.style.setProperty('--ant-slider-pct', `${((Number(input.value) - min) / (max - min)) * 100}%`);
        };
        input.addEventListener('input', sync);
        sync();
        return sync;
    }

    /** Spin with its tip under it. */
    function spin(tip = '') {
        return `<div class="ant-spin" role="status"><span class="ant-spin-dot" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
            ${tip ? `<div class="ant-spin-text">${escapeHtml(tip)}</div>` : ''}</div>`;
    }

    // ── Dropdown ─────────────────────────────────────────────────────────────
    // A menu under the button that opened it: items to run, a dangerous one in
    // red, a disabled one greyed. The arrows move through the items, Enter or a
    // press runs one; Escape, a press outside or pressing the button again
    // closes it. One at a time.
    let openDropdown = null;

    /** `items`: [{ label, icon?, danger?, disabled? }]. onPick(item, index).
     *  → { el, close }, or null when pressing the button again closed it. */
    function dropdown(anchor, { items, onPick, align = 'start' }) {
        if (openDropdown) {
            const again = openDropdown.anchor === anchor;
            openDropdown.close();
            if (again) return null;
        }
        const el = document.createElement('div');
        el.className = 'ant-dropdown ant-scope';
        el.innerHTML = `<ul class="ant-dropdown-menu" role="menu">${items.map((it, i) => `<li role="none">
            <button type="button" role="menuitem" class="ant-dropdown-menu-item${it.danger ? ' ant-dropdown-menu-item-danger' : ''}"
                data-index="${i}"${it.disabled ? ' disabled' : ''}>${it.icon ? icon(it.icon) : ''}<span class="ant-dropdown-menu-title-content">${escapeHtml(it.label)}</span></button></li>`).join('')}</ul>`;
        document.body.appendChild(el);
        place(el, anchor, { placement: 'bottom', align, gap: 4 });
        anchor.setAttribute('aria-expanded', 'true');

        const enabled = () => [...el.querySelectorAll('[role="menuitem"]:not(:disabled)')];
        el.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-index]');
            if (!btn || btn.disabled) return;
            close();
            anchor.focus();
            onPick(items[Number(btn.dataset.index)], Number(btn.dataset.index));
        });
        el.addEventListener('keydown', (e) => {
            const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
            if (!step) return;
            e.preventDefault();
            const list = enabled();
            const i = list.indexOf(document.activeElement);
            list[(i + step + list.length) % list.length]?.focus();
        });
        const unwire = dismissible(el, anchor, () => {
            close();
            anchor.focus();
        });
        function close() {
            if (openDropdown?.el !== el) return;
            openDropdown = null;
            unwire();
            el.remove();
            anchor.setAttribute('aria-expanded', 'false');
        }
        openDropdown = { anchor, el, close };
        enabled()[0]?.focus();
        return { el, close };
    }

    // ── Drawer ───────────────────────────────────────────────────────────────
    // A panel that slides in from the right edge over a mask: the close × and
    // the title, then a body that scrolls. Escape, the mask or the × closes it,
    // Tab stays inside it, and the focus goes back to whatever opened it.
    // setAway(true) slides it out of the way without closing it, for a drag
    // that starts in it and ends on the page underneath.
    let drawerSeq = 0;

    /** `body` is a node, or trusted markup. → { el, body, close, setAway(on) } */
    function drawer({ title, body = '', width = 378, className = '', onClose = null }) {
        const titleId = `ant-drawer-title-${++drawerSeq}`;
        const opener = document.activeElement;
        const root = document.createElement('div');
        root.className = `ant-drawer ant-scope ${className}`.trim();
        root.innerHTML = `<div class="ant-drawer-mask"></div>
            <div class="ant-drawer-content-wrapper" style="width: min(${Number(width)}px, 100vw)">
                <section class="ant-drawer-content" role="dialog" aria-modal="true" aria-labelledby="${titleId}" tabindex="-1">
                    <header class="ant-drawer-header">
                        <button type="button" class="ant-drawer-close" aria-label="Close">${icon('close')}</button>
                        <div class="ant-drawer-title" id="${titleId}">${escapeHtml(title)}</div>
                    </header>
                    <div class="ant-drawer-body"></div>
                </section>
            </div>`;
        const bodyEl = root.querySelector('.ant-drawer-body');
        if (typeof body === 'string') bodyEl.innerHTML = body;
        else bodyEl.append(body);
        const content = root.querySelector('.ant-drawer-content');
        document.body.appendChild(root);
        // One painted frame off-screen first, so the slide-in runs.
        requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('ant-drawer-open')));
        content.focus({ preventScroll: true });

        let closed = false;
        function onKey(e) {
            if (root.classList.contains('ant-drawer-away')) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopImmediatePropagation();
                close();
            } else if (content.contains(document.activeElement)) {
                keepTabInside(e, content);
            }
        }
        function close() {
            if (closed) return;
            closed = true;
            document.removeEventListener('keydown', onKey, true);
            root.classList.remove('ant-drawer-open');
            root.addEventListener('transitionend', () => root.remove(), { once: true });
            // Reduced motion has no transition to end.
            setTimeout(() => root.remove(), 400);
            if (onClose) onClose();
            if (content.contains(document.activeElement) && opener instanceof HTMLElement && opener.isConnected) opener.focus();
        }
        document.addEventListener('keydown', onKey, true);
        root.querySelector('.ant-drawer-mask').addEventListener('click', close);
        root.querySelector('.ant-drawer-close').addEventListener('click', close);
        const setAway = (on) => root.classList.toggle('ant-drawer-away', on);
        return { el: root, body: bodyEl, close, setAway };
    }

    // ── Category colours ─────────────────────────────────────────────────────
    // Ant's categorical palette (AntV's), one hue per default category so a
    // category reads the same on every page that draws one (a ledger tag, a
    // chart band, a legend dot); any other category takes one of the extra hues
    // by a hash of its key. Money arriving is the income colour, money put away
    // the transfer one, and Uncategorized a neutral grey.
    //
    // Every hue is var() text over the --ant-chart-* tokens (ant.css), because
    // the Graphs palette in Preferences re-points them (themes.css). Setting
    // one in a style attribute resolves it, and a chart that needs the colour
    // itself reads it back (dashcards.js paint()).
    const CATEGORY_HUES = {
        rent: 'var(--ant-chart-1)', food: 'var(--ant-chart-4)', utilities: 'var(--ant-chart-2)',
        automobile: 'var(--ant-chart-3)', health: 'var(--ant-chart-5)', entertainment: 'var(--ant-chart-6)',
        shopping: 'var(--ant-chart-9)', travel: 'var(--ant-chart-7)', insurance: 'var(--ant-chart-8)',
        general: 'var(--ant-chart-10)', investing: 'var(--ant-chart-purple)',
        income: 'var(--ant-chart-income)', other_income: 'var(--ant-chart-income-2)',
        savings: 'var(--ant-chart-transfer)',
        uncat_income: 'var(--ant-chart-neutral)', uncat_expense: 'var(--ant-chart-neutral)',
    };
    const EXTRA_HUES = Array.from({ length: 8 }, (_, i) => `var(--ant-chart-extra-${i + 1})`);

    /** FNV-1a over the key's characters: a stable pick of an extra hue. */
    function hashKey(s) {
        let h = 2166136261;
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return h >>> 0;
    }

    const categoryHue = (key) => CATEGORY_HUES[key] || EXTRA_HUES[hashKey(String(key)) % EXTRA_HUES.length];

    // Icons written into static page markup.
    document.addEventListener('DOMContentLoaded', () => {
        document.querySelectorAll('[data-ant-icon]').forEach((el) => {
            el.innerHTML = iconSvg(el.dataset.antIcon);
        });
    });

    window.Ant = {
        icon, empty, modal, confirm, popconfirm, monthPicker, monthPanel, message, tabs, isLoading, whileLoading,
        popover, multiSelect, autocomplete, rangePicker, pagination, notification, steps, slider, spin,
        dropdown, drawer, categoryHue,
    };
}());
