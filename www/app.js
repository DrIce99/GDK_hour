const $ = (id) => document.getElementById(id);
let GlyphClock = null;

let currentPage = 1;
let pointerStartX = 0;
let pointerStartY = 0;
let isSwiping = false;
let isPointerDown = false;

const btnToggle = document.getElementById('btnToggle');
const page1 = document.getElementById('page1');
const nothingArrow = document.getElementById('nothingArrow');

async function initPlugin() {
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.GlyphClock) {
        GlyphClock = window.Capacitor.Plugins.GlyphClock;
        return;
    }
    try {
        const { registerPlugin } = await import('@capacitor/core');
        GlyphClock = registerPlugin('GlyphClock');
    } catch (e) {
        GlyphClock = null;
    }
}

function setupPathLengths() {
    document.querySelectorAll('.glyph-svg path, .miyabi-svg path').forEach((path) => {
        const len = Math.ceil(path.getTotalLength());
        path.style.setProperty('--len', len);
    });
}

// --- CARICAMENTO SVG "BANYUE" E ANELLO DI SFONDO (PAGINA 2) ---

async function fetchSvgElement(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(`Impossibile caricare ${path} (${res.status})`);
    const text = await res.text();
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const svg = doc.documentElement;
    if (!svg || svg.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) {
        throw new Error(`SVG non valido: ${path}`);
    }
    return svg;
}

async function setupBanyuePage() {
    const container = $('banyueContainer');
    const ring = $('bgRing');
    if (!container || !ring) return;

    try {
        const banyueSvg = await fetchSvgElement('banyue.svg');
        banyueSvg.classList.add('glyph-svg', 'banyue-svg');
        banyueSvg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        container.appendChild(banyueSvg);

        banyueSvg.querySelectorAll('path').forEach((path, i) => {
            path.style.transitionDelay = `${(i % 60) * 0.006}s`;
        });

        setupPathLengths();

        const ballTemplate = await fetchSvgElement('banyueball.svg');
        ballTemplate.removeAttribute('width');
        ballTemplate.removeAttribute('height');

        for (let i = 0; i < 8; i++) {
            const wrapper = document.createElement('div');
            wrapper.className = 'bg-element';
            wrapper.appendChild(ballTemplate.cloneNode(true));
            ring.appendChild(wrapper);
        }
    } catch (e) {
        console.error('Errore caricamento SVG Banyue/anello:', e);
    }
}

// --- PAGINA 3: MIYABI (TIMER) ---
// La katana è sguainata a inizio timer e Miyabi la rinfodera in proporzione al tempo
// rimanente (percentuale, non assoluto). miyabi.svg è ricalcato dal fotogramma del
// wallpaper (stato finale, rinfoderata); il gruppo #miyabiSword (mano destra, elsa,
// lama) viene traslato di (data-draw-x, data-draw-y) * frazione sguainata.

const MIYABI_DEFAULT_MS = 60 * 1000;
const MIYABI_MAX_MS = 99 * 60 * 1000;

const miyabi = {
    svg: null,
    sword: null,
    drawX: 0,
    drawY: 0,
    applied: -1,   // ultima frazione applicata al DOM
    durationMs: MIYABI_DEFAULT_MS,
    remainingMs: MIYABI_DEFAULT_MS,
    endAt: 0,
    state: 'idle', // idle | running | paused | done
    shown: 1,      // frazione sguainata visualizzata (insegue quella reale)
    raf: 0,
    doneTimeout: 0,
    digitsText: '',
    digitCells: [],
};

// Font 5x7 per il display a punti
const DOT_FONT = {
    '0': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
    '3': ['01110', '10001', '00001', '00110', '00001', '10001', '01110'],
    '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
    '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
    '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
    '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
    '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
    '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
    ':': ['0', '0', '1', '0', '1', '0', '0'],
};

const MIYABI_ICONS = {
    minus: '<path d="M5 12h14"/>',
    plus: '<path d="M5 12h14M12 5v14"/>',
    start: '<path d="M8 5l11 7-11 7z"/>',
    pause: '<path d="M9 5v14M15 5v14"/>',
    reset: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/>',
};

