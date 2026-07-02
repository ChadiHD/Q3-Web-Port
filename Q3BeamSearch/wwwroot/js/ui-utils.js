// wwwroot/js/ui-utils.js
// DOM-only UI helpers shared across the viewer (no viewer state).

// Transient on-screen notification.
export function toast(msg) {
    const el = document.createElement('div');
    el.className = 'notification-toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2200);
}

// Trigger a client-side download of a text file.
export function downloadFile(name, content) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: 'text/plain' }));
    a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(a.href); }, 100);
}
