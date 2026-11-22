'use strict';

// ─── notice.js ──────────────────────────────────────────────────────────────
// How the Plan section tells the user something happened, in Manage's own
// pop-ups: Ant's message for a plain word ("Plan exported."), and a
// notification when there is something to do about it (Undo, Retry) or it
// must stay until it is closed (`duration: 0`).
//
//   planNotice('Copied Salary.')
//   planNotice('Deleted Salary.', { action: { label: 'Undo', onClick: undo } })
//   planNotice('Not imported: …', { type: 'error' })
//
// `type` is 'info' | 'success' | 'warning' | 'error'. Needs: Ant.

(function () {
    const ICONS = { info: 'info-circle', success: 'check-circle', warning: 'exclamation-circle', error: 'close-circle' };

    function planNotice(text, { type = 'info', action = null, duration } = {}) {
        if (!action && duration !== 0) {
            Ant.message[type](text, duration ? { duration } : undefined);
            return;
        }
        Ant.notification({
            title: text,
            icon: ICONS[type],
            iconClass: `ant-notification-icon-${type}`,
            actions: action ? [{ label: action.label, primary: true, onClick: action.onClick }] : [],
            duration: duration ?? 6000,
        });
    }

    window.planNotice = planNotice;
}());