function buildDotDisplay(svg) {
    const NS = 'http://www.w3.org/2000/svg';
    const PITCH = 10;
    // MM:SS -> 5 + 1 + 5 + 1 + 1 + 1 + 5 + 1 + 5 = 25 colonne
    const widths = [5, 5, 1, 5, 5];
    let col = 0;
    miyabi.digitCells = widths.map((w) => {
        const cells = [];
        for (let r = 0; r < 7; r++) {
            const row = [];
            for (let c = 0; c < w; c++) {
                const dot = document.createElementNS(NS, 'circle');
                dot.setAttribute('cx', (col + c) * PITCH + PITCH / 2);
                dot.setAttribute('cy', r * PITCH + PITCH / 2);
                dot.setAttribute('r', 3.4);
                svg.appendChild(dot);
                row.push(dot);
            }
            cells.push(row);
        }
        col += w + 1;
        return cells;
    });
    svg.setAttribute('viewBox', `0 0 ${(col - 1) * PITCH} ${7 * PITCH}`);
}

function miyabiRemaining() {
    if (miyabi.state === 'running') return Math.max(0, miyabi.endAt - Date.now());
    return miyabi.remainingMs;
}

function renderMiyabiDigits() {
    const totalSec = Math.ceil(miyabiRemaining() / 1000);
    const text = `${String(Math.floor(totalSec / 60)).padStart(2, '0')}:${String(totalSec % 60).padStart(2, '0')}`;
    if (text === miyabi.digitsText) return;
    miyabi.digitsText = text;
    [...text].forEach((ch, i) => {
        const glyph = DOT_FONT[ch];
        miyabi.digitCells[i].forEach((row, r) => row.forEach((dot, c) => {
            dot.classList.toggle('on', glyph[r][c] === '1');
        }));
    });
}

function renderMiyabiControls() {
    const { state } = miyabi;
    const slots = {
        left: state === 'idle' ? 'minus' : 'reset',
        center: state === 'running' ? 'pause' : 'start',
        right: state === 'idle' ? 'plus' : null,
    };
    $('miyabiControls').querySelectorAll('[data-slot]').forEach((ctl) => {
        const action = slots[ctl.dataset.slot];
        ctl.classList.toggle('hidden', !action);
        if (!action || ctl.dataset.action === action) return;
        ctl.dataset.action = action;
        ctl.innerHTML = `<svg viewBox="0 0 24 24">${MIYABI_ICONS[action]}</svg>`;
    });
    $('miyabiDigits').classList.toggle('done', state === 'done');
}

function applyKatana(fraction) {
    if (!miyabi.sword) return;
    // Sotto ~0.3 unità di spostamento non vale la pena ridisegnare la scena
    const dist = Math.hypot(miyabi.drawX, miyabi.drawY);
    if (Math.abs(fraction - miyabi.applied) * dist < 0.3 && fraction !== 0 && fraction !== 1) return;
    miyabi.applied = fraction;
    const x = (miyabi.drawX * fraction).toFixed(2);
    const y = (miyabi.drawY * fraction).toFixed(2);
    miyabi.sword.setAttribute('transform', `translate(${x} ${y})`);
}

function miyabiFrame() {
    miyabi.raf = 0;
    if (miyabi.state === 'running' && miyabiRemaining() <= 0) finishMiyabiTimer();

    const target = miyabi.durationMs > 0 ? miyabiRemaining() / miyabi.durationMs : 0;
    const diff = target - miyabi.shown;
    // Mentre il timer scorre segue il valore reale; i salti (reset, +/-) vengono smorzati
    miyabi.shown = Math.abs(diff) < 0.001 ? target : miyabi.shown + diff * 0.12;
    applyKatana(miyabi.shown);
    renderMiyabiDigits();

    if (currentPage === 3 && (miyabi.state === 'running' || miyabi.shown !== target)) {
        kickMiyabi();
    }
}

