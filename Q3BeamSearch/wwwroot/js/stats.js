// wwwroot/js/stats.js
// The run statistics dashboard (stats.html): whole-run numbers, the current frame, and charts.
// Runs come from wwwroot/demos (GET /demos lists them) or from the 3D viewer's 📊 Stats button
// (localStorage q3StatsRun: {name, frames, physics}). The physics analysis is run-analysis.js.
/* global Chart */
import { analyseRun, summarise, wrapDeg, FPS } from './run-analysis.js';

const $ = id => document.getElementById(id);
const C = { speed: '#4fc3f7', path: '#81c784', angle: '#e57373', opt: '#66bb6a', min: '#8d95a1', eff: '#4dd0e1',
            vel: '#ffb74d', view: '#ba68c8', wish: '#81c784', cursor: '#ff6b6b', ring: '#333944', text: '#8d95a1' };

let frames = [], rows = [], current = 0, label = '';
let playing = false, raf = 0;

Chart.defaults.color = C.text;
Chart.defaults.borderColor = '#2a2e36';
Chart.defaults.animation = false;
Chart.defaults.font.family = 'system-ui, sans-serif';

// ─── Charts ─────────────────────────────────────────────────────────────────
// Each chart is drawn once per run. The current frame goes on a transparent canvas laid over
// it, so scrubbing and playback redraw a marker, not thousands of points.
const cursor = {
    id: 'cursor',
    afterInit(c) {
        c.$cursor = Object.assign(document.createElement('canvas'), { className: 'cursor' });
        c.canvas.parentNode.append(c.$cursor);
    },
    afterLayout(c) { c.$margin = [c.width - c.chartArea.width, c.height - c.chartArea.height]; },
    afterRender: c => drawCursor(c)
};

// c.$mark(row) → { x, y, vline: line across the plot at x, rays: [[x0, y0, x1, y1, color]]
// in data units, dirs: [[yawDeg, color]] short arrows from the point (equal-axis charts only) }
function drawCursor(c) {
    const o = c.$cursor, dpr = window.devicePixelRatio || 1;
    const w = Math.round(c.width * dpr), h = Math.round(c.height * dpr);
    if (o.width !== w || o.height !== h) { o.width = w; o.height = h; }
    const ctx = o.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    const m = rows[current] && c.chartArea && c.$mark(rows[current]);
    if (!m) return;
    const X = v => c.scales.x.getPixelForValue(v), Y = v => c.scales.y.getPixelForValue(v);
    const { left, top, right, bottom } = c.chartArea;
    const stroke = (x0, y0, x1, y1, color, dash = []) => {
        ctx.strokeStyle = color; ctx.setLineDash(dash);
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    };
    ctx.save();
    ctx.beginPath(); ctx.rect(left, top, right - left, bottom - top); ctx.clip();
    ctx.lineWidth = 2;
    if (m.vline) stroke(X(m.x), top, X(m.x), bottom, 'rgba(255, 107, 107, 0.5)', [4, 4]);
    for (const [x0, y0, x1, y1, color] of m.rays ?? []) stroke(X(x0), Y(y0), X(x1), Y(y1), color);
    if (m.y !== null && m.y !== undefined) {
        const px = X(m.x), py = Y(m.y);
        for (const [deg, color] of m.dirs ?? []) {
            const a = deg * Math.PI / 180;
            stroke(px, py, px + Math.cos(a) * 28, py - Math.sin(a) * 28, color);
        }
        ctx.setLineDash([]); ctx.fillStyle = C.cursor; ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
}

// Same units per pixel on both axes (c.$bounds widened to the plot's aspect), so the path and
// the velocity keep their shapes. Margins come from the last layout.
function fitEqual(c, width = c.width, height = c.height) {
    const b = c.$bounds;
    if (!b) return;
    const [mx, my] = c.$margin ?? [60, 50];
    const w = Math.max(1, width - mx), h = Math.max(1, height - my);
    const upp = Math.max((b.maxX - b.minX) / w, (b.maxY - b.minY) / h, 1e-3) * 1.08;
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    Object.assign(c.options.scales.x, { min: cx - upp * w / 2, max: cx + upp * w / 2 });
    Object.assign(c.options.scales.y, { min: cy - upp * h / 2, max: cy + upp * h / 2 });
}

const line = (label, color, extra = {}) =>
    ({ label, data: [], borderColor: color, backgroundColor: color, borderWidth: 1.5, pointRadius: 0, ...extra });

function timeChart(id, datasets, yTitle, y, mark) {
    const c = new Chart($(id), {
        type: 'line',
        data: { datasets },
        options: {
            parsing: false, normalized: true, responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'nearest', axis: 'x', intersect: false },
            scales: { x: { type: 'linear', title: { display: true, text: 'Frame' } }, y: { title: { display: true, text: yTitle }, ...y } },
            plugins: { legend: { display: datasets.length > 1, labels: { boxHeight: 2 } } },
            onClick: (e, _, chart) => setFrame(Math.round(chart.scales.x.getValueForPixel(e.x)))
        },
        plugins: [cursor]
    });
    c.$mark = r => ({ x: r.i, y: mark(r), vline: true });
    return c;
}

