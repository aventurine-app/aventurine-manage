'use strict';

// ─── export-menu.js ─────────────────────────────────────────────────────────
// How a person takes their plans away:
//
//   ExportMenu.plan(id)     a plan tab's Export…: a dialog offering the PDF
//                           report, a spreadsheet (CSV) or the plan file (JSON)
//   ExportMenu.all()        Download All: every plan, the goals and a CSV per
//                           plan, as a zip
//   ExportMenu.reportAll()  one PDF report covering every plan
//
// Each asks where to save in a native save dialog. The plan file, CSV and zip
// are written by the backend (handlers/plans.js, through PlanStore); the
// report is drawn in the page (plan/report.js) and printed to PDF by
// Electron.

(function () {
    const CHOICES = [
        {
            format: 'pdf', icon: 'file-pdf', title: 'PDF Report',
            desc: 'Charts, figures, goals and a year-by-year table.',
        },
        {
            format: 'csv', icon: 'file-csv', title: 'Spreadsheet (CSV)',
            desc: 'Every month\'s income, spending and balances, for Excel, Numbers or Google Sheets.',
        },
        {
            format: 'json', icon: 'file-code', title: 'Plan File (JSON)',
            desc: 'The whole plan, to import into Aventurine again.',
        },
    ];

    /** Save the report on the plans `ids` as a PDF named after `title`. */
    async function saveReport(ids, title) {
        await PlanStore.flush();
        const wanted = new Set(ids);
        const entries = Runs.all().filter(({ plan }) => wanted.has(plan.id));
        if (!entries.length) return;
        const r = await PlanReport.save({ entries, goals: PlanStore.state.goals, title });
        if (r.error) planNotice(r.error, { type: 'error' });
        else if (r.saved) planNotice('Report saved.', { type: 'success' });
    }

    /** Run `work`, telling the user if it fails. */
    async function guarded(work) {
        try {
            await work();
        } catch (e) {
            console.error('[export] failed:', e);
            planNotice('The export did not finish. Try again in a moment.', { type: 'error' });
        }
    }

    function exportAs(id, format) {
        if (format === 'pdf') return saveReport([id], `${PlanStore.planName(id)} report`);
        return PlanStore.exportPlan(id, format);
    }

    /** A plan's Export…: pick a format, and it is made at once. */
    function plan(id) {
        const { dialog, close } = Ant.modal({
            title: `Export ${PlanStore.planName(id)}`,
            body: `<div class="export-choices">${CHOICES.map((c) => `
                <button class="export-choice" type="button" data-format="${c.format}">
                    ${planIcon(c.icon)}
                    <span class="export-choice-text">
                        <span class="export-choice-title">${escapeHtml(c.title)}</span>
                        <span class="export-choice-desc">${escapeHtml(c.desc)}</span>
                    </span>
                </button>`).join('')}</div>`,
            footer: '<button type="button" class="ant-btn ant-btn-default" data-cancel>Cancel</button>',
            width: 440,
        });
        dialog.addEventListener('click', (e) => {
            if (e.target.closest('[data-cancel]')) { close(); return; }
            const choice = e.target.closest('[data-format]');
            if (!choice) return;
            close();
            guarded(() => exportAs(id, choice.dataset.format));
        });
        dialog.querySelector('[data-format]').focus();
    }

    const all = () => guarded(() => PlanStore.exportAll());
    const reportAll = () => guarded(() => saveReport(PlanStore.state.tabs, 'Aventurine plans report'));

    window.ExportMenu = { plan, all, reportAll };
}());