function kickMiyabi() {
    if (!miyabi.raf) miyabi.raf = requestAnimationFrame(miyabiFrame);
}

function playMiyabiSlash() {
    const slash = $('miyabiSlash');
    slash.classList.remove('slashing');
    void slash.offsetWidth; // riavvia l'animazione
    slash.classList.add('slashing');
}

function finishMiyabiTimer() {
    clearTimeout(miyabi.doneTimeout);
    miyabi.state = 'done';
    miyabi.remainingMs = 0;
    if (navigator.vibrate) navigator.vibrate([40, 60, 120]);
    if (currentPage === 3) playMiyabiSlash();
    renderMiyabiControls();
    renderMiyabiDigits();
    kickMiyabi();
}

function startMiyabiTimer() {
    if (miyabi.state === 'done') miyabi.remainingMs = miyabi.durationMs;
    miyabi.state = 'running';
    miyabi.endAt = Date.now() + miyabi.remainingMs;
    clearTimeout(miyabi.doneTimeout);
    // Rileva la fine anche quando la pagina Miyabi non è visibile
    miyabi.doneTimeout = setTimeout(() => {
        if (miyabi.state === 'running') finishMiyabiTimer();
    }, miyabi.remainingMs);
}

function pauseMiyabiTimer() {
    miyabi.remainingMs = miyabiRemaining();
    miyabi.state = 'paused';
    clearTimeout(miyabi.doneTimeout);
}

function resetMiyabiTimer() {
    miyabi.state = 'idle';
    miyabi.remainingMs = miyabi.durationMs;
    clearTimeout(miyabi.doneTimeout);
}

// Passi da 15 s sotto il minuto, da 1 min oltre
function stepMiyabiDuration(dir) {
    const ms = miyabi.durationMs;
    const next = dir > 0
        ? (ms < 60000 ? ms + 15000 : ms + 60000)
        : (ms <= 60000 ? ms - 15000 : ms - 60000);
    miyabi.durationMs = Math.min(MIYABI_MAX_MS, Math.max(15000, next));
    miyabi.remainingMs = miyabi.durationMs;
}

function onMiyabiControl(e) {
    // Il click non deve arrivare al toggle del servizio
    e.stopPropagation();
    if (isSwiping) {
        isSwiping = false;
        return;
    }
    const ctl = e.target.closest('[data-action]');
    if (!ctl || ctl.classList.contains('hidden')) return;

    switch (ctl.dataset.action) {
        case 'minus': stepMiyabiDuration(-1); break;
        case 'plus': stepMiyabiDuration(1); break;
        case 'start': startMiyabiTimer(); break;
        case 'pause': pauseMiyabiTimer(); break;
        case 'reset': resetMiyabiTimer(); break;
    }
    renderMiyabiControls();
    kickMiyabi();
}

function setupMiyabiFrost() {
    const frost = $('miyabiFrost');
    for (let i = 0; i < 14; i++) {
        const flake = document.createElement('span');
        flake.className = 'frost';
        flake.style.setProperty('--x', `${Math.random() * 100}%`);
        flake.style.setProperty('--size', `${1.5 + Math.random() * 2.5}px`);
        flake.style.setProperty('--dur', `${9 + Math.random() * 9}s`);
        flake.style.setProperty('--delay', `${-Math.random() * 18}s`);
        flake.style.setProperty('--drift', `${(Math.random() - 0.5) * 60}px`);
        frost.appendChild(flake);
    }
}

async function setupMiyabiPage() {
    const container = $('miyabiContainer');
    if (!container) return;

    buildDotDisplay($('miyabiDigits'));
    setupMiyabiFrost();
    $('miyabiControls').addEventListener('click', onMiyabiControl);
    renderMiyabiControls();
    renderMiyabiDigits();

    try {
        const svg = await fetchSvgElement('miyabi.svg');
        svg.classList.add('miyabi-svg');
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        container.appendChild(svg);

        svg.querySelectorAll('path').forEach((path, i) => {
            path.style.transitionDelay = `${(i % 60) * 0.006}s`;
        });

        miyabi.svg = svg;
        miyabi.sword = svg.querySelector('#miyabiSword');
        miyabi.drawX = parseFloat(svg.getAttribute('data-draw-x')) || 0;
        miyabi.drawY = parseFloat(svg.getAttribute('data-draw-y')) || 0;

        setupPathLengths();
        applyKatana(miyabi.shown);
    } catch (e) {
        console.error('Errore caricamento SVG Miyabi:', e);
    }
}