function planeChart(id, dataset, xTitle, yTitle, mark) {
    const c = new Chart($(id), {
        type: 'scatter',
        data: { datasets: [dataset] },
        options: {
            parsing: false, responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'nearest', intersect: false },
            scales: { x: { title: { display: true, text: xTitle }, ticks: { includeBounds: false } },
                      y: { title: { display: true, text: yTitle }, ticks: { includeBounds: false } } },
            plugins: { legend: { display: false },
                       tooltip: { callbacks: { label: t => `frame ${t.dataIndex}: ${t.parsed.x.toFixed(0)}, ${t.parsed.y.toFixed(0)}` } } },
            onResize: (chart, size) => fitEqual(chart, size.width, size.height),
            onClick: (e, els) => { if (els.length) setFrame(els[0].index); }
        },
        plugins: [cursor]
    });
    c.$mark = mark;
    return c;
}

const yawDir = (r, len) => [Math.cos(r.yaw * Math.PI / 180) * len, Math.sin(r.yaw * Math.PI / 180) * len];

const charts = {
    speed: timeChart('speedChart', [line('Speed', C.speed, { fill: true, backgroundColor: 'rgba(79, 195, 247, 0.08)' })],
        'ups', { min: 0 }, r => r.speed),
    angle: timeChart('angleChart', [
        line('Wish ∠ velocity', C.angle),
        line('Best angle (CGaz)', C.opt),
        line('No accel below', C.min, { borderDash: [4, 4] })
    ], 'degrees', { min: 0, suggestedMax: 90 }, r => r.angle),
    eff: timeChart('effChart', [line('Efficiency', C.eff)], '%', { min: 0, max: 100 }, r => r.eff),
    path: planeChart('pathChart', line('Path', C.path, { showLine: true, borderWidth: 2 }), 'x', 'y',
        r => ({ x: r.x, y: r.y, dirs: [[r.yaw, C.view], ...(r.speed > 1 ? [[r.velYaw, C.vel]] : [])] })),
    velocity: planeChart('velocityChart', line('Velocity', C.vel, { showLine: true }), 'vx (ups)', 'vy (ups)',
        r => ({ x: r.vx, y: r.vy, rays: [[0, 0, r.vx, r.vy, C.vel], [0, 0, ...yawDir(r, Math.max(r.speed, 100)), C.view]] }))
};

