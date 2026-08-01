// Only used when the page is opened straight from disk (file://) during development;
// served from the device, baseUrl stays relative. Defaults to the fallback access point
// so no one's LAN address ships in the published firmware.
var hst = '192.168.4.1';
var DBG = false; // UI debug logging (requests, heap); never logs secrets

var _rooms = [];
// TX repeat frames sent after the first one. RTS is one-way: nothing tells us the motor
// heard the command, so the only defence against a lost frame is to send it again. One
// repeat leaves a single retry and misses show up as a shade that "sometimes" ignores an
// order, so 2 is the floor the UI defaults to and the RF advice never goes below.
const MIN_REPEATS = 2;
const DEFAULT_REPEATS = 2;
let LANG = {};
// Reverse-proxy support: when the UI is served under a sub-path (e.g.
// https://ha.local/espsomfy/), every API path must carry that prefix. Served
// from the device root, basePath resolves to '' and requests are unchanged.
var basePath = window.location.protocol === 'file:' ? '' : window.location.pathname.replace(/\/[^/]*$/, '');
var baseUrl = window.location.protocol === 'file:' ? `http://${hst}` : basePath;
var waitLoad;
var mouseDown = false;
// Global press tracking: the hold-to-repeat loops (virtual remote, Prog buttons)
// test `mouseDown`; tracking it at the document level guarantees a release —
// even off the button or on touch — always stops the radio repeat.
document.addEventListener('mousedown', () => { mouseDown = true; }, true);
document.addEventListener('mouseup', () => { mouseDown = false; }, true);
document.addEventListener('touchstart', () => { mouseDown = true; }, { capture: true, passive: true });
document.addEventListener('touchend', () => { mouseDown = false; }, true);
document.addEventListener('touchcancel', () => { mouseDown = false; }, true);
const get = id => document.getElementById(id);
// Hold a number field inside its own min/max. type="number" only constrains its spinner:
// typed and pasted values go through untouched, so without this the device receives
// whatever was in the box. An emptied field falls back to `dflt` rather than to the
// minimum, because for most of these settings the minimum is a meaningful value someone
// did not choose.
function clampNumField(el, dflt) {
    if (!el) return;
    const num = el.getAttribute('data-datatype') === 'float'
        ? (s) => parseFloat(s)
        : (s) => parseInt(s, 10);
    const min = num(el.min);
    const max = num(el.max);
    let v = num(el.value);
    if (isNaN(v)) v = typeof dflt === 'number' ? dflt : (isNaN(min) ? 0 : min);
    if (!isNaN(min)) v = Math.max(min, v);
    if (!isNaN(max)) v = Math.min(max, v);
    el.value = v;
    return v;
}
// Escape device-/user-controlled strings for safe use in HTML text and quoted attributes (XSS).
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
// Attribute bundle that turns a generated <div> control into a real button for the
// keyboard and for screen readers. Kept as one helper so no command control can be
// shipped focusable-but-unnamed; the delegated keydown handler below does the activation.
// The label is escaped because it embeds user-supplied device names.
function a11yBtn(label) { return `role="button" tabindex="0" aria-label="${esc(label)}"`; }
// Same idea for elements that only become clickable in certain states: the affordance has
// to be added and removed alongside the onclick handler, or the keyboard is left with a
// focus stop that does nothing. No aria-label: these carry their own visible text.
function setClickable(el, on) {
    if (!el) return;
    if (on) {
        el.setAttribute('role', 'button');
        el.setAttribute('tabindex', '0');
    } else {
        el.removeAttribute('role');
        el.removeAttribute('tabindex');
    }
}
// Whitelist URL schemes for generated markdown links: allow http(s), protocol-relative and
// relative/anchor URLs; block javascript:, data:, vbscript: and any other explicit scheme.
function safeUrl(u) {
    const s = String(u == null ? '' : u).trim();
    if (/^(https?:)?\/\//i.test(s)) return s;   // http(s):// or //host
    if (/^(\/|\.|#|\?)/.test(s)) return s;       // relative path or anchor/query
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return ''; // any other explicit scheme -> reject
    return s;                                     // schemeless relative (e.g. "path/x")
}

// --- Modal dialogs -----------------------------------------------------------
// Overlays were plain <div>s: screen readers never announced them, Tab wandered off into
// the page behind, and closing one dropped focus back on <body>, so keyboard users
// restarted from the top of the document every time. openDialog/closeDialog wrap every
// overlay creation path so the semantics, the focus trap and the focus restore are
// defined in exactly one place.
const DLG_FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[role="button"]:not([disabled]),[tabindex]:not([tabindex="-1"])';
let _dlgStack = [];
let _dlgSeq = 0;
// True when the element is actually rendered. getClientRects is used rather than
// offsetParent, which is null for position:fixed controls even while they are visible.
function dlgVisible(n) { return !!n && n.getClientRects().length > 0; }
function dlgFocusables(el) {
    // Skips the display:none branches these overlays are full of (wizard steps,
    // expert-only rows) so Tab never lands on an invisible control.
    return Array.prototype.filter.call(el.querySelectorAll(DLG_FOCUSABLE), dlgVisible);
}
function openDialog(el) {
    if (!el || el.hasAttribute('data-dialog')) return;
    el.setAttribute('data-dialog', '');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    // Name the dialog from whatever heading it already shows, rather than inventing a label
    // that would not match what is on screen.
    const title = el.querySelector('h1,h2,h3,.prompt-text,.info-text,.inner-error,.wait-label');
    if (title) {
        if (!title.id) title.id = `dlgTitle${++_dlgSeq}`;
        el.setAttribute('aria-labelledby', title.id);
    }
    const opener = document.activeElement;
    _dlgStack.push({ el: el, opener: (opener && opener !== document.body) ? opener : null });
    const first = dlgFocusables(el)[0];
    if (first) first.focus();
    else {
        if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
        el.focus();
    }
}
function closeDialog(el) {
    if (!el) return;
    const i = _dlgStack.findIndex((d) => d.el === el);
    if (i < 0) return;
    const entry = _dlgStack[i];
    _dlgStack.splice(i, 1);
    el.removeAttribute('data-dialog');
    // Only give focus back if the trigger is still on the page and still reachable.
    if (entry.opener && document.body.contains(entry.opener) && dlgVisible(entry.opener)) {
        entry.opener.focus();
    }
}
// Tab cycling for the topmost dialog. One document-level listener keeps working even when
// focus has escaped the overlay (a background click), which a listener bound to the
// overlay itself would not.
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab' || _dlgStack.length === 0) return;
    const top = _dlgStack[_dlgStack.length - 1];
    if (!document.body.contains(top.el)) { closeDialog(top.el); return; }
    const f = dlgFocusables(top.el);
    if (f.length === 0) {
        e.preventDefault();
        if (!top.el.hasAttribute('tabindex')) top.el.setAttribute('tabindex', '-1');
        top.el.focus();
        return;
    }
    const first = f[0], last = f[f.length - 1];
    if (!top.el.contains(document.activeElement)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
    } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
    }
});
const closeOverlay = (div, callback) => {
    if (!div) return;
    if (typeof callback === 'function') callback();
    closeDialog(div);
    div.classList.add('overlay-exit');
    setTimeout(() => div.remove(), 300);
};
// NOTE: `ui` is declared with `var` in 10-shell.js.  If it ever becomes `const`
// or `let`, any reference to it from this earlier chunk would throw a TDZ
// ReferenceError in the concatenated production build.  A dead startup block
// that read `ui.waitMessage` here relied on exactly that hoisting and was
// removed; keep early chunks free of `ui` references.
window.tr = function(id) {
    return (LANG && LANG[id]) ? LANG[id] : id;
};
// Translate and fill the {0}, {1}… placeholders of a phrase. Accessible names have to
// embed the device name, and every language wants it in a different spot
// ("Open Living room" / "Ouvrir Salon" / "Wohnzimmer öffnen"), so the position lives in
// the translated string rather than in the code.
window.trf = function(id) {
    const args = Array.prototype.slice.call(arguments, 1);
    return tr(id).replace(/\{(\d+)\}/g, (m, i) => (typeof args[i] === 'undefined' ? m : String(args[i])));
};
const TR_SEL = '[tr],[tr-aria]';
const translator = {
    isInitialized: false,
    observer: null,

    translate(el) {
        // tr-aria feeds the accessible name of icon-only controls, which have no text to
        // translate; it is independent of tr so an element can carry both.
        const ariaKey = el.getAttribute('tr-aria');
        if (ariaKey) el.setAttribute('aria-label', tr(ariaKey));
        const key = el.getAttribute('tr');
        if (!key) return;

        const text = tr(key);
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            el.placeholder = text;
        } else if (el.hasAttribute('title')) {
            el.title = text;
        } else {
            el.textContent = text;
        }
    },
    init() {
        document.querySelectorAll(TR_SEL).forEach(el => this.translate(el));
        if (this.isInitialized) return;

        // Scoped to the container instead of <body>: everything generated at runtime
        // (panels, overlays, toasts) lands there, while the topbar and the sidebar are
        // static and already covered by the pass above. Watching the whole body meant
        // re-scanning every inserted subtree on each socket-driven position update, for
        // the lifetime of the page.
        const root = get('divContainer') || document.body;
        this.observer = new MutationObserver((mutations) => {
            mutations.forEach(m => m.addedNodes.forEach(node => {
                if (node.nodeType === 1) {
                    if (node.hasAttribute('tr') || node.hasAttribute('tr-aria')) this.translate(node);
                    node.querySelectorAll(TR_SEL).forEach(el => this.translate(el));
                }
            }));
        });
        this.observer.observe(root, { childList: true, subtree: true });
        this.isInitialized = true;
    }
};
// Enter/Space activation for every control that carries role="button" without being a
// native one. A single delegated listener covers the whole app, including markup that is
// regenerated on each socket update, so no control can be shipped focusable-but-dead.
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    // Native buttons fire once per press; a held key must not spam the command
    // (e.g. repeated shade UP frames), so ignore auto-repeat keydowns.
    if (e.repeat) return;
    const t = e.target;
    if (!t || typeof t.closest !== 'function') return;
    // Never swallow a space typed into a field.
    if (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return;
    const btn = t.closest('[role="button"]');
    if (!btn || btn.hasAttribute('disabled') || btn.classList.contains('disabled')) return;
    // Natively activatable elements already do this themselves.
    if (btn.tagName === 'BUTTON' || (btn.tagName === 'A' && btn.hasAttribute('href'))) return;
    e.preventDefault();
    btn.click();
});
// Normalise a shade's stored position into "openness": 0 = closed, 100 = open.
// The firmware stores position as "% open" when flipPosition is set and "% closed"
// when it is not (see the positioner label that reads "% open" vs "% closed"), so the
// same physical state is stored as 0 on one shade and 100 on another. This collapses
// both conventions to a single open-percentage used consistently across the UI.
function shadeOpenness(position, flip) {
    return flip ? position : (100 - position);
}
// Show a shade's travel as Closed / Open at the extremes and the open-percentage between.
function shadePosLabel(position, flip) {
    const open = shadeOpenness(position, flip);
    if (open <= 0) return tr('POS_CLOSED');
    if (open >= 100) return tr('POS_OPEN');
    return open + '%';
}
function loadLang(callback) {
    if (Object.keys(LANG).length > 0) {
        if(DBG) console.log("Language already in memory, using the cache.");
        if (callback) callback();
        return;
    }
    // Versioned URL so the dictionary can be cached hard: 18KB re-fetched on
    // every single page load is the largest thing left that never changes.
    // The address carries both keys that decide its content - the firmware
    // build and the chosen language - so a change always misses the cache.
    const _lv = (document.querySelector('script[src*="index.js"]')?.getAttribute('src') || '').split('v=')[1] || '';
    const _ll = localStorage.getItem('selectedLang') || '';
    fetch(`${baseUrl}/lang?v=${encodeURIComponent(_lv)}&l=${encodeURIComponent(_ll)}`)
    .then(r => r.json())
    .then(dict => {
        LANG = dict;
        translator.init();
        finishLoad(callback);
    })
    .catch(err => {
        console.error("Language load failed, falling back to the built-in dictionary", err);
        LANG = { "BT_LOGIN": "Login", "HOME": "Maison" };
        translator.init();
        finishLoad(callback);
    });
}
function finishLoad(callback) {
    document.body.classList.add('lang-loaded');
    if (waitLoad && typeof waitLoad.remove === 'function') {
        waitLoad.remove();
    }
    if (callback) callback();
}
function displayUptime(totalSeconds, className) {
    const elements = document.querySelectorAll('.' + className);
    if (elements.length === 0 || isNaN(totalSeconds)) return;

    let seconds = parseInt(totalSeconds, 10);
    let days = Math.floor(seconds / (24 * 3600));
    seconds %= (24 * 3600);
    let hours = Math.floor(seconds / 3600);
    seconds %= 3600;
    let minutes = Math.floor(seconds / 60);

    const fH = hours.toString().padStart(2, '0');
    const fM = minutes.toString().padStart(2, '0');
    const timeString = `${days}${tr('DAY')} ${fH}${tr('HOUR')} ${fM}${tr('MIN')}`;

    elements.forEach(el => {
        el.textContent = timeString;
    });
}
var errors = [
    { code: -10, key: 'ERR_PIN_TRANSCEIVER' },
    { code: -11, key: 'ERR_PIN_ETHERNET' },
    { code: -12, key: 'ERR_PIN_MOTOR' },
    { code: -21, key: 'ERR_GIT_FLASH_WRITE' },
    { code: -22, key: 'ERR_GIT_FLASH_ERASE' },
    { code: -23, key: 'ERR_GIT_FLASH_READ' },
    { code: -24, key: 'ERR_GIT_SPACE' },
    { code: -25, key: 'ERR_GIT_FILE_SIZE' },
    { code: -26, key: 'ERR_GIT_TIMEOUT' },
    { code: -27, key: 'ERR_GIT_MD5' },
    { code: -28, key: 'ERR_GIT_MAGIC_BYTE' },
    { code: -29, key: 'ERR_GIT_ACTIVATE' },
    { code: -30, key: 'ERR_GIT_PARTITION' },
    { code: -31, key: 'ERR_GIT_ARGUMENT' },
    { code: -32, key: 'ERR_GIT_ABORTED' },
    { code: -40, key: 'ERR_GIT_HTTP' },
    { code: -41, key: 'ERR_GIT_BUFFER' },
    { code: -42, key: 'ERR_GIT_CONNECT' },
    { code: -43, key: 'ERR_GIT_DL_TIMEOUT' }
].map(err => {

    return {
        code: err.code,
        key: err.key,
        get desc() { return tr(this.key); }
    };
});
document.oncontextmenu = (event) => {
    if (event.target && event.target.tagName.toLowerCase() === 'input' && (event.target.type.toLowerCase() === 'text' || event.target.type.toLowerCase() === 'password'))
        return;
    else {
        event.preventDefault(); event.stopPropagation(); return false;
    }
};
Date.prototype.toJSON = function () {
    const tz = this.getTimezoneOffset();
    const sign = tz > 0 ? '-' : '+';
    const absTz = Math.abs(tz);
    const f = (n, c) => n.toString().padStart(c, '0');

    return `${this.getFullYear()}-${f(this.getMonth() + 1, 2)}-${f(this.getDate(), 2)}T${f(this.getHours(), 2)}:${f(this.getMinutes(), 2)}:${f(this.getSeconds(), 2)}.${f(this.getMilliseconds(), 3)}${sign}${f(Math.floor(absTz / 60), 2)}${f(absTz % 60, 2)}`;
};
Date.prototype.fmt = function (fmtMask, emptyMask) {
    const mask = fmtMask || 'MM-dd-yyyy HH:mm:ss';
    if (mask.match(/[hHmt]/) && this.isDateTimeEmpty?.()) return emptyMask ?? '';
    if (mask.match(/[Mdy]/) && this.isDateEmpty?.()) return emptyMask ?? '';

    const d = this;
    const y = d.getFullYear();
    const H = d.getHours();
    const m = d.getMonth();
    const map = {
        yyyy: y,
        yy: String(y).slice(-2),
        MMMM: formatType.MONTHS[m],
        MMM: formatType.MONTHS[m]?.substring(0, 3),
        MM: String(m + 1).padStart(2, '0'),
        M: m + 1,
        dddd: formatType.DAYS[d.getDay()],
        ddd: formatType.DAYS[d.getDay()]?.substring(0, 3),
        dd: String(d.getDate()).padStart(2, '0'),
        d: d.getDate(),
        HH: String(H).padStart(2, '0'),
        H: H,
        hh: String(H % 12 || 12).padStart(2, '0'),
        h: (H % 12 || 12),
        mm: String(d.getMinutes()).padStart(2, '0'),
        m: d.getMinutes(),
        ss: String(d.getSeconds()).padStart(2, '0'),
        s: d.getSeconds(),
        tt: H < 12 ? 'am' : 'pm',
        t: H < 12 ? 'a' : 'p'
    };

    return mask.replace(/yyyy|yy|MMMM|MMM|MM|M|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|tt|t/g, t => map[t]);
};
Number.prototype.round = function (dec) { return Number(Math.round(this + 'e' + dec) + 'e-' + dec); };
Number.prototype.fmt = function (format, empty) {
    if (isNaN(this)) return empty || '';
    if (typeof format === 'undefined') return this.toString();
    let isNegative = this < 0;
    let tok = ['#', '0'];
    let pfx = '', sfx = '', fmt = format.replace(/[^#\.0\,]/g, '');
    let dec = fmt.lastIndexOf('.') > 0 ? fmt.length - (fmt.lastIndexOf('.') + 1) : 0,
    fw = '', fd = '', vw = '', vd = '', rw = '', rd = '';
    let val = String(Math.abs(this).round(dec));
    let ret = '', commaChar = ',', decChar = '.';
    for (var i = 0; i < format.length; i++) {
        let c = format.charAt(i);
        if (c === '#' || c === '0' || c === '.' || c === ',')
            break;
        pfx += c;
    }
    for (let i = format.length - 1; i >= 0; i--) {
        let c = format.charAt(i);
        if (c === '#' || c === '0' || c === '.' || c === ',')
            break;
        sfx = c + sfx;
    }
    if (dec > 0) {
        let dp = val.lastIndexOf('.');
        if (dp === -1) {
            val += '.'; dp = 0;
        }
        else
            dp = val.length - (dp + 1);
        while (dp < dec) {
            val += '0';
            dp++;
        }
        fw = fmt.substring(0, fmt.lastIndexOf('.'));
        fd = fmt.substring(fmt.lastIndexOf('.') + 1);
        vw = val.substring(0, val.lastIndexOf('.'));
        vd = val.substring(val.lastIndexOf('.') + 1);
        let ds = val.substring(val.lastIndexOf('.'), val.length);
        for (let i = 0; i < fd.length; i++) {
            if (fd.charAt(i) === '#' && vd.charAt(i) !== '0') {
                rd += vd.charAt(i);
                continue;
            } else if (fd.charAt(i) === '#' && vd.charAt(i) === '0') {
                var np = vd.substring(i);
                if (np.match('[1-9]')) {
                    rd += vd.charAt(i);
                    continue;
                }
                else
                    break;
            }
            else if (fd.charAt(i) === '0' || fd.charAt(i) === '#')
                rd += vd.charAt(i);
        }
        if (rd.length > 0) rd = decChar + rd;
    }
    else {
        fw = fmt;
        vw = val;
    }
    var cg = fw.lastIndexOf(',') >= 0 ? fw.length - fw.lastIndexOf(',') - 1 : 0;
    var nw = Math.abs(Math.floor(this.round(dec)));
    if (!(nw === 0 && fw.substr(fw.length - 1) === '#') || fw.substr(fw.length - 1) === '0') {
        var gc = 0;
        for (let i = vw.length - 1; i >= 0; i--) {
            rw = vw.charAt(i) + rw;
            gc++;
            if (gc === cg && i !== 0) {
                rw = commaChar + rw;
                gc = 0;
            }
        }
        if (fw.length > rw.length) {
            var pstart = fw.indexOf('0');
            if (pstart >= 0) {
                var plen = fw.length - pstart;
                var pos = fw.length - rw.length - 1;
                while (rw.length < plen) {
                    let pc = fw.charAt(pos);
                    if (pc === ',') pc = commaChar;
                    rw = pc + rw;
                    pos--;
                }
            }
        }
    }
    if (isNegative) rw = '-' + rw;
    if (rd.length === 0 && rw.length === 0) return '';
    return pfx + rw + rd + sfx;
};
function makeBool(val) {
    if (typeof val === 'boolean') return val;
    if (typeof val === 'undefined') return false;
    if (typeof val === 'number') return val >= 1;
    if (typeof val === 'string') {
        if (val === '') return false;
        switch (val.toLowerCase().trim()) {
            case 'on':
            case 'true':
            case 'yes':
            case 'y':
                return true;
            case 'off':
            case 'false':
            case 'no':
            case 'n':
                return false;
        }
        if (!isNaN(parseInt(val, 10))) return parseInt(val, 10) >= 1;
    }
    return false;
}
var httpStatusText = {
    '200': 'OK',
    '201': 'Created',
    '202': 'Accepted',
    '203': 'Non-Authoritative Information',
    '204': 'No Content',
    '205': 'Reset Content',
    '206': 'Partial Content',
    '300': 'Multiple Choices',
    '301': 'Moved Permanently',
    '302': 'Found',
    '303': 'See Other',
    '304': 'Not Modified',
    '305': 'Use Proxy',
    '306': 'Unused',
    '307': 'Temporary Redirect',
    '400': 'Bad Request',
    '401': 'Unauthorized',
    '402': 'Payment Required',
    '403': 'Forbidden',
    '404': 'Not Found',
    '405': 'Method Not Allowed',
    '406': 'Not Acceptable',
    '407': 'Proxy Authentication Required',
    '408': 'Request Timeout',
    '409': 'Conflict',
    '410': 'Gone',
    '411': 'Length Required',
    '412': 'Precondition Required',
    '413': 'Request Entry Too Large',
    '414': 'Request-URI Too Long',
    '415': 'Unsupported Media Type',
    '416': 'Requested Range Not Satisfiable',
    '417': 'Expectation Failed',
    '418': 'I\'m a teapot',
    '429': 'Too Many Requests',
    '500': 'Internal Server Error',
    '501': 'Not Implemented',
    '502': 'Bad Gateway',
    '503': 'Service Unavailable',
    '504': 'Gateway Timeout',
    '505': 'HTTP Version Not Supported'
};
// Startup payloads fetched in one go by /bootstrap. Each request costs a
// fresh TCP connection (the server answers Connection: close), which is
// nothing on a LAN but around 800ms behind a reverse proxy - so chaining the
// four reads cost seconds on mobile. They are served from here the first
// time each is asked for; any later read goes to the network as usual, so a
// panel reloading after a save still sees fresh data.
const _boot = { data: null, taken: {} };
const _bootKeys = {
    '/modulesettings': 'module',
    '/controller': 'controller',
    '/networksettings': 'network',
    '/mqttsettings': 'mqtt'
};
function bootstrapPrime(cb) {
    _boot.data = null; _boot.taken = {};
    getJSON('/bootstrap', (err, d) => {
        if (!err && d) _boot.data = d;
        if (cb) cb();
    }, true);
}
// Returns the cached payload for this url, or undefined. Consumed once.
function _bootTake(url) {
    const key = _bootKeys[url];
    if (!key || !_boot.data || _boot.taken[key]) return undefined;
    const val = _boot.data[key];
    if (typeof val === 'undefined') return undefined;
    _boot.taken[key] = true;
    return val;
}
function getJSON(url, cb, skipCache) {
    if (!skipCache) {
        const cached = _bootTake(url);
        if (typeof cached !== 'undefined') { setTimeout(() => cb(null, cached), 0); return; }
    }
    let xhr = new XMLHttpRequest();
    if(DBG) console.log({ get: url });
    xhr.open('GET', baseUrl.length > 0 ? `${baseUrl}${url}` : url, true);
    xhr.setRequestHeader('apikey', security.apiKey);
    xhr.responseType = 'json';
    xhr.onload = () => {
        let status = xhr.status;
        if (status !== 200) {
            if (status === 401 && typeof security !== 'undefined' && security.promptLoginOn401()) { if (typeof overlay !== 'undefined' && overlay) overlay.remove(); return; }
            let err = xhr.response || {};
            err.htmlError = status;
            err.service = `GET ${url}`;
            if (typeof err.desc === 'undefined') err.desc = xhr.statusText || httpStatusText[xhr.status || 500];
            cb(err, null);
        }
        else {
            cb(null, xhr.response);
        }
    };
    xhr.onerror = (evt) => {
        let err = {
            htmlError: xhr.status || 500,
            service: `GET ${url}`
        };
        if (typeof err.desc === 'undefined') err.desc = xhr.statusText || httpStatusText[xhr.status || 500];
        cb(err, null);
    };
    xhr.send();
}
// Same as getJSON, plus a modal wait overlay for the duration of the request.
// The request itself is asynchronous, like every other one here.
function getJSONBusy(url, cb) {
    const cached = _bootTake(url);
    if (typeof cached !== 'undefined') { setTimeout(() => cb(null, cached), 0); return; }
    // The overlay used to appear before the request even left, so a 20ms read
    // still flashed a spinner. Hold it back: a response that lands inside the
    // delay never shows one at all.
    let overlay = null, done = false;
    const tOverlay = setTimeout(() => { if (!done) overlay = ui.waitMessage(get('divContainer')); }, 250);
    const clearBusy = () => {
        done = true;
        clearTimeout(tOverlay);
        if (overlay) { overlay.remove(); overlay = null; }
    };
    let xhr = new XMLHttpRequest();
    xhr.responseType = 'json';
    xhr.onload = () => {
        let status = xhr.status;
        if (status !== 200) {
            if (status === 401 && typeof security !== 'undefined' && security.promptLoginOn401()) { clearBusy(); return; }
            let err = xhr.response || {};
            err.htmlError = status;
            err.service = `GET ${url}`;
            if (typeof err.desc === 'undefined') err.desc = xhr.statusText || httpStatusText[xhr.status || 500];
            cb(err, null);
        }
        else {
            if(DBG) console.log({ get: url, obj:xhr.response });
            cb(null, xhr.response);
        }
        clearBusy();
    };

        xhr.onerror = (evt) => {
            let err = {
                htmlError: xhr.status || 500,
                service: `GET ${url}`
            };
            if (typeof err.desc === 'undefined') err.desc = xhr.statusText || httpStatusText[xhr.status || 500];
            cb(err, null);
            clearBusy();
        };
            xhr.onabort = (evt) => {
                if(DBG) console.log('Aborted');
                clearBusy();
            };
                xhr.open('GET', baseUrl.length > 0 ? `${baseUrl}${url}` : url, true);
                xhr.setRequestHeader('apikey', security.apiKey);
                xhr.send();
}
function getText(url, cb) {
    let xhr = new XMLHttpRequest();
    if(DBG) console.log({ get: url });
    xhr.open('GET', baseUrl.length > 0 ? `${baseUrl}${url}` : url, true);
    xhr.setRequestHeader('apikey', security.apiKey);
    xhr.responseType = 'text';
    xhr.onload = () => {
        let status = xhr.status;
        if (status !== 200) {
            if (status === 401 && typeof security !== 'undefined' && security.promptLoginOn401()) { if (typeof overlay !== 'undefined' && overlay) overlay.remove(); return; }
            let err = xhr.response || {};
            err.htmlError = status;
            err.service = `GET ${url}`;
            if (typeof err.desc === 'undefined') err.desc = xhr.statusText || httpStatusText[xhr.status || 500];
            cb(err, null);
        }
        else
            cb(null, xhr.response);
    };
    xhr.onerror = (evt) => {
        let err = {
            htmlError: xhr.status || 500,
            service: `GET ${url}`
        };
        if (typeof err.desc === 'undefined') err.desc = xhr.statusText || httpStatusText[xhr.status || 500];
        cb(err, null);
    };
    xhr.send();
}
// Multipart POST with a wait overlay. Currently unused, kept alongside its siblings.
function postJSONBusy(url, data, cb) {
    let overlay = ui.waitMessage(get('divContainer'));
    try {
        let xhr = new XMLHttpRequest();
        if(DBG) console.log({ post: url, data: data });
        let fd = new FormData();
        for (let name in data) {
            fd.append(name, data[name]);
        }
        xhr.open('POST', baseUrl.length > 0 ? `${baseUrl}${url}` : url, true);
        xhr.responseType = 'json';
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.setRequestHeader('apikey', security.apiKey);
        xhr.onload = () => {
            let status = xhr.status;
            if(DBG) console.log(xhr);
            if (status !== 200) {
                if (status === 401 && typeof security !== 'undefined' && security.promptLoginOn401()) { if (typeof overlay !== 'undefined' && overlay) overlay.remove(); return; }
                let err = xhr.response || {};
                err.htmlError = status;
                err.service = `POST ${url}`;
                err.data = data;
                if (typeof err.desc === 'undefined') err.desc = xhr.statusText || httpStatusText[xhr.status || 500];
                cb(err, null);
            }
            else {
                cb(null, xhr.response);
            }
            overlay.remove();
        };
        xhr.onerror = (evt) => {
            if(DBG) console.log(xhr);
            let err = {
                htmlError: xhr.status || 500,
                service: `POST ${url}`
            };
            if (typeof err.desc === 'undefined') err.desc = xhr.statusText || httpStatusText[xhr.status || 500];
            cb(err, null);
            overlay.remove();
        };
        xhr.send(fd);
    } catch (err) { ui.serviceError(get('divContainer'), err); }
}
function putJSON(url, data, cb) {
    let xhr = new XMLHttpRequest();
    if(DBG) console.log({ put: url, data: data });
    xhr.open('PUT', baseUrl.length > 0 ? `${baseUrl}${url}` : url, true);
    xhr.responseType = 'json';
    xhr.setRequestHeader('Content-Type', 'application/json; charset=utf-8');
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('apikey', security.apiKey);
    xhr.onload = () => {
        let status = xhr.status;
        if (status !== 200) {
            if (status === 401 && typeof security !== 'undefined' && security.promptLoginOn401()) { if (typeof overlay !== 'undefined' && overlay) overlay.remove(); return; }
            let err = xhr.response || {};
            err.htmlError = status;
            err.service = `PUT ${url}`;
            err.data = data;
            if (typeof err.desc === 'undefined') err.desc = xhr.statusText || httpStatusText[xhr.status || 500];
            cb(err, null);
        }
        else {
            cb(null, xhr.response);
        }
    };
    xhr.onerror = (evt) => {
        if(DBG) console.log(xhr);
        let err = {
            htmlError: xhr.status || 500,
            service: `PUT ${url}`
        };
        if (typeof err.desc === 'undefined') err.desc = xhr.statusText || httpStatusText[xhr.status || 500];
        cb(err, null);
    };
    xhr.send(JSON.stringify(data));
}
// Same as putJSON, plus a modal wait overlay and a try/catch that reports failures
// through ui.serviceError. Asynchronous, despite what the old "Sync" name suggested.
function putJSONBusy(url, data, cb) {
    let overlay = ui.waitMessage(get('divContainer'));
    try {
        let xhr = new XMLHttpRequest();
        if(DBG) console.log({ put: url, data: data });
        //xhr.open('PUT', url, true);
        xhr.open('PUT', baseUrl.length > 0 ? `${baseUrl}${url}` : url, true);
        xhr.responseType = 'json';
        xhr.setRequestHeader('Content-Type', 'application/json; charset=utf-8');
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.setRequestHeader('apikey', security.apiKey);
        xhr.onload = () => {
            let status = xhr.status;
            if (status !== 200) {
                if (status === 401 && typeof security !== 'undefined' && security.promptLoginOn401()) { if (typeof overlay !== 'undefined' && overlay) overlay.remove(); return; }
                let err = xhr.response || {};
                err.htmlError = status;
                err.service = `PUT ${url}`;
                err.data = data;
                if (typeof err.desc === 'undefined') err.desc = xhr.statusText || httpStatusText[xhr.status || 500];
                cb(err, null);
            }
            else {
                cb(null, xhr.response);
            }
            overlay.remove();
        };
        xhr.onerror = (evt) => {
            if(DBG) console.log(xhr);
            let err = {
                htmlError: xhr.status || 500,
                service: `PUT ${url}`
            };
            if (typeof err.desc === 'undefined') err.desc = xhr.statusText || httpStatusText[xhr.status || 500];
            cb(err, null);
            overlay.remove();
        };
        xhr.send(JSON.stringify(data));
    } catch (err) { ui.serviceError(get('divContainer'), err); }
}