function triggerMiyabiPageEntrance() {
    const page3 = $('page3');
    page3.classList.remove('exit-down');
    page3.classList.add('active-page');

    // Posizione della katana subito coerente con il timer, poi effetto disegno
    miyabi.shown = miyabi.durationMs > 0 ? miyabiRemaining() / miyabi.durationMs : 0;
    applyKatana(miyabi.shown);
    renderMiyabiControls();
    kickMiyabi();

    if (miyabi.svg) {
        miyabi.svg.classList.remove('drawn');
        setTimeout(() => {
            if (currentPage === 3) miyabi.svg.classList.add('drawn');
        }, 350);
    }
}

function leaveMiyabiPage(downwards) {
    const page3 = $('page3');
    page3.classList.remove('active-page');
    if (miyabi.svg) miyabi.svg.classList.remove('drawn');
    if (!downwards) return;

    page3.classList.add('exit-down');
    setTimeout(() => {
        if (currentPage !== 3) page3.classList.remove('exit-down');
    }, 850);
}

async function refresh() {
    if (!GlyphClock) return;
    try {
        const s = await GlyphClock.getStatus();
        const btn = $('btnToggle');
        
        if (s.running) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    } catch (e) {
        console.error('Errore getStatus:', e);
    }
}

async function toggleService() {
    // Il toggle è disabilitato fuori dalla Pagina 1
    if (currentPage !== 1) return;

    if (!GlyphClock) {
        // Fallback visivo per il test da PC
        $('btnToggle').classList.toggle('active');
        return;
    }
    try {
        const s = await GlyphClock.getStatus();
        if (s.running) {
            await GlyphClock.stopBackgroundClock();
        } else {
            await GlyphClock.startBackgroundClock({ blinkPeriodMs: 500 });
        }
    } catch (e) {
        console.error('Errore toggle:', e);
    }
    setTimeout(refresh, 150);
}

// --- NAVIGATION: FRECCETTE TASTIERA + MOUSE/TOUCH POINTERS ---
function setupNavigation() {
    const btn = $('btnToggle');

    // 1. CAMBIO PAGINA DA TASTIERA (FRECCETTA SU / FRECCETTA GIÙ / PAGINA)
    document.addEventListener('keydown', (e) => {
        if (!btn.classList.contains('active')) return;

        if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(e.key)) {
            e.preventDefault();
            if (currentPage === 1) {
                switchToPage2();
            } else {
                switchToPage1();
            }
        }
        // FRECCETTE SINISTRA / DESTRA: Banyue <-> Miyabi
        else if (e.key === 'ArrowRight' && currentPage === 2) {
            e.preventDefault();
            switchToPage3();
        } else if (e.key === 'ArrowLeft' && currentPage === 3) {
            e.preventDefault();
            switchToPage2();
        }
    });

    // 2. SWIPE VIA POINTER EVENTS (DESKTOP MOUSE + TOUCH)
    btn.addEventListener('pointerdown', (e) => {
        pointerStartX = e.clientX;
        pointerStartY = e.clientY;
        isSwiping = false;
        isPointerDown = true;
        // Niente capture sui controlli del timer: altrimenti il click verrebbe
        // reindirizzato al bottone e non arriverebbe al controllo
        if (e.target.closest('.miyabi-ctl')) return;
        try {
            btn.setPointerCapture(e.pointerId); // Mantiene il tracciamento del mouse anche fuoribordo
        } catch (err) {}
    });

    btn.addEventListener('pointerup', (e) => {
        if (!isPointerDown) return;
        isPointerDown = false;

        const deltaX = e.clientX - pointerStartX;
        const deltaY = e.clientY - pointerStartY;
        const horizontal = Math.abs(deltaX) > Math.abs(deltaY);

        // Se lo spostamento supera i 50px
        if (Math.max(Math.abs(deltaX), Math.abs(deltaY)) > 50) {
            isSwiping = true;

            if (btn.classList.contains('active')) {
                if (horizontal) {
                    // SWIPE VERSO SINISTRA: da Banyue a Miyabi
                    if (deltaX < 0 && currentPage === 2) {
                        switchToPage3();
                    }
                    // SWIPE VERSO DESTRA: da Miyabi a Banyue
                    else if (deltaX > 0 && currentPage === 3) {
                        switchToPage2();
                    }
                }
                // SWIPE VERSO L'ALTO (deltaY negativo): da Pagina 1 a Pagina 2
                else if (deltaY < 0 && currentPage === 1) {
                    switchToPage2();
                }
                // SWIPE VERSO IL BASSO (deltaY positivo): da Pagina 2/3 a Pagina 1
                else if (deltaY > 0 && currentPage !== 1) {
                    switchToPage1();
                }
            }
        }
    });

    btn.addEventListener('pointercancel', () => {
        isPointerDown = false;
    });
}