function fillCharts() {
    const series = f => rows.map(r => ({ x: r.i, y: f(r) }));
    charts.speed.data.datasets[0].data = series(r => r.speed);
    const [angle, opt, min] = charts.angle.data.datasets;
    angle.data = series(r => r.angle); opt.data = series(r => r.opt); min.data = series(r => r.min);
    charts.eff.data.datasets[0].data = series(r => r.eff);
    for (const c of [charts.speed, charts.angle, charts.eff]) Object.assign(c.options.scales.x, { min: 0, max: Math.max(1, rows.length - 1) });

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, top = 100;
    for (const r of rows) {
        minX = Math.min(minX, r.x); maxX = Math.max(maxX, r.x);
        minY = Math.min(minY, r.y); maxY = Math.max(maxY, r.y);
        top = Math.max(top, r.speed);
    }
    charts.path.data.datasets[0].data = rows.map(r => ({ x: r.x, y: r.y }));
    charts.path.$bounds = { minX, maxX, minY, maxY };
    charts.velocity.data.datasets[0].data = rows.map(r => ({ x: r.vx, y: r.vy }));
    charts.velocity.$bounds = { minX: -top, maxX: top, minY: -top, maxY: top };   // centred on standing still

    for (const c of Object.values(charts)) { fitEqual(c); c.update(); }
}

// ─── Current frame: details, compass, keys ──────────────────────────────────
const sign = v => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
const deg = v => `${v.toFixed(1)}°`;
const rate = e => e === null ? '' : e >= 95 ? 'good' : e >= 70 ? 'warn' : 'bad';
const FIELDS = [
    ['Frame', r => `${r.i}`],
    ['Time', r => `${((r.i + 1) / FPS).toFixed(3)} s`],
    ['Position (Q3)', r => `${r.x.toFixed(1)}, ${r.y.toFixed(1)}, ${r.z.toFixed(1)}`],
    ['Velocity (Q3)', r => `${r.vx.toFixed(0)}, ${r.vy.toFixed(0)}`],
    ['Speed', r => `${r.speed.toFixed(1)} ups`],
    ['Speed change', r => r.gain === null ? '–' : `${sign(r.gain)} ups`],
    ['Move', r => r.mode ?? '–'],
    ['View yaw', r => deg(wrapDeg(r.yaw))],
    ['Velocity yaw', r => r.speed < 1 ? '–' : deg(r.velYaw)],
    ['Wish ∠ velocity', r => r.angle === null ? '–' : deg(r.angle)],
    ['Best angle (CGaz)', r => r.opt === null ? '–' : deg(r.opt)],
    ['No accel below', r => r.min === null ? '–' : deg(r.min)],
    ['Best speed', r => r.best === null ? '–' : `${r.best.toFixed(1)} ups`],
    ['Efficiency', r => r.eff !== null ? `${r.eff.toFixed(0)} %` : r.angle !== null && !r.match ? 'not modelled' : '–', r => rate(r.eff)]
];

const el = (tag, className, text) => Object.assign(document.createElement(tag), { className, textContent: text ?? '' });

// Built once; setFrame only rewrites the values
const detailCells = FIELDS.map(([name, value, cls]) => {
    const dd = el('dd');
    const box = el('div');
    box.append(el('dt', '', name), dd);
    $('frameDetails').append(box);
    return [dd, value, cls];
});

// Q3 yaw: 0° = +x to the right, 90° = +y up
function drawCompass(r) {
    const cv = $('compass'), dpr = window.devicePixelRatio || 1, S = 200, M = S / 2, R = 74;
    if (cv.width !== S * dpr) cv.width = cv.height = S * dpr;
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, S, S);
    ctx.strokeStyle = C.ring; ctx.lineWidth = 2; ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(M, M, R, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = C.text; ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let a = 0; a < 360; a += 30) {
        const t = a * Math.PI / 180, x = Math.cos(t), y = -Math.sin(t), k = a % 90 ? 6 : 12;
        ctx.beginPath(); ctx.moveTo(M + x * (R - k), M + y * (R - k)); ctx.lineTo(M + x * R, M + y * R); ctx.stroke();
        if (!(a % 90)) ctx.fillText(`${a}°`, M + x * (R + 13), M + y * (R + 10));   // outside the ring, clear of the needles
    }
    const needle = (yaw, color, len, dash = []) => {
        const t = yaw * Math.PI / 180;
        ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.setLineDash(dash);
        ctx.beginPath(); ctx.moveTo(M, M); ctx.lineTo(M + Math.cos(t) * len, M - Math.sin(t) * len); ctx.stroke();
    };
    if (r.wishYaw !== null) needle(r.wishYaw, C.wish, R - 30, [5, 4]);
    if (r.speed > 1) needle(r.velYaw, C.vel, R - 14);
    needle(r.yaw, C.view, R - 6);
    ctx.fillStyle = C.speed; ctx.beginPath(); ctx.arc(M, M, 4, 0, Math.PI * 2); ctx.fill();
}

function setFrame(i) {
    if (!rows.length) return;
    current = Math.max(0, Math.min(rows.length - 1, Number.isFinite(i) ? i : 0));
    const r = rows[current];
    $('frameSlider').value = current;
    $('frameDisplay').textContent = `${current} / ${rows.length - 1}`;
    for (const [dd, value, cls] of detailCells) { dd.textContent = value(r); dd.className = cls ? cls(r) : ''; }
    const k = r.keys;
    for (const [id, on] of [['keyW', k.f > 0], ['keyS', k.f < 0], ['keyA', k.s < 0], ['keyD', k.s > 0], ['keyJump', k.u > 0]])
        $(id).classList.toggle('on', on);
    drawCompass(r);
    for (const c of Object.values(charts)) drawCursor(c);
}

// ─── Run summary ────────────────────────────────────────────────────────────
const pct = v => v === null ? '–' : `${(v * 100).toFixed(0)} %`;

function showSummary(s) {
    const tiles = [
        ['Frames', s.frames],
        ['Duration', `${s.seconds.toFixed(3)} s`],
        ['Max speed', `${s.maxSpeed.toFixed(1)} ups`],
        ['Final speed', `${s.finalSpeed.toFixed(1)} ups`],
        ['Path length', `${s.path.toFixed(0)} units`],
        ['Jumps', s.jumps],
        ['On the ground', pct(s.groundShare)],
        ['Strafe efficiency', s.efficiency === null ? '–' : `${s.efficiency.toFixed(1)} %`,
            'Average over the frames the one-frame Pmove model reproduces'],
        ['At the best yaw', pct(s.atBest), "Rated frames whose speed equals the best yaw short's"],
        ['Modelled', pct(s.modelled),
            'Frames with move keys that the one-frame model reproduces exactly. Low: walls, slopes, jump pads, the wrong Physics, or a run without the Pmove velocity']
    ];
    $('summary').replaceChildren(...tiles.map(([name, value, title]) => {
        const t = el('div', 'tile');
        if (title) t.title = title;
        t.append(el('div', 'label', name), el('div', 'value', String(value)));
        return t;
    }));
    $('effNote').textContent = s.modelled ? '' :
        'No frame could be rated: that needs a run from the 3D viewer (it carries the Pmove velocity) and the Physics it was made with.';
}

// ─── Loading ────────────────────────────────────────────────────────────────
function setStatus(message, type = '') {
    $('status').textContent = message;
    $('status').className = `status ${type}`;
}

function analyse() {
    const physics = $('physics').value;
    rows = analyseRun(frames, physics === 'cpm');
    showSummary(summarise(rows));
    fillCharts();
    setStatus(`${label}: ${rows.length} frames, ${physics.toUpperCase()}`, 'ok');
}

// frames: viewer frames (run-analysis.js); physics: 'vq3' | 'cpm', or keep the selector's
function showRun(newFrames, name, physics) {
    if (!Array.isArray(newFrames) || !newFrames.length) { setStatus(`${name}: no frames`, 'error'); return; }
    pause();
    frames = newFrames; label = name;
    if (physics) $('physics').value = physics;
    $('empty').hidden = true; $('dashboard').hidden = false; $('playbar').hidden = false;   // visible before the charts size
    $('btn3DView').disabled = $('btnExportJSON').disabled = false;
    $('frameSlider').max = frames.length - 1;
    analyse();
    setFrame(0);
}