function switchToPage2() {
    const from = currentPage;
    currentPage = 2;
    const page1 = $('page1');
    const page2 = $('page2');
    const arrow = $('nothingArrow');

    // Rientro laterale da Miyabi: Banyue è già disegnata, basta farla scorrere
    if (from === 3) {
        page2.classList.remove('side-exit');
        leaveMiyabiPage(false);
        return;
    }

    page1.classList.add('exit');
    page2.classList.add('active-page');
    arrow.classList.add('in-banyue');

    // Avvia la sequenza d'entrata e il successivo disegno dell'SVG
    triggerBanyuePageEntrance();
}

function switchToPage1() {
    const from = currentPage;
    currentPage = 1;
    const page1 = $('page1');
    const page2 = $('page2');
    const arrow = $('nothingArrow');

    page1.classList.remove('exit');
    page2.classList.remove('active-page', 'side-exit');
    arrow.classList.remove('in-banyue');
    if (from === 3) leaveMiyabiPage(true);

    // Reset dell'effetto disegno per consentire la riesecuzione al prossimo swipe
    const banyueSvg = page2.querySelector('.banyue-svg');
    if (banyueSvg) banyueSvg.classList.remove('drawn');
}

function switchToPage3() {
    currentPage = 3;
    $('page2').classList.add('side-exit');
    triggerMiyabiPageEntrance();
}

async function main() {
    setupPathLengths();
    setupNavigation();
    await initPlugin();
    setupBanyuePage();
    setupMiyabiPage();

    const btn = $('btnToggle');
    btn.addEventListener('click', () => {
        // Ignora il click se è stato eseguito uno swipe
        if (isSwiping) {
            isSwiping = false;
            return;
        }
        toggleService();
    });

    refresh();
    setInterval(refresh, 1000);
}

function triggerBanyuePageEntrance() {
    const page2 = document.getElementById('page2');
    const banyueSvg = document.querySelector('.banyue-svg');

    // 1. Reset degli stati
    page2.classList.remove('entry-complete');
    page2.classList.add('active-page', 'entry-animating');
    if (banyueSvg) banyueSvg.classList.remove('drawn');

    // 2. Tempo totale movimento palline: (7 * 0.09s) + 1.3s = ~1.93s
    const totalEntryDuration = 1950; 

    setTimeout(() => {
        // 3. Attiva la maschera, la visibilità (opacity: 1) e la rotazione continua
        page2.classList.remove('entry-animating');
        page2.classList.add('entry-complete');

        // 4. Avvia l'effetto disegno SOLO ORA che l'SVG è visibile
        if (banyueSvg) {
            banyueSvg.classList.add('drawn');
        }
    }, totalEntryDuration);
}

document.addEventListener('DOMContentLoaded', main);
window.addEventListener('focus', refresh);