async function loadDemos() {
    try {
        const res = await fetch('/demos');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const demos = await res.json();
        $('demoList').replaceChildren(el('option', '', 'Saved runs…'), ...demos.map(d => Object.assign(el('option', '', d), { value: d })));
        $('demoList').firstChild.value = '';
        if (!frames.length) setStatus(`${demos.length} saved run${demos.length === 1 ? '' : 's'}`, 'ok');
    } catch (err) {
        setStatus('Could not list the saved runs', 'error');
        console.error('Listing saved runs:', err);
    }
}

// A saved run: wwwroot/demos/<fileName>, a JSON array of frames
async function loadDemo(fileName) {
    if (!fileName) return;
    try {
        setStatus('Loading run…', 'loading');
        const res = await fetch(`/demos/${encodeURIComponent(fileName)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showRun(await res.json(), fileName);
    } catch (err) {
        setStatus('Could not load that run', 'error');
        console.error('Loading run:', err);
    }
}

// The run the 3D viewer's Stats button handed over
function loadViewerRun() {
    let run = null;
    try { run = JSON.parse(localStorage.getItem('q3StatsRun')); } catch { /* unreadable */ }
    if (!run?.frames?.length) { setStatus('No run from the viewer yet: press 📊 Stats in the 3D viewer', 'error'); return; }
    showRun(run.frames, run.name || 'viewer run', run.physics);
}

// ─── Playback: real time, 125 frames per second × speed ─────────────────────
function play() {
    if (playing || !rows.length) return;
    if (current >= rows.length - 1) setFrame(0);
    playing = true;
    $('btnPlay').textContent = '⏸';
    let last = performance.now(), due = 0;
    const tick = now => {
        if (!playing) return;
        due += Math.min(now - last, 250) * FPS / 1000 * parseFloat($('playbackSpeed').value);   // cap a stalled tab's catch-up
        last = now;
        const step = Math.floor(due);
        if (step) {
            due -= step;
            setFrame(current + step);
            if (current >= rows.length - 1) { pause(); return; }
        }
        raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
}

function pause() {
    playing = false;
    cancelAnimationFrame(raf);
    $('btnPlay').textContent = '▶';
}

// ─── Wiring ─────────────────────────────────────────────────────────────────
$('demoList').addEventListener('change', e => loadDemo(e.target.value));
$('btnRefresh').addEventListener('click', loadDemos);
$('btnViewerRun').addEventListener('click', loadViewerRun);
$('physics').addEventListener('change', () => { if (frames.length) { analyse(); setFrame(current); } });

// 3D View: the viewer picks these frames up once a map is loaded
$('btn3DView').addEventListener('click', () => {
    try { localStorage.setItem('q3DemoData', JSON.stringify(frames)); }
    catch { setStatus('Run too large to hand to the viewer', 'error'); return; }
    window.open('html/viewer3d-v2.html', '_blank');
});

$('btnExportJSON').addEventListener('click', () => {
    const a = el('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(frames, null, 2)], { type: 'application/json' }));
    a.download = `${label.replace(/\.json$/i, '').replace(/[^\w-]+/g, '_') || 'run'}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('frameSlider').addEventListener('input', e => setFrame(+e.target.value));
$('btnFirst').addEventListener('click', () => setFrame(0));
$('btnPrev').addEventListener('click', () => setFrame(current - 1));
$('btnPlay').addEventListener('click', () => (playing ? pause() : play()));
$('btnNext').addEventListener('click', () => setFrame(current + 1));
$('btnLast').addEventListener('click', () => setFrame(rows.length - 1));

document.addEventListener('keydown', e => {
    if (!rows.length || e.target.matches('select, input')) return;   // those handle their own keys
    const keys = { ArrowLeft: () => setFrame(current - 1), ArrowRight: () => setFrame(current + 1),
                   ' ': () => (playing ? pause() : play()), Home: () => setFrame(0), End: () => setFrame(rows.length - 1) };
    if (!keys[e.key]) return;
    e.preventDefault();
    if (e.target.matches('button')) e.target.blur();   // or Space would also click the focused button
    keys[e.key]();
});

// Opened from the 3D viewer's Stats button (?run=viewer): show that run
loadDemos();
if (new URLSearchParams(location.search).get('run') === 'viewer') loadViewerRun();
