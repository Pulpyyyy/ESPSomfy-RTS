// Only used when the page is opened straight from disk (file://) during development;
// served from the device, baseUrl stays relative. Defaults to the fallback access point
// so no one's LAN address ships in the published firmware.
var hst = '192.168.4.1';
var DBG = false; // UI debug logging (requests, heap); never logs secrets

var _rooms = [];
let LANG = {};
var baseUrl = window.location.protocol === 'file:' ? `http://${hst}` : '';
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
if (typeof ui !== 'undefined' && ui.waitMessage) {
    waitLoad = ui.waitMessage(document.body);
}
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
// Show a shade's travel as Closed / Open at the extremes and a percentage in between.
// Mirrors the icon, which already flips the value for a reversed shade (flipPosition).
function shadePosLabel(position, flip) {
    const eff = flip ? 100 - position : position;
    if (eff <= 0) return tr('POS_CLOSED');
    if (eff >= 100) return tr('POS_OPEN');
    return eff + '%';
}
function loadLang(callback) {
    if (Object.keys(LANG).length > 0) {
        if(DBG) console.log("Language already in memory, using the cache.");
        if (callback) callback();
        return;
    }
    fetch(baseUrl + '/lang')
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
function getJSON(url, cb) {
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
    let overlay = ui.waitMessage(get('divContainer'));
    let xhr = new XMLHttpRequest();
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
            if(DBG) console.log({ get: url, obj:xhr.response });
            cb(null, xhr.response);
        }
        if (typeof overlay !== 'undefined') overlay.remove();
    };

        xhr.onerror = (evt) => {
            let err = {
                htmlError: xhr.status || 500,
                service: `GET ${url}`
            };
            if (typeof err.desc === 'undefined') err.desc = xhr.statusText || httpStatusText[xhr.status || 500];
            cb(err, null);
            if (typeof overlay !== 'undefined') overlay.remove();
        };
            xhr.onabort = (evt) => {
                if(DBG) console.log('Aborted');
                if (typeof overlay !== 'undefined') overlay.remove();
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
var socket;
var tConnect = null;
var sockIsOpen = false;
var connecting = false;
var connects = 0;
var connectFailed = 0;
async function initSockets() {
    if (connecting) return;
    if(DBG) console.log('Connecting to socket...');
    connecting = true;
    if (tConnect) clearTimeout(tConnect);
    tConnect = null;
    let wms = document.getElementsByClassName('socket-wait');
    for (let i = 0; i < wms.length; i++) {
        wms[i].remove();
    }
    ui.waitMessage(get('divContainer')).classList.add('socket-wait');
    let host = window.location.protocol === 'file:' ? hst : window.location.hostname;
    try {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const port = window.location.protocol === 'https:' ? '' : ':8080';
        socket = new WebSocket(`${protocol}//${host}${port}/`);
        socket.onmessage = (evt) => {
            if (evt.data.startsWith('42')) {
                let ndx = evt.data.indexOf(',');
                let eventName = evt.data.substring(3, ndx);
                let data = evt.data.substring(ndx + 1, evt.data.length - 1);
                try {
                    var reISO = /^(\d{4}|\+010000)-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}(?:\.\d*))(?:Z|(\+|-)([\d|:]*))?$/;
                    var reMsAjax = /^\/Date\((d|-|.*)\)[\/|\\]$/;
                    var msg = JSON.parse(data, (key, value) => {
                        if (typeof value === 'string') {
                            var a = reISO.exec(value);
                            if (a) return new Date(value);
                            a = reMsAjax.exec(value);
                            if (a) {
                                var b = a[1].split(/[-+,.]/);
                                return new Date(b[0] ? +b[0] : 0 - +b[1]);
                            }
                        }
                        return value;
                    });
                    switch (eventName) {
                        case 'memStatus':
                            firmware.procMemoryStatus(msg);
                            break;
                        case 'updateProgress':
                            firmware.procUpdateProgress(msg);
                            break;
                        case 'fwStatus':
                            firmware.procFwStatus(msg);
                            break;
                        case 'remoteFrame':
                            somfy.procRemoteFrame(msg);
                            break;
                        case 'groupState':
                            somfy.procGroupState(msg);
                            break;
                        case 'shadeState':
                            somfy.procShadeState(msg);
                            break;
                        case 'shadeCommand':
                            if (window.calWizardOnCommand) window.calWizardOnCommand(msg);
                            break;
                        case 'roomRemoved':
                            somfy.procRoomRemoved(msg);
                            break;
                        case 'roomAdded':
                            somfy.procRoomAdded(msg);
                            break;
                        case 'shadeRemoved':
                            break;
                        case 'shadeAdded':
                            break;
                        case 'ethernet':
                            wifi.procEthernet(msg);
                            break;
                        case 'wifiStrength':
                            wifi.procWifiStrength(msg);
                            break;
                        case 'packetPulses':
                            if(DBG) console.log(msg);
                            break;
                        case 'frequencyScan':
                            somfy.procFrequencyScan(msg);
                            break;
                    }
                } catch (err) {
                    if(DBG) console.log({ eventName: eventName, data: data, err: err });
                }
            }
        };
        socket.onopen = (evt) => {
            if (tConnect) clearTimeout(tConnect);
            tConnect = null;
            if(DBG) console.log({ msg: 'open', evt: evt });
            document.body.classList.add('socket-on');
            sockIsOpen = true;
            connecting = false;
            connects++;
            connectFailed = 0;
            let wms = document.getElementsByClassName('socket-wait');
            for (let i = 0; i < wms.length; i++) {
                wms[i].remove();
            }
            let errs = document.getElementsByClassName('socket-error');
            for (let i = 0; i < errs.length; i++)
                errs[i].remove();
            if (general.reloadApp) {
                general.reload();
            }
            else {
                (async () => {
                    ui.clearErrors();
                    await general.loadGeneral();
                    await somfy.loadSomfy();
                    // Config panels need auth; skip them until logged in (or type None)
                    // so we don't fire 401s the browser logs on every socket reconnect.
                    const _authed = (typeof security === 'undefined') || security.type === 0 || security.authenticated;
                    if (_authed) { await wifi.loadNetwork(); await mqtt.loadMQTT(); }
                    if (ui.isConfigOpen()) socket.send('join:0' + (security.apiKey ? ':' + security.apiKey : ''));
                })();
            }
        };
        socket.onclose = (evt) => {
            document.body.classList.remove('socket-on');
            wifi.procWifiStrength({ ssid: '', channel: -1, strength: -100 });
            wifi.procEthernet({ connected: false, speed: 0, fullduplex: false });
            if (document.getElementsByClassName('socket-wait').length === 0)
                ui.waitMessage(get('divContainer')).classList.add('socket-wait');
            if (evt.wasClean) {
                if(DBG) console.log({ msg: 'close-clean', evt: evt });
                connectFailed = 0;
                tConnect = setTimeout(async () => { await reopenSocket(); }, 7000);
                if(DBG) console.log('Reconnecting socket in 7 seconds');
            }
            else {
                if(DBG) console.log({ msg: 'close-died', reason: evt.reason, evt: evt, sock: socket });
                if (connects > 0) {
                    if(DBG) console.log('Reconnecting socket in 3 seconds');
                    tConnect = setTimeout(async () => { await reopenSocket(); }, 3000);
                }
                else {
                    if (connecting) {
                        connectFailed++;
                        let timeout = Math.min(connectFailed * 500, 10000);
                        if(DBG) console.log(`Initial socket did not connect try again (server was busy and timed out ${connectFailed} times)`);
                        tConnect = setTimeout(async () => { await reopenSocket(); }, timeout);
                        if (connectFailed === 5) {
                            ui.socketError(tr('ERR_SOCKET_TOO_MANY'));
                        }
                        let spanAttempts = get('spanSocketAttempts');
                        if (spanAttempts) spanAttempts.innerHTML = connectFailed.fmt("#,##0");
                    }
                    else {
                        if(DBG) console.log('Connecting socket in .5 seconds');
                        tConnect = setTimeout(async () => { await reopenSocket(); }, 500);
                    }
                }
            }
            connecting = false;
        };
        socket.onerror = (evt) => {
            if(DBG) console.log({ msg: 'socket error', evt: evt, sock: socket });
        };
    } catch (err) {
        if(DBG) console.log({
            msg: 'Websocket connection error', err: err
        });
        tConnect = setTimeout(async () => { await reopenSocket(); }, 5000);
    }
}
function clearOverlays() {
    const selectors = ['.inst-overlay', '.info-message', '.prompt-message', '.error-message', '.instructions', '#divGitInstall'];
    selectors.forEach(s => document.querySelectorAll(s).forEach(el => { closeDialog(el); el.remove(); }));
}
// Overlays could only be dismissed with the mouse, which left keyboard users stuck in
// an edit dialog or a PIN prompt with no way out.
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' && e.key !== 'Esc') return;
    const selectors = ['.inst-overlay', '.info-message', '.prompt-message', '.error-message', '.instructions', '#divGitInstall'];
    if (!selectors.some(s => document.querySelector(s))) return;
    e.preventDefault();
    clearOverlays();
});
/**
 * Keeps the sidebar and the tab strip on the same selection.
 * @param {string} groupId - id of the group to activate
 * @param {boolean} isSubTab - true when the target is a sub-tab
 */
function syncNavigationState(groupId, isSubTab = false) {
    if (!groupId) return;
    if (!isSubTab) {
        document.querySelectorAll('.nav-item').forEach(i => i.classList.toggle('active', i.getAttribute('data-grpid') === groupId));
        document.querySelectorAll('.submenu').forEach(s => {
            const isTarget = s.previousElementSibling?.getAttribute('data-grpid') === groupId;
            s.style.display = isTarget ? 'flex' : 'none';
            // Drive the .open class too so the chevron rotates (main.css .nav-group.open .arrow-icon).
            if (s.closest('.nav-group')) s.closest('.nav-group').classList.toggle('open', isTarget);

            if (isTarget) {
                const firstSub = s.querySelector('.sub-nav-item');
                if (firstSub) {
                    s.querySelectorAll('.sub-nav-item').forEach(sub => sub.classList.remove('active'));
                    firstSub.classList.add('active');
                }
            }
        });
        document.querySelectorAll('.tab-container > span').forEach(t => t.classList.toggle('selected', t.getAttribute('data-grpid') === groupId));
        const targetPanel = get(groupId);
        const firstSubTab = targetPanel ? targetPanel.querySelector('.subtab-container > span') : null;
        if (firstSubTab) {
            firstSubTab.click();          // the sub-tab sync below writes the hash
        } else {
            navUpdateHash(groupId);
        }
    } else {
        document.querySelectorAll('.sub-nav-item').forEach(i => i.classList.toggle('active', i.getAttribute('data-grpid') === groupId));
        document.querySelectorAll('.subtab-container > span').forEach(t => t.classList.toggle('selected', t.getAttribute('data-grpid') === groupId));
        // Visible page title ("Somfy › Volets"): after a scroll on mobile the selected
        // pill is off-screen, leaving no cue of where the user is.
        const panel = get(groupId);
        const subItem = document.querySelector(`.sub-nav-item[data-grpid="${groupId}"]`);
        if (panel && subItem) {
            const grp = subItem.closest('.nav-group')?.querySelector('.nav-item > span');
            let h = panel.querySelector(':scope > .panel-title');
            if (!h) { h = document.createElement('h2'); h.className = 'panel-title'; panel.prepend(h); }
            h.textContent = grp ? `${grp.textContent} › ${subItem.textContent}` : subItem.textContent;
        }
        navUpdateHash(groupId);
    }
}
function bindNavigation() {
    document.querySelectorAll('.nav-item, .sub-nav-item').forEach(item => {
        // These are anchors without an href, which browsers do not treat as focusable,
        // so the whole menu was unreachable by keyboard. Expose them as buttons; the
        // delegated role="button" handler takes care of Enter/Space.
        if (!item.hasAttribute('tabindex')) item.setAttribute('tabindex', '0');
        if (!item.hasAttribute('role')) item.setAttribute('role', 'button');
        item.addEventListener('click', (e) => {
            e.preventDefault();
            // Clicking the chevron just folds/unfolds the group; navigation (and its
            // data loads) only happens when the label itself is clicked.
            if (e.target.closest && e.target.closest('.arrow-icon')) {
                const grp = item.closest('.nav-group');
                const sub = grp ? grp.querySelector('.submenu') : null;
                if (sub) {
                    const open = sub.style.display !== 'none';
                    sub.style.display = open ? 'none' : 'flex';
                    grp.classList.toggle('open', !open);
                }
                return;
            }
            if (!navConfirmLeave(() => item.click())) return;
            navClearDirty(); navSuppress();
            clearOverlays();
            const groupId = item.getAttribute('data-grpid');
            const isSub = item.classList.contains('sub-nav-item');

            if (groupId === 'divHomePnl') {
                if (typeof ui !== 'undefined') ui.setHomePanel();
                syncNavigationState(groupId);
                return;
            }
            if (typeof ui !== 'undefined' && !ui.isConfigOpen()) {
                if (typeof security !== 'undefined' && !security.authenticated && security.type !== 0) {
                    get('divContainer').addEventListener('afterlogin', () => {
                        if (security.authenticated) {
                            ui.setConfigPanel();
                            item.click();
                        }
                    }, { once: true });
                    security.authUser();
                    return;
                }
                ui.setConfigPanel();
            }
            const selector = isSub ? `.subtab-container > span[data-grpid="${groupId}"]` : `.tab-container > span[data-grpid="${groupId}"]`;
            const originalTab = document.querySelector(selector);

            if (originalTab) {
                originalTab.click();
            } else if (!isSub) {
                syncNavigationState(groupId);
                const firstSub = item.nextElementSibling?.querySelector('.sub-nav-item');
                if (firstSub) firstSub.click();
            }
        });
    });
    document.querySelectorAll('.tab-container > span, .subtab-container > span').forEach(tab => {
        tab.addEventListener('click', (evt) => {
            if (!navConfirmLeave(() => tab.click())) return;
            navClearDirty(); navSuppress();
            const groupId = tab.getAttribute('data-grpid');
            const isSub = tab.parentElement.classList.contains('subtab-container');
            // Explicit "Home" entry in the mobile tab bar: leave the config view.
            if (groupId === 'divHomePnl') {
                if (typeof ui !== 'undefined') ui.setHomePanel();
                syncNavigationState(groupId);
                return;
            }
            syncNavigationState(groupId, isSub);
            if (!isSub) {
                if (groupId !== 'divSomfySettings' && typeof somfy !== 'undefined') {
                    somfy.showEditShade(false); somfy.showEditGroup(false);
                }
                if (groupId === 'divNetworkSettings' && typeof wifi !== 'undefined') wifi.loadNetwork();
                document.querySelectorAll('.tab-container > span').forEach(t => {
                    const panel = get(t.getAttribute('data-grpid'));
                    if (panel) panel.style.display = (t.getAttribute('data-grpid') === groupId) ? '' : 'none';
                });
            } else {
                if (typeof ui !== 'undefined') ui.selectTab(tab);
            }
        });
    });
    navGuardSetup();
}
// --- Deep-linking ----------------------------------------------------------
// The current panel is reflected in the URL hash (#divSomfyMotors, ...) so that
// reload keeps the page, panels can be bookmarked, and the browser back button
// steps through panels instead of leaving the app (essential on mobile).
let _navFromHash = false;
function navApplyHash() {
    const id = decodeURIComponent((location.hash || '').replace(/^#/, ''));
    const target = id && id !== 'divHomePnl'
        ? document.querySelector(`.sub-nav-item[data-grpid="${id}"], .subtab-container > span[data-grpid="${id}"], .nav-item[data-grpid="${id}"], .tab-container > span[data-grpid="${id}"]`)
        : document.querySelector('.nav-item[data-grpid="divHomePnl"]');
    if (!target) return;
    _navFromHash = true;
    try { target.click(); } finally { _navFromHash = false; }
}
function navUpdateHash(groupId) {
    if (_navFromHash || !groupId) return;
    const h = groupId === 'divHomePnl' ? '' : '#' + groupId;
    if ((location.hash || '') === h) return;
    if (h) history.pushState(null, '', h);
    else history.pushState(null, '', location.pathname + location.search);
}
window.addEventListener('popstate', () => navApplyHash());
// --- Unsaved-changes navigation guard --------------------------------------
// Marks the page dirty on real user input; on navigation, if dirty, prompts to
// save / discard / cancel. A suppression window swallows the change events that
// fire while a form loads so they do not count as user edits.
let _navDirty = false, _navSuppress = false;
function navSuppress() { _navSuppress = true; setTimeout(() => { _navSuppress = false; }, 900); }
function navClearDirty() { _navDirty = false; }
function navMarkDirty() { if (!_navSuppress) _navDirty = true; }
function navGuardSetup() {
    const mark = (e) => {
        if (!e.isTrusted) return;                       // programmatic change events are not user edits
        const t = e.target;
        if (!t || !t.matches || !t.matches('input,select,textarea')) return;
        if (t.classList.contains('pin-digit')) return;  // PIN entry (login or security page) is not a config edit
        if (t.closest && t.closest('#divUnauthenticated')) return;  // nothing on the login screen counts
        navMarkDirty();
    };
    document.addEventListener('input', mark, true);
    document.addEventListener('change', mark, true);
    // Closing or reloading the tab must warn too, not just in-app navigation.
    window.addEventListener('beforeunload', (e) => {
        if (_navDirty) { e.preventDefault(); e.returnValue = ''; }
    });
}
function navFindSaveButton() {
    const cands = document.querySelectorAll('[id^="btnSave"], #btnLogin, #btnConnectMQTT');
    for (let i = 0; i < cands.length; i++) if (cands[i].offsetParent !== null) return cands[i];
    return null;
}
// Returns true if navigation may proceed; false if it opened the prompt (deferred).
function navConfirmLeave(proceed) {
    if (!_navDirty) return true;
    const div = document.createElement('div');
    div.className = 'prompt-message modal-overlay';
    div.innerHTML = `<div class="message-content"><div class="prompt-text">${tr('NAV_UNSAVED_TITLE')}</div>`
        + `<div class="sub-message">${tr('NAV_UNSAVED_DESC')}</div>`
        + '<div class="button-container-row">'
        + `<button line type="button" id="navCancel">${tr('BT_CANCEL_1')}</button>`
        + `<button type="button" id="navDiscard">${tr('NAV_DISCARD')}</button>`
        + `<button type="button" id="navSave">${tr('BT_SAVE')}</button>`
        + '</div></div>';
    get('divContainer').appendChild(div);
    openDialog(div);
    const done = () => { closeDialog(div); div.remove(); };
    div.querySelector('#navCancel').onclick = done;
    div.querySelector('#navDiscard').onclick = () => { navClearDirty(); done(); proceed(); };
    div.querySelector('#navSave').onclick = () => {
        const b = navFindSaveButton(); done();
        if (!b) { navClearDirty(); proceed(); return; }
        b.click();
        // Validation failures surface synchronously as an .error-message modal; in that
        // case stay on the page (still dirty) so the user can fix the field instead of
        // navigating away and silently losing the input.
        setTimeout(() => {
            if (document.querySelector('.error-message')) return;
            navClearDirty(); proceed();
        }, 60);
    };
    return false;
}
function stepDeviceGpio(pinKey, direction, prefix, boardSelectId, isManualCallback, pinMaps) {
    const selBoard = get(boardSelectId);
    if (!selBoard) return;

    const isM = isManualCallback(parseInt(selBoard.value, 10));
    const el = get((isM ? 'input' : 'sel') + prefix + pinKey);
    if (!el) return;

    let newValue;

    if (isM) {
        let current = parseInt(el.value, 10);
        if (isNaN(current)) current = 0;

        let next = current + direction;
        const cm = (get('divContainer').getAttribute('data-chipmodel') || "").toLowerCase();
        const pm = pinMaps.find(x => x.name === cm) || { maxPins: 39 };

        if (next < 0 || next > pm.maxPins) return;

        el.value = next;
        newValue = next;

        const selPin = get(`sel${prefix}${pinKey}`);
        if (selPin) selPin.value = next;
    } else {
        const nextIndex = el.selectedIndex + direction;
        if (nextIndex < 0 || nextIndex >= el.options.length) return;

        el.selectedIndex = nextIndex;
        newValue = el.value;

        const inpP = get(`input${prefix}${pinKey}`);
        if (inpP) inpP.value = newValue;
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));

    return newValue;
}
function overlayHeader(title, desc, icon = 'svg-simpleShutter', showExpert = false) {
    const expertSwitch = showExpert ? `<div class="expert-mode-container"><span class="expert-label">${tr("BT_EXPERT_MODE")}</span><span class="switch expert-switch"><input id="cbExpertMode" type="checkbox" ${ui.isExpertMode ? 'checked' : ''} onchange="ui.toggleExpertMode(this.closest('.inst-overlay'));" onclick="event.stopPropagation();"><div></div></span></div>` : '';

    return `<div class="overlay-header">${expertSwitch}<div close ${a11yBtn(tr('A11Y_CLOSE'))} onclick="closeOverlay(this.closest('.inst-overlay'))"><svg class="closeShow-desktop"><use href=#svg-close></use></svg></div></div><div class="instructions-header"><div><h2>${tr(title)}</h2><p>${tr(desc)}</p></div><svg class="instructions-headerLogo"><use href=#${icon}></use></svg></div>`;
}
function wizardStepper(stepsData, translationPrefix) {
    let stepsHtml = '';
    let titlesHtml = '';

    const isArray = Array.isArray(stepsData);
    const totalSteps = isArray ? stepsData.length : stepsData;

    for (let i = 1; i <= totalSteps; i++) {
        stepsHtml += `<div class="stepper-item" data-stepid="${i}"><div class="step-counter">${i}</div></div>`;

        let titleKey;
        if (isArray) {
            titleKey = stepsData[i - 1];
        } else {
            titleKey = `${translationPrefix}_STEP${i}`;
        }
        titlesHtml += `<h3 class="step-title wizard-step" data-stepid="${i}">${tr(titleKey)}</h3>`;
    }
    return `
    <div class="stepper-wrapper" style="--steps: ${totalSteps};">
    ${stepsHtml}
    </div>
    <div class="step-title-container">
    ${titlesHtml}
    </div>`;
}
function shOverlay(div, onClose) {
    if (!div) return;
    const btn = div.querySelector('[close]');
    if (btn) btn.onclick = () => closeOverlay(div, onClose);
    get('divContainer').appendChild(div);
    window.scrollTo(0, 0);
    openDialog(div);
}
// --- Calibration wizard (v1) -------------------------------------------------
// 100% UI: drives the shade via /shadeCommand, times the user's taps locally,
// computes downTime/upTime/curveGain and writes them into the shade form fields.
// Guided single-button flow: each tap records a timestamp and advances.
// --- Calibration wizard (v2): drive with the physical remote ---------------
// The user drives the shade with the real remote; the ESP's received-frame
// socket events (shadeCommand, source="remote") are timestamped to compute the
// times, and the wizard returns the shade to the start between measurements.
// The socket handler forwards shadeCommand events to window.calWizardOnCommand.
let _calWiz = null;
function startShadeCalibration() {
    const g = get, sh = ui.fromElement(g('somfyShade'));
    const sId = parseInt(g('spanShadeId').innerText, 10);
    if (isNaN(sId) || sId >= 255) { ui.errorMessage(tr('ERR_CAL_SAVE_FIRST')); return; }
    // The measurement modes need a paired remote; "Recopie" only copies values, so
    // the pairing is checked when a measurement mode is picked, not up front.
    const div = document.createElement('div');
    div.className = 'inst-overlay'; div.id = 'divCalWizard';
    div.innerHTML = '<div class="instructions-content"><div class="overlay-scroll-content">'
        + overlayHeader('CAL_TITLE', 'CAL_TITLE_DESC', 'svg-simpleShutter')
        + '<div class="unibloc">'
        + '<p id="calWizText" style="min-height:3.5em;font-size:1.05em;"></p>'
        + '<div id="calWizLive" style="opacity:.7;font-size:.9em;min-height:1.2em;"></div>'
        + '<div id="calWizResult"></div>'
        + '</div><div class="button-container-row" id="calWizBtns"></div>'
        + '</div></div>';
    shOverlay(div, () => calWizStop());
    // Snapshot the shade's current timings: repositioning deadlines scale on them and
    // the ascent solver falls back on the stored curve gain when 50% is not re-measured.
    _calWiz = { sId: sId, res: {}, plan: [], i: 0, phase: 'idle', t0: 0, cur: {
        up: parseInt(sh.upTime, 10) || 10000, down: parseInt(sh.downTime, 10) || 10000,
        lift: parseInt(sh.liftTime, 10) || 0, k: parseFloat(sh.curveGain) || 0
    } };
    window.calWizardOnCommand = calWizOnCommand;
    calWizText(tr('CAL_INTRO'));
    const needPaired = function (fn) {
        return function () {
            if (sh.paired === false) { ui.errorMessage(tr('ERR_CAL_NOT_PAIRED')); return; }
            fn();
        };
    };
    calWizButtons([
        { l: tr('CAL_BTN_GUIDED'), f: needPaired(function () { calWizBegin(); }) },
        { l: tr('CAL_BTN_RECOPY'), f: function () { calWizRecopy(sId); } }
    ]);
}
function calWizText(t, live) {
    if (get('calWizText')) get('calWizText').innerText = t;
    if (live !== undefined && get('calWizLive')) get('calWizLive').innerText = live;
}
function calWizButtons(list) {
    const c = get('calWizBtns'); if (!c) return; c.innerHTML = '';
    (list || []).forEach(function (b) {
        const d = document.createElement('div'); d.className = 'divButton';
        const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'buttonUpdate';
        btn.innerHTML = '<div class="devButtonUpdate"><div>' + b.l + '</div></div>';
        btn.onclick = b.f; d.appendChild(btn); c.appendChild(d);
    });
}
function calWizStop() { window.calWizardOnCommand = null; _calWiz = null; }
// closed% convention: 0 = fully open, 100 = fully closed (matches curveForward).
// Every value that enters the maths is stopped IN MOTION (sill, mid-height): a press
// at an end limit can only come after the motor stopped on its own, so those chronos
// carry the user's reaction time. The two end-limit runs remain in the plan as
// consistency checks only, and the final full ascent leaves the shade on a hard
// limit so its tracked position is re-synced whatever the previous timings were.
function calWizBegin() {
    _calWiz.plan = [
        { dir: 'down', at: 99, key: 'lift' },   // open -> sill: pure descent travel
        { dir: 'down', at: 50, key: 'c50' },    // open -> mid: winding curve fit
        { dir: 'down', at: 100, key: 'down' },  // open -> closed limit: sizes the stacking
        { dir: 'up', at: 50, key: 'u50' },      // closed -> mid: the ascent anchor
        { dir: 'up', at: 0, key: 'up' }         // closed -> top limit: check + resync
    ];
    _calWiz.i = 0;
    calWizNext();
}
async function calWizNext() {
    const w = _calWiz; if (!w) return;
    if (w.i >= w.plan.length) return calWizFinish();
    const s = w.plan[w.i];
    const startClosed = s.dir === 'down' ? 0 : 100;
    w.phase = 'returning';
    calWizText(tr('CAL_RETURNING').replace('%1', startClosed === 0 ? tr('CAL_POS_OPEN') : tr('CAL_POS_CLOSED')), w.lastResult || '');
    calWizButtons([]);
    await calWizGoto(startClosed);
    if (!_calWiz) return;
    const atTxt = s.at === 99 ? tr('CAL_AT_SILL')
        : s.at === 100 ? tr('CAL_AT_CLOSED')
        : s.at === 0 ? tr('CAL_AT_TOP')
        : s.dir === 'up' ? tr('CAL_AT_MID_UP')
        : tr('CAL_AT_MID_DOWN');
    const startCmd = s.dir === 'down' ? tr('CAL_CMD_DOWN') : tr('CAL_CMD_UP');
    w.phase = 'await_start';
    calWizText(tr('CAL_MEASURE_PROMPT').replace('%1', w.i + 1).replace('%2', w.plan.length).replace('%3', startCmd).replace('%4', atTxt),
        tr('CAL_AWAIT_START').replace('%1', startCmd));
    calWizButtons([{ l: tr('CAL_BTN_SKIP'), f: function () { w.i++; calWizNext(); } }]);
}
function calWizOnCommand(msg) {
    const w = _calWiz; if (!w) return;
    if (parseInt(msg.shadeId, 10) !== w.sId) return;
    if (msg.source !== 'remote') return;   // ignore the wizard's own internal commands
    const cmd = (msg.cmd || '').toLowerCase();
    const s = w.plan[w.i]; if (!s) return;
    const wantStart = s.dir === 'down' ? 'down' : 'up';
    if (w.phase === 'await_start' && cmd === wantStart) {
        w.t0 = Date.now(); w.phase = 'await_stop';
        calWizText(get('calWizText').innerText, tr('CAL_TIMER_STARTED'));
    } else if (w.phase === 'await_stop' && (cmd === 'my' || cmd === 'stop')) {
        const dt = Date.now() - w.t0;
        w.res[s.key] = dt; w.phase = 'done'; w.i++;
        const labels = { down: tr('CAL_LBL_DOWN'), up: tr('CAL_LBL_UP'), c50: tr('CAL_LBL_C50'), u50: tr('CAL_LBL_U50'), lift: tr('CAL_LBL_LIFT') };
        w.lastResult = tr('CAL_MEASURE_OK').replace('%1', labels[s.key] || s.key).replace('%2', dt);
        calWizText(w.lastResult, '');
        setTimeout(calWizNext, 700);
    } else if (w.phase === 'await_stop' && cmd !== wantStart && (cmd === 'up' || cmd === 'down')) {
        // An opposite-direction press mid-measure reverses the shade: the chrono no
        // longer measures a single run, so void it and redo the step (repositioning
        // included). Same-direction presses are harmless frame repeats and fall through.
        w.phase = 'invalid';
        calWizText(tr('CAL_MEASURE_VOIDED').replace('%1', cmd === 'up' ? tr('CAL_CMD_UP') : tr('CAL_CMD_DOWN')), '');
        setTimeout(calWizNext, 1500);
    }
}
// Drive to a closed% and wait until it stops (internal command -> ignored by the listener).
function calWizGoto(closedPct) {
    return new Promise(function (resolve) {
        const cmd = closedPct <= 0 ? { command: 'Up' } : closedPct >= 100 ? { command: 'Down' } : { target: closedPct };
        putJSON('/shadeCommand', Object.assign({ shadeId: _calWiz.sId }, cmd), function () { });
        // Worst repositioning is a full traverse; size the deadline on the shade's own
        // timings (liftTime alone may reach 60 s) with the old 32 s as a floor.
        const c = _calWiz.cur;
        const deadline = Date.now() + Math.max(32000, c.up + c.down + c.lift + 10000);
        const poll = function () {
            if (!_calWiz) return resolve();
            getJSON('/shades', function (err, shades) {
                const sh = !err && shades && shades.find(function (x) { return x.shadeId === _calWiz.sId; });
                if ((sh && sh.direction === 0) || Date.now() > deadline) return setTimeout(resolve, 1200);
                setTimeout(poll, 900);
            });
        };
        setTimeout(poll, 2500);   // let the move start before polling for stop
    });
}
// Mirror of the firmware's curveInverse: visible % -> time-linear (drum angle) %.
function calWizTauOf(P, k) {
    if (!k) return P;
    const a = k / 100, b = 1 + k, disc = b * b - 4 * a * P;
    if (disc <= 0) return P;
    return (b - Math.sqrt(disc)) / (2 * a);
}
function calWizFinish() {
    const w = _calWiz, r = w.res, g = get;
    // Model: downTime/upTime are pure travel; liftTime (slat stacking at the closed
    // end) is separate and additive. Only in-motion chronos enter the maths:
    //   r.lift = open->sill (pure descent), r.c50 = open->mid (curve fit),
    //   r.u50 = closed->mid, which is exactly what the firmware waits before the My
    //   of a 50% target (liftTime + curve fraction of upTime), so that target lands
    //   right by construction.
    // The ascent split comes from the stacking scaled by the up/down speed ratio:
    //   lift_up = lift_down * up/down, hence up = r.u50 / (lift_down/down + fc).
    // End-limit chronos (r.down beyond the sill, r.up) include the reaction time to a
    // stop the motor decides alone; r.down only sizes the stacking (its bias shifts
    // the lift/up split, not the anchored 50% wait) and r.up is a check, never a time.
    // A skipped required measure keeps the shade's current value for every field that
    // depends on it: no silent fallback that would double-count or absorb the stacking.
    const notes = [];
    const down = r.lift || null;
    if (!down) notes.push(tr('CAL_NOTE_NO_SILL'));
    let lift_d = null;                                 // stacking, seen from the descent side
    if (down && r.down) lift_d = Math.max(0, r.down - down);
    const kOf = function (dt, P) { const tau = dt / down * 100; const den = tau * (100 - tau) / 100; return den > 0 ? (P - tau) / den : 0; };
    const k = (down && r.c50) ? Math.min(0.95, Math.max(0, kOf(r.c50, 50))) : null;
    if (down && !r.c50) notes.push(tr('CAL_NOTE_NO_CURVE'));
    const kEff = k !== null ? k : (w.cur.k || 0);
    const fc = 1 - calWizTauOf(50, kEff) / 100;        // time fraction of a full ascent to reach mid
    let up = null, lift = null;
    if (r.u50 && down && lift_d !== null) {
        up = Math.max(1, Math.round(r.u50 / (lift_d / down + fc)));
        lift = Math.round(lift_d * up / down);
    }
    else if (r.u50) notes.push(tr('CAL_NOTE_UP_NEEDS_BOTH'));
    else notes.push(tr('CAL_NOTE_NO_MID'));
    let out = [];
    if (down) out.push(tr('CAL_RES_DOWN').replace('%1', down));
    if (up) out.push(tr('CAL_RES_UP').replace('%1', up));
    if (lift !== null) out.push(tr('CAL_RES_LIFT').replace('%1', lift).replace('%2', lift_d));
    if (k !== null) out.push(tr('CAL_RES_CURVE').replace('%1', k.toFixed(2)));
    // Consistency check: predicted full ascent vs the end-limit chrono. A positive gap
    // is the signature of a late STOP at the top limit (harmless: that chrono is not
    // used); a negative one means one of the ascent measures is wrong.
    if (up && r.up) {
        const delta = r.up - (lift + up);
        let line = tr('CAL_CHECK_TOP').replace('%1', r.up).replace('%2', lift + up);
        if (delta > 800) line += tr('CAL_CHECK_LATE').replace('%1', (delta / 1000).toFixed(1));
        else if (delta < -800) line += tr('CAL_CHECK_BAD');
        else line += " ✔";
        out.push('<span style="opacity:.85">' + line + '</span>');
    }
    notes.forEach(function (n) { out.push('<span style="opacity:.75">⚠ ' + n + '</span>'); });
    if (g('calWizResult')) g('calWizResult').innerHTML = '<hr>' + out.map(function (x) { return '<div>' + x + '</div>'; }).join('')
        + '<p style="opacity:.8">' + tr('CAL_APPLY_HINT') + '</p>';
    calWizText(tr('CAL_DONE'), '');
    const sId = w.sId;
    const vals = { up: up, down: down, lift: lift, k: k };
    const finishClose = function () {
        closeOverlay(document.getElementById('divCalWizard'));
        calWizStop();
        // Reload the panel with the persisted values; openEditShade resets the
        // guard's unsaved-changes flag, so the wizard does not touch it itself.
        somfy.openEditShade(sId);
    };
    calWizButtons([{ l: tr('CAL_BTN_APPLY'), f: function () {
        // Save straight to the shade: filling the form and relying on a second
        // manual save proved fragile (values silently lost on navigation).
        calWizApplyVals(sId, vals, function (err) {
            if (err) return ui.serviceError(err);
            ui.successMessage(tr('CAL_SAVED_TOAST'));
            // Then offer to copy the same values onto other shades.
            calWizCopyScreen(vals, sId, null, finishClose);
        });
    } }]);
}
// Partial /saveShade: writes only the measured fields (up/down/lift/k); a partial
// object leaves rolling codes, name, remote address, etc. untouched. Any field
// that is null/undefined is omitted, so it keeps its current value on the shade.
function calWizApplyVals(id, vals, cb) {
    const obj = { shadeId: id };
    if (vals.down) obj.downTime = vals.down;
    if (vals.up) obj.upTime = vals.up;
    if (vals.lift !== null && vals.lift !== undefined) obj.liftTime = vals.lift;
    if (vals.k !== null && vals.k !== undefined) obj.curveGain = parseFloat(Number(vals.k).toFixed(2));
    putJSON('/saveShade', obj, cb);
}
// Copying timings across shades of different sizes is how every mis-calibration of
// this kind starts: flag targets whose current descent differs clearly from the
// source's, so twin shades stay a one-click copy but odd ones stand out.
function calWizCopyWarn(srcDown, tgtDown) {
    if (!srcDown || !tgtDown) return '';
    const pct = Math.round((tgtDown - srcDown) * 100 / srcDown);
    if (Math.abs(pct) <= 15) return '';
    return ' <span style="opacity:.8">⚠ descente ' + (pct > 0 ? '+' : '') + pct + ' %</span>';
}
// Checklist of every other shade; the selected ones receive `vals`. Saves them one
// at a time (the ESP web server is synchronous and each save() rewrites shades.cfg,
// so serialising avoids overlapping writes). onDone() runs when finished or skipped.
function calWizCopyScreen(vals, excludeId, srcLabel, onDone) {
    calWizText(tr('CAL_COPY_PROMPT').replace('%1', srcLabel ? tr('CAL_COPY_FROM_PART').replace('%1', srcLabel) : ''), '');
    getJSON('/shades', function (err, shades) {
        if (err || !Array.isArray(shades)) { onDone(); return; }
        const others = shades.filter(function (s) { return s.shadeId !== excludeId && s.shadeId < 255; });
        if (!others.length) { calWizText(tr('CAL_NO_OTHER_SHADES'), ''); calWizButtons([{ l: tr('CAL_BTN_FINISH'), f: onDone }]); return; }
        // Multi-select: tick as many target shades as wanted (with a select-all).
        // MD3 checkbox markup (hidden input + .custom-checkbox), styled via #calWizResult.
        let html = '<hr>'
            + '<label class="calRow calRow-all"><input type="checkbox" id="calCopyAll"><span class="custom-checkbox"></span><span>' + tr('CAL_CHECK_ALL') + '</span></label>'
            + '<div class="calList">';
        others.forEach(function (s) {
            const nm = esc(s.name || ('#' + s.shadeId));
            html += '<label class="calRow"><input type="checkbox" class="calCopyChk" value="' + s.shadeId + '"><span class="custom-checkbox"></span><span>' + nm + calWizCopyWarn(vals.down, s.downTime) + '</span></label>';
        });
        html += '</div>';
        if (get('calWizResult')) get('calWizResult').innerHTML = html;
        const chkAll = document.getElementById('calCopyAll');
        if (chkAll) chkAll.onchange = function () {
            Array.prototype.forEach.call(document.querySelectorAll('.calCopyChk'), function (c) { c.checked = chkAll.checked; });
        };
        calWizButtons([
            { l: tr('CAL_BTN_COPY_SEL'), f: function () {
                const ids = Array.prototype.map.call(document.querySelectorAll('.calCopyChk:checked'),
                    function (c) { return parseInt(c.value, 10); });
                if (!ids.length) { calWizText(tr('CAL_SELECT_ONE'), ''); return; }
                calWizButtons([]);
                let idx = 0, failed = 0;
                const step = function () {
                    if (idx >= ids.length) {
                        if (failed) ui.errorMessage(tr('CAL_COPY_FAILED').replace('%1', failed).replace('%2', ids.length));
                        else ui.successMessage(tr('CAL_COPIED_TOAST').replace('%1', ids.length));
                        onDone();
                        return;
                    }
                    const id = ids[idx++];
                    calWizText(tr('CAL_COPYING').replace('%1', idx).replace('%2', ids.length), '');
                    calWizApplyVals(id, vals, function (e) { if (e) failed++; step(); });
                };
                step();
            } },
            { l: tr('CAL_BTN_FINISH'), f: onDone }
        ]);
    });
}
// Third mode: copy an already-calibrated shade's values onto others, no measurement.
// One screen: a single-choice "from" dropdown + a multi-choice "to" checklist, so
// the single vs. multiple distinction is unambiguous.
function calWizRecopy(sId) {
    calWizText(tr('CAL_RECOPY_PROMPT'), '');
    calWizButtons([]);
    getJSON('/shades', function (err, shades) {
        if (err || !Array.isArray(shades)) { ui.serviceError(err || {}); return; }
        const list = shades.filter(function (s) { return s.shadeId < 255; });
        if (list.length < 2) { calWizText(tr('CAL_RECOPY_NEED_TWO'), ''); calWizButtons([{ l: tr('BT_CLOSE'), f: function () { closeOverlay(document.getElementById('divCalWizard')); calWizStop(); } }]); return; }
        const srcOf = function () {
            const sel = document.getElementById('calSrcSel');
            return sel ? parseInt(sel.value, 10) : sId;
        };
        // Re-render source + targets; called on load and whenever the source changes
        // (so the chosen source is excluded from the target list).
        const render = function () {
            const srcId = srcOf();
            let html = '<hr><div style="text-align:left">'
                + '<label class="calFromLabel">' + tr('CAL_COPY_FROM') + '</label>'
                + '<select id="calSrcSel" class="inputAndSelect">'
                + list.map(function (s) {
                    return '<option value="' + s.shadeId + '"' + (s.shadeId === srcId ? ' selected' : '') + '>'
                        + esc(s.name || ('#' + s.shadeId))
                        + '  (↑' + s.upTime + ' ↓' + s.downTime + ' lift' + s.liftTime + ' k' + (s.curveGain || 0) + ')</option>';
                }).join('')
                + '</select>'
                + '<label class="calRow calRow-all"><input type="checkbox" id="calCopyAll"><span class="custom-checkbox"></span><span>' + tr('CAL_TO_CHECK_ALL') + '</span></label>'
                + '<div class="calList">';
            const src = list.find(function (s) { return s.shadeId === srcId; });
            list.filter(function (s) { return s.shadeId !== srcId; }).forEach(function (s) {
                html += '<label class="calRow"><input type="checkbox" class="calCopyChk" value="' + s.shadeId + '"><span class="custom-checkbox"></span><span>' + esc(s.name || ('#' + s.shadeId)) + calWizCopyWarn(src && src.downTime, s.downTime) + '</span></label>';
            });
            html += '</div></div>';
            if (get('calWizResult')) get('calWizResult').innerHTML = html;
            const sel = document.getElementById('calSrcSel');
            if (sel) sel.onchange = render;
            const chkAll = document.getElementById('calCopyAll');
            if (chkAll) chkAll.onchange = function () {
                Array.prototype.forEach.call(document.querySelectorAll('.calCopyChk'), function (c) { c.checked = chkAll.checked; });
            };
        };
        const close = function () {
            closeOverlay(document.getElementById('divCalWizard'));
            calWizStop();
            // openEditShade resets the guard's unsaved-changes flag on reload.
            somfy.openEditShade(sId);
        };
        render();
        calWizButtons([
            { l: tr('BT_COPY'), f: function () {
                const src = list.find(function (x) { return x.shadeId === srcOf(); });
                const ids = Array.prototype.map.call(document.querySelectorAll('.calCopyChk:checked'),
                    function (c) { return parseInt(c.value, 10); });
                if (!src || !ids.length) { calWizText(tr('CAL_PICK_SRC_TGT'), ''); return; }
                const vals = { up: src.upTime, down: src.downTime, lift: src.liftTime, k: src.curveGain };
                calWizButtons([]);
                let idx = 0, failed = 0;
                const step = function () {
                    if (idx >= ids.length) {
                        if (failed) ui.errorMessage(tr('CAL_COPY_FAILED').replace('%1', failed).replace('%2', ids.length));
                        else ui.successMessage(tr('CAL_COPIED_FROM_TOAST').replace('%1', esc(src.name || ('#' + src.shadeId))).replace('%2', ids.length));
                        close();
                        return;
                    }
                    const id = ids[idx++];
                    calWizText(tr('CAL_COPYING').replace('%1', idx).replace('%2', ids.length), '');
                    calWizApplyVals(id, vals, function (e) { if (e) failed++; step(); });
                };
                step();
            } },
            { l: tr('BT_CANCEL_1'), f: close }
        ]);
    });
}
function toggleTooltip(el) {
    const tooltip = el.querySelector('.tooltip-text');
    const isVisible = tooltip.style.display === 'block';

    document.querySelectorAll('.tooltip-text').forEach(t => t.style.display = 'none');
    tooltip.style.display = isVisible ? 'none' : 'block';

    if (!isVisible) {
        setTimeout(() => {
            window.addEventListener('click', function closeMenu() {
                tooltip.style.display = 'none';
                window.removeEventListener('click', closeMenu);
            }, { once: true });
        }, 10);
    }
}

async function reopenSocket() {
    if (tConnect) clearTimeout(tConnect);
    tConnect = null;
    await initSockets();
}
async function init() {
    await security.init();
    general.init();
    wifi.init();
    somfy.init();
    mqtt.init();
    firmware.init();
    somfy.setStep('freq', 1);
    somfy.setStep('bandwidth', 1);
    somfy.setStep('deviation', 1);

    bindNavigation();
    if (typeof ui !== 'undefined' && !ui.isConfigOpen()) {
        const hBtn = document.querySelector('.nav-item[data-grpid="divHomePnl"]');
        if (hBtn) syncNavigationState('divHomePnl');
    }
    // Deep link: restore the panel named in the URL hash (bookmark / reload / back).
    if (location.hash.length > 1) navApplyHash();
}
class UIBinder {
    setValue(el, val) {
        if (el instanceof HTMLInputElement) {
            switch (el.type.toLowerCase()) {
                case 'checkbox':
                    el.checked = makeBool(val);
                    break;
                case 'range':
                    let dt = el.getAttribute('data-datatype');
                    let mult = parseInt(el.getAttribute('data-mult') || 1, 10);
                    switch (dt) {
                        // We always range with integers
                        case 'float':
                            el.value = Math.round(parseInt(val * mult, 10));
                            break;
                        case 'index':
                            let ivals = JSON.parse(el.getAttribute('data-values'));
                            for (let i = 0; i < ivals.length; i++) {
                                if (ivals[i].toString() === val.toString()) {
                                    el.value = i;
                                    break;
                                }
                            }
                            break;
                        default:
                            el.value = parseInt(val, 10) * mult;
                            break;
                    }
                    break;
                        default:
                            el.value = val;
                            break;
            }
        }
        else if (el instanceof HTMLSelectElement) {
            let ndx = 0;
            for (let i = 0; i < el.options.length; i++) {
                let opt = el.options[i];
                if (opt.value === val.toString()) {
                    ndx = i;
                    break;
                }
            }
            el.selectedIndex = ndx;
        }
        else if (el instanceof HTMLElement) el.innerHTML = val;
    }
    getValue(el, defVal) {
        let val = defVal;
        if (el instanceof HTMLInputElement) {
            switch (el.type.toLowerCase()) {
                case 'checkbox':
                    val = el.checked;
                    break;
                case 'range':
                    let dt = el.getAttribute('data-datatype');
                    let mult = parseInt(el.getAttribute('data-mult') || 1, 10);
                    switch (dt) {
                        // We always range with integers
                        case 'float':
                            val = parseInt(el.value, 10) / mult;
                            break;
                        case 'index':
                            let ivals = JSON.parse(el.getAttribute('data-values'));
                            val = ivals[parseInt(el.value, 10)];
                            break;
                        default:
                            val = parseInt(el.value / mult, 10);
                            break;
                    }
                    break;
                        default:
                            val = el.value;
                            break;
            }
        }
        else if (el instanceof HTMLSelectElement) val = el.value;
        else if (el instanceof HTMLElement) val = el.innerHTML;
        return val;
    }
    toElement(el, val) {
        let flds = el.querySelectorAll('*[data-bind]');
        flds.forEach((fld) => {
            let prop = fld.getAttribute('data-bind');
            let arr = prop.split('.');
            let tval = val;
            for (let i = 0; i < arr.length; i++) {
                var s = arr[i];
                if (typeof s === 'undefined' || !s) continue;
                let ndx = s.indexOf('[');
                if (ndx !== -1) {
                    ndx = parseInt(s.substring(ndx + 1, s.indexOf(']') - 1), 10);
                    s = s.substring(0, ndx - 1);
                }
                tval = tval[s];
                if (typeof tval === 'undefined') break;
                if (ndx >= 0) tval = tval[ndx];
            }
            if (typeof tval !== 'undefined') {
                if (typeof fld.val === 'function') this.val(tval);
                else {
                    switch (fld.getAttribute('data-fmttype')) {
                        case 'time':
                        {
                            var dt = new Date();
                            dt.setHours(0, 0, 0);
                            dt.addMinutes(tval);
                            tval = dt.fmt(fld.getAttribute('data-fmtmask'), fld.getAttribute('data-fmtempty') || '');
                        }
                        break;
                        case 'date':
                        case 'datetime':
                        {
                            let dt = new Date(tval);
                            tval = dt.fmt(fld.getAttribute('data-fmtmask'), fld.getAttribute('data-fmtempty') || '');
                        }
                        break;
                        case 'number':
                            if (typeof tval !== 'number') tval = parseFloat(tval);
                            tval = tval.fmt(fld.getAttribute('data-fmtmask'), fld.getAttribute('data-fmtempty') || '');
                        break;
                        case 'duration':
                            tval = ui.formatDuration(tval, $this.attr('data-fmtmask'));
                            break;
                    }
                    this.setValue(fld, tval);
                }
            }
        });
    }
    fromElement(el, obj, arrayRef) {
        if (typeof arrayRef === 'undefined' || arrayRef === null) arrayRef = [];
        if (typeof obj === 'undefined' || obj === null) obj = {};
        if (typeof el.getAttribute('data-bind') !== 'undefined') this._bindValue(obj, el, this.getValue(el), arrayRef);
        let flds = el.querySelectorAll('*[data-bind]');
        flds.forEach((fld) => {
            if (!makeBool(fld.getAttribute('data-setonly')))
                this._bindValue(obj, fld, this.getValue(fld), arrayRef);
        });
        return obj;
    }
    parseNumber(val) {
        if (val === null) return;
        if (typeof val === 'undefined') return val;
        if (typeof val === 'number') return val;
        if (typeof val.getMonth === 'function') return val.getTime();
        var tval = val.replace(/[^0-9\.\-]+/g, '');
        return tval.indexOf('.') !== -1 ? parseFloat(tval) : parseInt(tval, 10);
    }
    _bindValue(obj, el, val, arrayRef) {
        var binding = el.getAttribute('data-bind');
        var dataType = el.getAttribute('data-datatype');
        if (binding && binding.length > 0) {
            var sRef = '';
            var arr = binding.split('.');
            var t = obj;
            for (var i = 0; i < arr.length - 1; i++) {
                let s = arr[i];
                if (typeof s === 'undefined' || s.length === 0) continue;
                sRef += '.' + s;
                var ndx = s.lastIndexOf('[');
                if (ndx !== -1) {
                    var v = s.substring(0, ndx);
                    var ndxEnd = s.lastIndexOf(']');
                    var ord = parseInt(s.substring(ndx + 1, ndxEnd), 10);
                    if (isNaN(ord)) ord = 0;
                    if (typeof arrayRef[sRef] === 'undefined') {
                        if (typeof t[v] === 'undefined') {
                            t[v] = new Array();
                            t[v].push(new Object());
                            t = t[v][0];
                            arrayRef[sRef] = ord;
                        }
                        else {
                            k = arrayRef[sRef];
                            if (typeof k === 'undefined') {
                                a = t[v];
                                k = a.length;
                                arrayRef[sRef] = k;
                                a.push(new Object());
                                t = a[k];
                            }
                            else
                                t = t[v][k];
                        }
                    }
                    else {
                        k = arrayRef[sRef];
                        if (typeof k === 'undefined') {
                            a = t[v];
                            k = a.length;
                            arrayRef[sRef] = k;
                            a.push(new Object());
                            t = a[k];
                        }
                        else
                            t = t[v][k];
                    }
                }
                else if (typeof t[s] === 'undefined') {
                    t[s] = new Object();
                    t = t[s];
                }
                else
                    t = t[s];
            }
            if (typeof dataType === 'undefined') dataType = 'string';
            t[arr[arr.length - 1]] = this.parseValue(val, dataType);
        }
    }
    parseValue(val, dataType) {
        switch (dataType) {
            case 'int':
                return Math.floor(this.parseNumber(val));
            case 'uint':
                return Math.abs(this.parseNumber(val));
            case 'float':
            case 'real':
            case 'double':
            case 'decimal':
            case 'number':
                return this.parseNumber(val);
            case 'date':
                if (typeof val === 'string') return Date.parseISO(val);
                else if (typeof val === 'number') return new Date(number);
                else if (typeof val.getMonth === 'function') return val;
                return undefined;
            case 'time':
                var dt = new Date();
                if (typeof val === 'number') {
                    dt.setHours(0, 0, 0);
                    dt.addMinutes(tval);
                    return dt;
                }
                else if (typeof val === 'string' && val.indexOf(':') !== -1) {
                    var n = val.lastIndexOf(':');
                    var min = this.parseNumber(val.substring(n));
                    var nsp = val.substring(0, n).lastIndexOf(' ') + 1;
                    var hrs = this.parseNumber(val.substring(nsp, n));
                    dt.setHours(0, 0, 0);
                    if (hrs <= 12 && val.substring(n).indexOf('p')) hrs += 12;
                    dt.addMinutes(hrs * 60 + min);
                    return dt;
                }
                break;
            case 'duration':
                if (typeof val === 'number') return val;
                return Math.floor(this.parseNumber(val));
            default:
                return val;
        }
    }
    formatValue(val, dataType, fmtMask, emptyMask) {
        var v = this.parseValue(val, dataType);
        if (typeof v === 'undefined') return emptyMask || '';
        switch (dataType) {
            case 'int':
            case 'uint':
            case 'float':
            case 'real':
            case 'double':
            case 'decimal':
            case 'number':
                return v.fmt(fmtMask, emptyMask || '');
            case 'time':
            case 'date':
            case 'dateTime':
                return v.fmt(fmtMask, emptyMask || '');
        }
        return v;
    }
    waitMessage(el, label) {
        let div = document.createElement('div');
        div.innerHTML = '<div class="lds-roller"><div></div><div></div><div></div><div></div><div></div><div></div><div></div><div></div></div>'
            + (label ? `<div class="wait-label">${label}</div>` : '');
        div.classList.add('wait-overlay');
        if (label) div.classList.add('has-label');
        if (typeof el === 'undefined') el = get('divContainer');
        el.appendChild(div);
        return div;
    }
    serviceError(el, err) {
        let title = tr('ERR_SERVICE_TITLE');
        if (arguments.length === 1) {
            err = el;
            el = get('divContainer');
        }
        let msg = '';
        if (typeof err === 'string' && err.startsWith('{')) {
            let e = JSON.parse(err);
            if (typeof e !== 'undefined' && typeof e.desc === 'string') msg = e.desc;
            else msg = err;
        }
        else if (typeof err === 'string') msg = err;
        else if (typeof err !== 'undefined' && typeof err === 'object') {
            if (typeof err.desc === 'string') {
                msg = typeof err.desc !== 'undefined' ? err.desc : err.message;
                if (typeof err.code === 'number') {
                    let e = errors.find(x => x.code === err.code) || { code: err.code, desc: 'Unspecified error' };
                    msg = e.desc;
                    title = err.desc;
                }
            }
        }
        if(DBG) console.log(err);
        let div = this.errorMessage(title);
        let sub = div.querySelector('.sub-message');
        // Plain-language message first; the endpoint + HTTP code stays available but demoted
        // to a "technical details" line so hobbyist users are not greeted with raw jargon.
        const svc = (err && typeof err === 'object' && err.service)
            ? `${err.service} (${err.htmlError || 500})`
            : (typeof err === 'number' ? `HTTP ${err}` : '');
        sub.innerHTML = `<div style="font-size:22px;">${msg || tr('ERR_SERVICE_DESC')}</div>`
            + (svc ? `<div class="service-detail"><label>${tr('ERR_SERVICE_DETAILS')} :</label> ${svc}</div>` : '');
        return div;
    }
    socketError(el, msg) {
        if (arguments.length === 1) {
            msg = el;
            el = get('divContainer');
        }
        let existing = document.querySelector('.socket-error');
        if (existing) {
            return existing;
        }
        let div = document.createElement('div');
        div.innerHTML = `<div id="divSocketAttempts" class="socketAttempts"><span>${tr('ERR_SOCKET_ATTEMPTS')}</span><span id="spanSocketAttempts"></span></div><div class="inner-error"><div>${tr('ERR_SOCKET_CONNECT')}</div><hr><div style="font-size:.7em">${msg}</div></div>`;
        div.classList.add('error-message');
        div.classList.add('socket-error');
        div.classList.add('modal-overlay');
        el.appendChild(div);
        openDialog(div);
        return div;
    }
    errorMessage(el, msg) {
        this.clearErrors();
        if (arguments.length === 1) {
            msg = el;
            el = get('divContainer');
        }
        let div = document.createElement('div');
        div.innerHTML = `<div class="error-content"><div class="inner-error">${msg}</div><div class="sub-message"></div><button type="button" onclick="ui.clearErrors();">${tr('BT_CLOSE')}</button></div>`;
        div.classList.add('error-message', 'modal-overlay');
        el.appendChild(div);
        openDialog(div);
        return div;
    }
    promptMessage(el, msg, onYes) {
        if (arguments.length === 2) {
            onYes = msg;
            msg = el;
            el = get('divContainer');
        }
        let div = document.createElement('div');
        div.className = 'prompt-message modal-overlay';
        div.innerHTML = `<div class="message-content"><div class="prompt-text">${msg}</div><div class="sub-message"></div>
        <div class="button-container-row"><button line type="button" onclick="ui.clearErrors();">${tr('BT_NO')}</button><button id="btnYes" type="button">${tr('BT_YES')}</button></div></div>`;
        el.appendChild(div);

        openDialog(div);
        div.querySelector('#btnYes').onclick = () => {
            if (typeof onYes === 'function') onYes();
            ui.clearErrors();
        };
        return div;
    }
    infoMessage(el, msg, onOk) {
        if (arguments.length === 1) {
            onOk = msg;
            msg = el;
            el = get('divContainer');
        }
        let div = document.createElement('div');
        div.innerHTML = `<div class="message-content"><div class="info-text">${msg}</div><div class="sub-message"></div><div class="button-container-row"><button id="btnOk" type="button">${tr('BT_OK')}</button></div></div>`;
        div.classList.add('info-message', 'modal-overlay');
        el.appendChild(div);
        openDialog(div);

        const btnOk = div.querySelector('#btnOk');
        if (typeof onOk === 'function') {
            btnOk.addEventListener('click', onOk);
        } else {
            btnOk.addEventListener('click', () => closeOverlay(div));
        }
        return div;
    }
    clearErrors() {
        let errors = document.querySelectorAll('div.modal-overlay');
        errors.forEach((el) => {
            closeDialog(el);
            el.classList.add('overlay-exit');
        });
        if (errors.length > 0) {
            setTimeout(() => {
                errors.forEach(el => el.remove());
            }, 300);
        }
    }
    successMessage(msg) {
        this.clearErrors();
        let el = get('divContainer');

        let div = document.createElement('div');
        div.innerHTML = `<div class="success-content"><svg class="icon-svg"><use href="#svg-succes"></use></svg><span>${msg}</span></div>`;

        div.classList.add('success-toast');
        el.appendChild(div);

        setTimeout(() => {
            div.classList.add('hide');
            setTimeout(() => {
                if (div.parentNode) div.remove();
            }, 400);

        }, 3500);
        return div;
    }
    toggleExpertMode(el) {
        this.isExpertMode = !this.isExpertMode;
        localStorage.setItem('expertMode', this.isExpertMode);

        if (el) {
            el.classList.toggle('is-expert', this.isExpertMode);
            if (!this.isExpertMode) {
                this.wizSetStep(el, this.wizCurrentStep(el));
            }
        }
    }
    /**Draws the user's attention to one particular element
     * @param {string|HTMLElement} target - element id, or the element itself
     * @param {boolean} activate - turn the animation on or off
     * @param {string} color - explicit colour (e.g. 'red', '#FFA500')
     */
    setFocus(target, activate = true, color = null) {
        let el = (typeof target === 'string') ? document.getElementById(target) : target;
        if (!el) return;
        if (el.tagName === 'BUTTON' && el.classList.contains('unibutton')) {
            el = el.closest('.unibloc') || el;
        }
        if (activate) {
            if (color) el.style.setProperty('--pulse-color', color);
            el.classList.add('ui-pulse');
        } else {
            el.classList.remove('ui-pulse');
            el.style.removeProperty('--pulse-color');
        }
    }
    selectTab(elTab) {
        const groupId = elTab.getAttribute('data-grpid');
        if (!groupId) return;

        const siblings = elTab.parentElement.querySelectorAll('span, a');
        for (let sibling of siblings) {
            sibling.classList.remove('selected', 'active');

            let sid = sibling.getAttribute('data-grpid');
            if (sid && sid !== groupId) {
                let section = get(sid);
                if (section) section.style.display = 'none';
            }
        }
        elTab.classList.add(elTab.classList.contains('sub-nav-item') ? 'active' : 'selected');

        const targetSection = get(groupId);
        if (targetSection) targetSection.style.display = '';
    }
    wizSetPrevStep(el) { this.wizSetStep(el, Math.max(this.wizCurrentStep(el) - 1, 1)); }
    wizSetNextStep(el) { this.wizSetStep(el, this.wizCurrentStep(el) + 1); }
    wizSetStep(el, step) {
        let curr = this.wizCurrentStep(el);
        let sStep = step.toString();
        const isExpert = el.classList.contains('is-expert');

        el.setAttribute('data-stepid', step);
        el.querySelectorAll('[data-stepid], [data-ustepid], [data-mstepid]').forEach(item => {
            if (item.classList.contains('stepper-item')) return;
            if (item === el) return;

            let show = true;

            if (isExpert) {
                show = item.hasAttribute('data-expert');
            }
            else {
                if (item.hasAttribute('data-stepid')) {
                    show = item.getAttribute('data-stepid') === sStep;
                }
                else if (item.hasAttribute('data-ustepid')) {
                    show = item.getAttribute('data-ustepid') !== sStep;
                }
                else if (item.hasAttribute('data-mstepid')) {
                    let steps = item.getAttribute('data-mstepid').split(',');
                    show = steps.includes(sStep);
                }
            }
            item.style.display = show ? '' : 'none';
        });
        if (curr !== step) {
            let evt = new CustomEvent('stepchanged', { detail: { oldStep: curr, newStep: step }, bubbles: true });
            el.dispatchEvent(evt);
        }
    }
    wizCurrentStep(el) { return parseInt(el.getAttribute('data-stepid') || 1, 10); }
    pinKeyPressed(evt) {
        let el = evt.target || evt.srcElement;
        let parent = el.parentElement;
        let digits = Array.from(parent.querySelectorAll('.pin-digit'));
        let index = digits.indexOf(el);
        switch (evt.key) {
            case 'Backspace':
                if (el.value === '' && index > 0) digits[index - 1].focus();
                return;
            case 'ArrowLeft':
                if (index > 0) digits[index - 1].focus();
                return;
            case 'ArrowRight':
                if (index < digits.length - 1) digits[index + 1].focus();
                return;
            case 'Enter':
                // Only the login screen submits on Enter; the security settings PIN must not.
                if (typeof security !== 'undefined' && el.closest('#divUnauthenticated')) security.login();
                return;
        }
        setTimeout(() => {
            if (el.value.length > 1) el.value = el.value.slice(-1);
            if (el.value !== "" && index < digits.length - 1) {
                digits[index + 1].focus();
            }
            const pin = digits.map(d => d.value).join('');
            if (pin.length === 4 && typeof security !== 'undefined' && el.closest('#divUnauthenticated')) {
                security.login();
            }
        }, 20);
    }
    pinDigitFocus(evt) {
        evt.srcElement.select();
    }
    // Spread a pasted PIN (e.g. from a password manager) across the digit boxes.
    pinPasted(evt) {
        const clip = (evt.clipboardData || window.clipboardData);
        if (!clip) return;
        const digitsOnly = clip.getData('text').replace(/\D/g, '');
        if (!digitsOnly) return;
        evt.preventDefault();
        const digits = Array.from(evt.currentTarget.querySelectorAll('.pin-digit'));
        digits.forEach((d, i) => d.value = digitsOnly[i] || '');
        const last = Math.min(digitsOnly.length, digits.length) - 1;
        if (last >= 0) digits[last].focus();
        if (digitsOnly.length >= digits.length && typeof security !== 'undefined' && digits[0].closest('#divUnauthenticated')) security.login();
    }
    isConfigOpen() { return window.getComputedStyle(get('divConfigPnl')).display !== 'none'; }
    setConfigPanel() {
        if (this.isConfigOpen()) return;
        let divCfg = get('divConfigPnl');
        let divHome = get('divHomePnl');
        divHome.style.display = 'none';
        divCfg.style.display = '';
        somfy.checkEmptyState();
        document.querySelector('#btnConfig use').setAttribute('href', '#svg-tabHome');

        if (sockIsOpen) socket.send('join:0' + (security.apiKey ? ':' + security.apiKey : ''));
        let overlay = ui.waitMessage(get('divSecurityOptions'));
        overlay.style.borderRadius = '5px';
        getJSON('/getSecurity', (err, security) => {
            overlay.remove();
            if (err) ui.serviceError(err);
            else {
                //console.log(security);
                general.setSecurityConfig(security);
            }
        });
    }
    setHomePanel() {
        if (!this.isConfigOpen()) return;
        let divCfg = get('divConfigPnl');
        let divHome = get('divHomePnl');
        divHome.style.display = '';
        divCfg.style.display = 'none';
        somfy.checkEmptyState();
        document.querySelector('#btnConfig use').setAttribute('href', '#svg-tabSettings');
        if (sockIsOpen) socket.send('leave:0');
        general.setSecurityConfig({ type: 0, username: '', permissions: 0 });
        navUpdateHash('divHomePnl');
    }
    toggleConfig() {
        if (this.isConfigOpen())
            this.setHomePanel();
        else {
            if (!security.authenticated && security.type !== 0) {
                get('divContainer').addEventListener('afterlogin', (evt) => {
                    if (security.authenticated) this.setConfigPanel();
                }, { once: true });
                    security.authUser();
            }
            else this.setConfigPanel();
        }
        somfy.showEditShade(false);
        somfy.showEditGroup(false);
    }
    showNetworkConfig() {
        this.setConfigPanel();
        const tab = document.querySelector('.tab-container [data-grpid="divNetworkSettings"]');
        if (tab) {
            this.selectTab(tab);
            if (typeof wifi !== 'undefined') wifi.loadNetwork();
        }
    }
    showRadioConfig() {
        this.setConfigPanel();
        const tab = document.querySelector('.tab-container [data-grpid="divRadioSettings"]');
        if (tab) this.selectTab(tab);
    }
    showSystemConfig() {
        this.setConfigPanel();
        const tab = document.querySelector('.tab-container [data-grpid="divSystemSettings"]');
        if (tab) this.selectTab(tab);
    }
    showShadeConfig() {
        this.setConfigPanel();
        const parentTab = document.querySelector('.tab-container [data-grpid="divSomfySettings"]');
        if (parentTab) this.selectTab(parentTab);
        const motorTab = document.querySelector('.subtab-container [data-grpid="divSomfyMotors"]');
        if (motorTab) this.selectTab(motorTab);
        if (typeof somfy !== 'undefined') {
            somfy.showEditShade(true);
            somfy.openEditShade();
        }
    }
}
var ui = new UIBinder();
class Security {
    type = 0;
    authenticated = false;
    apiKey = '';
    permissions = 0;
    async init() {
        await this.loadContext();
        if (this.type === 0 || (this.permissions & 0x01) === 0x01) { // No login required or only the config is protected.
            if (typeof socket === 'undefined' || !socket) (async () => { await initSockets(); })();
            //ui.setMode(mode);
            get('divUnauthenticated').style.display = 'none';
            get('divAuthenticated').style.display = '';
            document.body.setAttribute('data-auth', true);
        }
    }
    async loadContext() {
        const pnl = get('divUnauthenticated');
        if (!pnl) return;

        // Cached lookup of the login elements
        const qs = (s) => pnl.querySelector(s);
        const btn = qs('#loginButtons'), pwd = qs('#divLoginPassword'), pin = qs('#divLoginPin');
        pnl.style.display = btn.style.display = pwd.style.display = pin.style.display = 'none';

        return new Promise(res => {
            loadLang(() => {
                getJSONBusy('/loginContext', (err, ctx) => {
                    if (err) return ui.serviceError(err), res();

                    // Uptime & Info CPU
                    if (ctx.uptime) displayUptime(ctx.uptime, 'uptime-display');
                    if (ctx.netUptime) displayUptime(ctx.netUptime, 'net-display');
                    if (ctx.cpuFreq) get('info-cpu').textContent = `${ctx.cores > 1 ? 'Dual' : 'Single'}-Core @ ${ctx.cpuFreq} ${tr('MHZ')}`;
                    // Flash & FileSystem (grouped)
                    if (ctx.flashSize) {
                        get('info-flash').innerHTML = `<span>${tr('FW_TOTAL')}: </span><span class="status-detail">${ctx.flashSize}</span> Mo (<span class="hide550">${tr('FW_SPEED')}: </span><span class="status-detail">${ctx.flashSpeed}</span> ${tr('MHZ')})`;
                    }
                    if (ctx.fsTotal) {
                        const free = ctx.fsTotal - ctx.fsUsed, pct = Math.round((ctx.fsUsed / ctx.fsTotal) * 100);
                        const el = get('info-fs-status');
                        if (el) el.innerHTML = `<span class="status-detail">${free}</span> ${tr('FW_UNIT_KO')} ${tr('FW_FREE_SUFFIX')}<span class="hide550"> ${tr('FW_ON')} <span class="status-detail">${ctx.fsTotal}</span></span>`;
                        const elP = get('info-fs-pct');
                        if (elP) elP.innerHTML = `${tr('FW_USED_AT')} <span class="status-detail">${pct}</span>%`;
                    }
                    // Real OTA slot size, used to gate GitHub updates on the actual
                    // partition layout rather than the version number.
                    if (ctx.otaSize) get('divContainer').setAttribute('data-otasize', ctx.otaSize);
                    // MAC Addresses
                    if (ctx.mac) document.querySelectorAll('.spanMacAddress').forEach(el => el.textContent = ctx.mac);

                    this.type = ctx.type;
                    this.permissions = ctx.permissions;

                    const cont = get('divContainer');
                    if (cont) cont.setAttribute('data-securitytype', ctx.type);
                    // Login handling
                    if (ctx.type !== 0) {
                        btn.style.display = '';
                        const fld = ctx.type === 1 ? qs('.pin-digit[data-bind="login.pin.d0"]') : qs('#fldLoginUsername');
                        const targetDiv = ctx.type === 1 ? pin : pwd;

                        targetDiv.style.display = '';
                        if (fld) setTimeout(() => fld.focus(), 100);

                        const typeFld = qs('#fldLoginType');
                        if (typeFld) typeFld.value = ctx.type;
                        pnl.style.display = 'flex';
                    }
                    res();
                });
            });
        });
    }
    authUser() {
        const auth = get('divAuthenticated');
        const pnl = get('divUnauthenticated');
        if (auth.style.display !== 'none') {
            // The app is already on screen (ConfigOnly): show the login as a modal
            // over the current context instead of swapping the whole screen.
            pnl.classList.add('login-modal');
        } else {
            auth.style.display = 'none';
            document.body.setAttribute('data-auth', false);
        }
        pnl.style.display = '';
        this.loadContext();
        get('btnCancelLogin').style.display = 'inline-block';
    }
    cancelLogin() {
        this._loginShown = false;
        let evt = new CustomEvent('afterlogin', { detail: { authenticated: this.authenticated } });
        get('divAuthenticated').style.display = '';
        get('divUnauthenticated').style.display = 'none';
        get('divUnauthenticated').classList.remove('login-modal');
        // Back to the ConfigOnly app view: the sidebar comes back even without a session.
        document.body.setAttribute('data-auth', true);
        get('divContainer').dispatchEvent(evt);
    }
    // A config-protected call returned 401 while we hold no valid session (e.g. under
    // ConfigOnly the app shows without a login, but the network/MQTT panels still need
    // auth). Send the user to the login screen once; the _loginShown guard swallows the
    // concurrent 401s the panel auto-loads fire. Returns true when handled so the caller
    // stays quiet. type 0 = no auth; already authenticated => let the caller surface it.
    promptLoginOn401() {
        if (this.type === 0 || this.authenticated) return false;
        if (this._loginShown) return true;
        this._loginShown = true;
        this.authUser();
        return true;
    }
    login() {
        if(DBG) console.log('Logging in...');
        let pnl = get('divUnauthenticated');
        let msg = pnl.querySelector('#spanLoginMessage');
        msg.innerHTML = '';
        let sec = ui.fromElement(pnl).login;
        let pin = '';
        switch (sec.type) {
            case 1:
                for (let i = 0; i < 4; i++) {
                    pin += sec.pin[`d${i}`];
                }
                if (pin.length !== 4) return;
                break;
            case 2:
                break;
        }
        sec.pin = pin;
        putJSONBusy('/login', sec, (err, log) => {
            if (err) ui.serviceError(err);
            else {
                if (log.success) {
                    if (typeof socket === 'undefined' || !socket) (async () => { await initSockets(); })();

                    get('divUnauthenticated').style.display = 'none';
                    get('divUnauthenticated').classList.remove('login-modal');
                    get('divAuthenticated').style.display = '';
                    document.body.setAttribute('data-auth', true);
                    this.apiKey = log.apiKey;
                    this.authenticated = true;
                    this._loginShown = false;
                    let evt = new CustomEvent('afterlogin', { detail: { authenticated: true } });
                    get('divContainer').dispatchEvent(evt);
                }
                else {
                    msg.innerHTML = tr(log.msg);
                    // Wrong PIN: clear the digits and refocus the first one for an immediate retry.
                    const digits = pnl.querySelectorAll('#divLoginPin .pin-digit');
                    if (digits.length) { digits.forEach(d => d.value = ''); digits[0].focus(); }
                }
            }
        });
    }
    toggleFieldPassword(fieldId, el) {
        const fld = get(fieldId);
        const ico = el.querySelector('use');

        if (fld.type === 'password') {
            fld.type = 'text';
            if(ico) ico.setAttribute('href', '#svg-eyeOn');
        } else {
            fld.type = 'password';
            if(ico) ico.setAttribute('href', '#icon-eyeOff');
        }
    }
}
var security = new Security();
class General {
    initialized = false;
    appVersion = 'v3.1.0';
    reloadApp = false;
    init() {
        if (this.initialized) return;

        const savedTheme = localStorage.getItem('themeMode') || '0';
        this.applyTheme(savedTheme);
        const savedColor = localStorage.getItem('accentColor');
        if (savedColor) {
            document.documentElement.style.setProperty('--accent-color', savedColor);
        }
        this.setAppVersion();
        this.setTimeZones();
        if (sockIsOpen && ui.isConfigOpen()) socket.send('join:0' + (security.apiKey ? ':' + security.apiKey : ''));
        ui.toElement(get('divSystemSettings'), {
            general: { hostname: 'ESPSomfyRTS', username: '', password: '', posixZone: 'UTC0', ntpServer: 'pool.ntp.org' }
        });

        this.initialized = true;
    }
    applyTheme(val) {
        if (val === '1') {
            document.documentElement.setAttribute('data-theme', 'dark');
        } else if (val === '2') {
            document.documentElement.setAttribute('data-theme', 'light');
        } else {
            const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
        }
        const sel = get('selThemeMode');
        if (sel) sel.value = val;
    }
    onModeThemeChanged() {
        const sel = get('selThemeMode');
        const val = sel.value;
        localStorage.setItem('themeMode', val);
        this.applyTheme(val);
    }
    getCookie(cname) {
        let n = cname + '=';
        let cookies = document.cookie.split(';');
        if(DBG) console.log(cookies);
        for (let i = 0; i < cookies.length; i++) {
            let c = cookies[i];
            while (c.charAt(0) === ' ') c = c.substring(0);
            if (c.indexOf(n) === 0) return c.substring(n.length, c.length);
        }
        return '';
    }
    reload() {
        let addMetaTag = (name, content) => {
            let meta = document.createElement('meta');
            meta.httpEquiv = name;
            meta.content = content;
            document.getElementsByTagName('head')[0].appendChild(meta);
        };
        addMetaTag('pragma', 'no-cache');
        addMetaTag('expires', '0');
        addMetaTag('cache-control', 'no-cache');
        document.location.reload();
    }
    timeZones = [
        "Africa/Cairo|EET-2",
        "Africa/Johannesburg|SAST-2",
        "Africa/Juba|CAT-2",
        "Africa/Lagos|WAT-1",
        "Africa/Mogadishu|EAT-3",
        "Africa/Tunis|CET-1",
        "America/Adak|HST10HDT,M3.2.0,M11.1.0",
        "America/Anchorage|AKST9AKDT,M3.2.0,M11.1.0",
        "America/Asuncion|<-04>4<-03>,M10.1.0/0,M3.4.0/0",
        "America/Bahia_Banderas|CST6CDT,M4.1.0,M10.5.0",
        "America/Barbados|AST4",
        "America/Bermuda|AST4ADT,M3.2.0,M11.1.0",
        "America/Cancun|EST5",
        "America/Central_Time|CST6CDT,M3.2.0,M11.1.0",
        "America/Chihuahua|MST7MDT,M4.1.0,M10.5.0",
        "America/Eastern_Time|EST5EDT,M3.2.0,M11.1.0",
        "America/Godthab|<-03>3<-02>,M3.5.0/-2,M10.5.0/-1",
        "America/Havana|CST5CDT,M3.2.0/0,M11.1.0/1",
        "America/Mexico_City|CST6",
        "America/Miquelon|<-03>3<-02>,M3.2.0,M11.1.0",
        "America/Mountain_Time|MST7MDT,M3.2.0,M11.1.0",
        "America/Pacific_Time|PST8PDT,M3.2.0,M11.1.0",
        "America/Phoenix|MST7",
        "America/Santiago|<-04>4<-03>,M9.1.6/24,M4.1.6/24",
        "America/St_Johns|NST3:30NDT,M3.2.0,M11.1.0",
        "Antarctica/Troll|<+00>0<+02>-2,M3.5.0/1,M10.5.0/3",
        "Asia/Amman|EET-2EEST,M2.5.4/24,M10.5.5/1",
        "Asia/Beirut|EET-2EEST,M3.5.0/0,M10.5.0/0",
        "Asia/Colombo|<+0530>-5:30",
        "Asia/Damascus|EET-2EEST,M3.5.5/0,M10.5.5/0",
        "Asia/Gaza|EET-2EEST,M3.4.4/50,M10.4.4/50",
        "Asia/Hong_Kong|HKT-8",
        "Asia/Jakarta|WIB-7",
        "Asia/Jayapura|WIT-9",
        "Asia/Jerusalem|IST-2IDT,M3.4.4/26,M10.5.0",
        "Asia/Kabul|<+0430>-4:30",
        "Asia/Karachi|PKT-5",
        "Asia/Kathmandu|<+0545>-5:45",
        "Asia/Kolkata|IST-5:30",
        "Asia/Makassar|WITA-8",
        "Asia/Manila|PST-8",
        "Asia/Seoul|KST-9",
        "Asia/Shanghai|CST-8",
        "Asia/Tehran|<+0330>-3:30",
        "Asia/Tokyo|JST-9",
        "Atlantic/Azores|<-01>1<+00>,M3.5.0/0,M10.5.0/1",
        "Australia/Adelaide|ACST-9:30ACDT,M10.1.0,M4.1.0/3",
        "Australia/Brisbane|AEST-10",
        "Australia/Darwin|ACST-9:30",
        "Australia/Eucla|<+0845>-8:45",
        "Australia/Lord_Howe|<+1030>-10:30<+11>-11,M10.1.0,M4.1.0",
        "Australia/Melbourne|AEST-10AEDT,M10.1.0,M4.1.0/3",
        "Australia/Perth|AWST-8",
        "Etc/GMT-1|<+01>-1",
        "Etc/GMT-2|<+02>-2",
        "Etc/GMT-3|<+03>-3",
        "Etc/GMT-4|<+04>-4",
        "Etc/GMT-5|<+05>-5",
        "Etc/GMT-6|<+06>-6",
        "Etc/GMT-7|<+07>-7",
        "Etc/GMT-8|<+08>-8",
        "Etc/GMT-9|<+09>-9",
        "Etc/GMT-10|<+10>-10",
        "Etc/GMT-11|<+11>-11",
        "Etc/GMT-12|<+12>-12",
        "Etc/GMT-13|<+13>-13",
        "Etc/GMT-14|<+14>-14",
        "Etc/GMT+0|GMT0",
        "Etc/GMT+1|<-01>1",
        "Etc/GMT+2|<-02>2",
        "Etc/GMT+3|<-03>3",
        "Etc/GMT+4|<-04>4",
        "Etc/GMT+5|<-05>5",
        "Etc/GMT+6|<-06>6",
        "Etc/GMT+7|<-07>7",
        "Etc/GMT+8|<-08>8",
        "Etc/GMT+9|<-09>9",
        "Etc/GMT+10|<-10>10",
        "Etc/GMT+11|<-11>11",
        "Etc/GMT+12|<-12>12",
        "Etc/UTC|UTC0",
        "Europe/Athens|EET-2EEST,M3.5.0/3,M10.5.0/4",
        "Europe/Berlin|CEST-1CET,M3.2.0/2:00:00,M11.1.0/2:00:00",
        "Europe/Brussels|CET-1CEST,M3.5.0,M10.5.0/3",
        "Europe/Chisinau|EET-2EEST,M3.5.0,M10.5.0/3",
        "Europe/Dublin|IST-1GMT0,M10.5.0,M3.5.0/1",
        "Europe/Lisbon|WET0WEST,M3.5.0/1,M10.5.0",
        "Europe/London|GMT0BST,M3.5.0/1,M10.5.0",
        "Europe/Moscow|MSK-3",
        "Europe/Paris|CET-1CEST-2,M3.5.0/02:00:00,M10.5.0/03:00:00",
        "Indian/Cocos|<+0630>-6:30",
        "Pacific/Auckland|NZST-12NZDT,M9.5.0,M4.1.0/3",
        "Pacific/Chatham|<+1245>-12:45<+1345>,M9.5.0/2:45,M4.1.0/3:45",
        "Pacific/Easter|<-06>6<-05>,M9.1.6/22,M4.1.6/22",
        "Pacific/Fiji|<+12>-12<+13>,M11.2.0,M1.2.3/99",
        "Pacific/Guam|ChST-10",
        "Pacific/Honolulu|HST10",
        "Pacific/Marquesas|<-0930>9:30",
        "Pacific/Midway|SST11",
        "Pacific/Norfolk|<+11>-11<+12>,M10.1.0,M4.1.0/3"
    ];
    loadGeneral() {
        const pnl = get('divSystemOptions');

        getJSONBusy('/modulesettings', (err, settings) => {
            if (err) {
                console.error(err);
                return;
            }
            if(DBG) console.log("Settings received:", settings);
            if (typeof somfy !== 'undefined') somfy.initPins();

            get('spanFwVersion').innerText = settings.fwVersion;
            get('spanHwVersion').innerText = settings.chipModel.length > 0 ? '-' + settings.chipModel : '';
            get('divContainer').setAttribute('data-chipmodel', settings.chipModel);

            this.setAppVersion();

            loadLang(() => {

                ui.toElement(pnl, { general: settings });

                const langSelect = get('langSelect');
                if (langSelect) {
                    const languages = [ 'en', 'fr', 'de', 'es', /*'it' */ ];
                    const selectedLang = languages[settings.language] || 'en';
                    localStorage.setItem('selectedLang', selectedLang);
                    document.documentElement.lang = selectedLang;
                    langSelect.value = selectedLang;
                    langSelect.onchange = (e) => {
                        this.onLanguageChanged(e.target.value);
                    };
                }
            });
            if (settings.accentColor) {
                document.documentElement.style.setProperty('--accent-color', settings.accentColor);
                localStorage.setItem('accentColor', settings.accentColor);

                const accentInput = get('fldAccentColor');
                if (accentInput) {
                    accentInput.value = settings.accentColor;
                    accentInput.addEventListener('input', (e) => {
                        document.documentElement.style.setProperty('--accent-color', e.target.value);
                        localStorage.setItem('accentColor', e.target.value);
                    });
                }
            }

        });
    }
    setAppVersion() { get('spanAppVersion').innerText = this.appVersion; }
    setTimeZones() {
        const dd = get('selTimeZone');
        dd.innerHTML = this.timeZones.map(tz => {
            const [city, code] = tz.split('|');
            return `<option value="${code}">${city}</option>`;
        }).join('');

        dd.value = 'UTC0';
    }
    setGeneral() {
        let valid = true;
        let pnl = get('divSystemSettings');
        let obj = ui.fromElement(pnl).general;
        const msg = tr('ERR_HOSTNAME');
        if (typeof obj.hostname === 'undefined' || !obj.hostname || obj.hostname === '') {
            ui.errorMessage(msg).querySelector('.sub-message').innerHTML = tr('ERR_INVALID_HOSTNAME');
            valid = false;
        }
        if (valid && !/^[a-zA-Z0-9-]+$/.test(obj.hostname)) {
            ui.errorMessage(msg).querySelector('.sub-message').innerHTML = tr('ERR_HOSTNAME_CHARS');
            valid = false;
        }
        if (valid && obj.hostname.length > 32) {
            ui.errorMessage(msg).querySelector('.sub-message').innerHTML = tr('ERR_HOSTNAME_LENGTH');
            valid = false;
        }
        if (valid && typeof obj.ntpServer === 'string' && obj.ntpServer.length > 64) {
            ui.errorMessage(msg).querySelector('.sub-message').innerHTML = tr('ERR_NTP_LENGTH');
            valid = false;
        }
        if (valid) {
            putJSONBusy('/setgeneral', obj, (err, response) => {
                if (err) {
                    ui.serviceError(err);
                } else {
                    ui.successMessage(tr('MSG_SAVE_SUCCESS'));
                    if(DBG) console.log(response);
                }
            });
        }
    }
    setSecurityConfig(security) {
        // The server no longer sends the secrets, only presence booleans.
        this.hasPassword = makeBool(security.hasPassword);
        this.hasPin = makeBool(security.hasPin);
        let obj = {
            security: {
                type: security.type, username: security.username, password: '', repeatpassword: '',
                permissions: { configOnly: makeBool(security.permissions & 0x01) },
                pin: { d0: '', d1: '', d2: '', d3: '' }
            }
        };
        ui.toElement(get('divSecurityOptions'), obj);
        let fldPassword = get('fldPassword');
        if (fldPassword) fldPassword.placeholder = this.hasPassword ? tr('SECRET_SET_PLH') : tr('SECURITY_PASSWORD_PLH');
        get('divPinSecurity').querySelectorAll('.pin-digit').forEach((el) => { el.placeholder = this.hasPin ? '•' : ''; });
        this.onSecurityTypeChanged();
    }
    rebootDevice() {
        ui.promptMessage(get('divContainer'), tr('PROMPT_REBOOT_CONFIRM'), () => {
            putJSONBusy('/reboot', {}, (err, response) => {
                get('btnSaveGeneral').classList.remove('disabled');
                // Only drop the socket once the firmware accepted the reboot; a 401
                // (login prompt) or any other error must keep the live connection.
                if (!err) {
                    if (typeof socket !== 'undefined') socket.close(3000, 'reboot');
                    // Tell the user what is happening instead of a mute spinner, then
                    // reload once the device has had time to come back up.
                    ui.waitMessage(get('divContainer'), `${tr('GIT_RELEASE_SUCCES_1')}<br>${tr('GIT_RELEASE_SUCCES_2')}`);
                    setTimeout(() => window.location.reload(), 20000);
                }
                if(DBG) console.log(response);
            });
            ui.clearErrors();
        });
    }
    onLanguageChanged(lang, reload = true) {
        const sel = get('langSelect');
        if (sel) sel.disabled = true;
        localStorage.setItem('selectedLang', lang);

        fetch(baseUrl + '/setLang?lang=' + lang)
        .then(r => r.json())
        .then(resp => {
            if (resp.status === "ok") {
                if (reload) {
                    window.location.reload(true);
                } else {
                    if (sel) {
                        sel.value = lang;
                        sel.disabled = false;
                    }
                }
            }
        })
        .catch(err => {
            console.error("Language switch failed:", err);
            if (sel) sel.disabled = false;
        });
    }
    onModeThemeChanged() {
        const sel = get('selThemeMode');
        const val = sel.value;

        localStorage.setItem('themeMode', val);

        if (val === '1') {
            document.documentElement.setAttribute('data-theme', 'dark');
        } else if (val === '2') {
            document.documentElement.setAttribute('data-theme', 'light');
        } else {
            const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
        }
    }
    onSecurityTypeChanged() {
        let pnl = get('divSecurityOptions'),
        type = ui.fromElement(pnl).security.type,
        // [Permissions, Pin, Password] - Type (0, 1 ou 2)
        states = [
            ['none', 'none', 'none'],
            ['',     '',     'none'],
            ['',     'none', '']
        ][type];

        ['#divPermissions', '#divPinSecurity', '#divPasswordSecurity'].forEach((id, i) => {
            pnl.querySelector(id).style.display = states[i];
        });
    }
    saveSecurity() {
        const s = ui.fromElement(get('divSecurityOptions')).security;
        const pin = [0, 1, 2, 3].map(i => s.pin[`d${i}`]).join('');
        const data = {
            type: s.type, username: s.username,
            perm: s.permissions.configOnly ? 1 : 0,
            permissions: s.permissions.configOnly ? 0x01 : 0x00
        };
        // Only send the secrets the user actually typed; the firmware keeps
        // the stored ones when they are omitted or empty.
        if (s.password) data.password = s.password;
        if (pin) data.pin = pin;
        let confirmText = '';
        if (s.type === 1) {
            // An empty pin is allowed when one is already stored on the device.
            if (pin.length !== 4 && !(pin.length === 0 && this.hasPin)) return this.secError('ERR_PIN_INVALID', 'ERR_PIN_INVALID_DESC');
            confirmText = `<p>${tr('SAVESECURITY_PIN_WARNING')}</p><p>${tr('SAVESECURITY_PIN_CONFIRM')}</p>`;
        }
        else if (s.type === 2) {
            if (!s.username) return this.secError('ERR_USERNAME_MISSING', 'ERR_USERNAME_MISSING_DESC');
            if (!s.password && !this.hasPassword) return this.secError('ERR_PASSWORD_MISSING', 'ERR_PASSWORD_MISSING_DESC');
            if (s.password !== s.repeatpassword) return this.secError('ERR_PASSWORD_MISMATCH', 'ERR_PASSWORD_MISMATCH_DESC');
            confirmText = `<p>${tr('SAVESECURITY_PASSWORD_WARNING')}</p><p>${tr('SAVESECURITY_PASSWORD_CONFIRM')}</p>`;
        }
        const prompt = ui.promptMessage(tr('PROMPT_SECURITY_CONFIRM'), () => {
            putJSONBusy('/saveSecurity', data, (e, resp) => {
                prompt.remove();
                if (e) ui.serviceError(e);
                else {
                    // The token is derived from the credentials; adopt the new one first so
                    // the refresh below is sent with a valid session.
                    if (resp && typeof resp.apiKey !== 'undefined') security.apiKey = resp.apiKey;
                    // Refresh the panel so typed secrets are cleared from the DOM
                    // and the presence placeholders reflect the new state.
                    getJSON('/getSecurity', (err, sec) => { if (!err) this.setSecurityConfig(sec); });
                }
            });
        });
        prompt.querySelector('.sub-message').innerHTML = confirmText;
    }
    secError(title, desc) {
        ui.errorMessage(tr(title)).querySelector('.sub-message').innerHTML = tr(desc);
    }
    showHAOverlay() {
        const div = document.createElement('div');
        div.id = 'divHAConfig';
        div.className = 'inst-overlay';

        div.innerHTML = `
        <div class="instructions-content">
        <div class="overlay-scroll-content">
        ${overlayHeader(tr('HACS'), tr('HACS_DESC'), 'svg-homeAssistant')}
        <p><strong>${tr('HACS_PURPOSE_TITLE')}</strong></p>
        <p>${tr('HACS_PURPOSE_TEXT_1')}</p>
        <p>${tr('HACS_PURPOSE_TEXT_2')}</p>
        <p class="ha-section-title"><strong>${tr('HACS_INSTALL_TITLE')}</strong></p>
        <ol class="ha-install-list">
        <li>${tr('HACS_INSTALL_STEP_1')}</li>
        <li>${tr('HACS_INSTALL_STEP_2')}</li>
        <li>${tr('HACS_INSTALL_STEP_3')}</li>
        <li>${tr('HACS_INSTALL_STEP_4')}</li>
        </ol>
        <div class="warning ha-warning-note">
        <svg><use href="#svg-warning"></use></svg>
        <div>
        <span>
        ${tr('HACS_REQ_START')}
        <a href="https://www.home-assistant.io" target="_blank" style="color: inherit; text-decoration: underline;"><strong>Home Assistant</strong></a>
        ${tr('HACS_REQ_MID')}
        <a href="https://hacs.xyz" target="_blank" style="color: inherit; text-decoration: underline;"><strong>HACS</strong></a> ${tr('HACS_REQ_END')}
        </span>
        </div>
        </div>
        <div class="ha-badge-container">
        <a href="https://my.home-assistant.io/redirect/hacs_repository/?owner=Pulpyyyy&repository=ESPSomfy-RTS-enhanced&category=integration" target="_blank" class="ha-badge-button">
        <span class="ha-badge-text-main">Open HACS repository on</span>
        <span class="ha-badge-pill"><span class="ha-badge-text-pill">MY</span><svg width="18" height="18"><use href="#svg-homeAssistant"></use></svg></span>
        </a>
        <p class="ha-github-link-container">
        ${tr('HACS_OR_VISIT')} <a href="https://github.com/Pulpyyyy/ESPSomfy-RTS-enhanced" target="_blank" class="linkSoft">${tr('HACS_REPO_LINK')}</a>
        </p>
        </div>
        </div>
        <div class="hrDivFooter"></div>
         <div class="button-container-overlay">
        <button id="btnCloseHA" type="button" onclick="closeOverlay(get('divHAConfig'))">${tr('BT_CLOSE')}</button>
        </div>
        </div>`;

        shOverlay(div);
    }
}
var general = new General();

class Wifi {
    initialized = false;
    ethBoardTypes = [];
    ethClockModes = [];
    ethPhyTypes = [];

    init() {
        this.ethBoardTypes = [
            { val: 0, label: tr("MANUAL_SETTINGS") || "Configuration Manuelle" },
            { val: 1, label: 'WT32-ETH01 - Wireless Tag', clk: 0, ct: 0, addr: 1, pwr: 16, mdc: 23, mdio: 18 },
            { val: 7, label: 'EST-PoE-32 - Everything Smart', clk: 3, ct: 0, addr: 0, pwr: 12, mdc: 23, mdio: 18 },
            { val: 3, label: 'ESP32-EVB - Olimex', clk: 0, ct: 0, addr: 0, pwr: -1, mdc: 23, mdio: 18 },
            { val: 2, label: 'ESP32-POE - Olimex', clk: 3, ct: 0, addr: 0, pwr: 12, mdc: 23, mdio: 18 },
            { val: 4, label: 'T-Internet POE - LILYGO', clk: 3, ct: 0, addr: 0, pwr: 16, mdc: 23, mdio: 18 },
            { val: 5, label: 'wESP32 v7+ - Silicognition', clk: 0, ct: 2, addr: 0, pwr: -1, mdc: 16, mdio: 17 },
            { val: 6, label: 'wESP32 < v7 - Silicognition', clk: 0, ct: 0, addr: 0, pwr: -1, mdc: 16, mdio: 17 }
        ];
        this.ethClockModes = [
            { val: 0, label: 'GPIO0 IN' },
            { val: 1, label: 'GPIO0 OUT' },
            { val: 2, label: 'GPIO16 OUT' },
            { val: 3, label: 'GPIO17 OUT' }
        ];
        this.ethPhyTypes = [
            { val: 0, label: 'LAN8720' },
            { val: 1, label: 'TLK110' },
            { val: 2, label: 'RTL8201' },
            { val: 3, label: 'DP83848' },
            { val: 4, label: 'DM9051' },
            { val: 5, label: 'KZ8081' }
        ];

        const divStrength = get("divNetworkStrength");
        this.procWifiStrength({strength: -100, ssid: '', channel: -1});

        if (this.initialized) return;

        this.loadETHDropdown(get('selETHClkMode'), this.ethClockModes);
        this.loadETHDropdown(get('selETHPhyType'), this.ethPhyTypes);
        this.loadETHDropdown(get('selETHBoardType'), this.ethBoardTypes);

        let addr = [];
        for (let i = 0; i < 32; i++) {
            addr.push({ val: i, label: `PHY ${i}` });
        }
        this.loadETHDropdown(get('selETHAddress'), addr);

        ui.toElement(get('divNetAdapter'), {
            wifi: { ssid: '', passphrase: '' },
            ethernet: {
                boardType: 1,
                wirelessFallback: false,
                dhcp: true,
                dns1: '',
                dns2: '',
                ip: '',
                gateway: ''
            }
        });
        this.onETHBoardTypeChanged(get('selETHBoardType'));
        this.initialized = true;

        const inputPwr = get('inputETHPWRPin');
        if (inputPwr) {
            inputPwr.addEventListener('focus', () => {
                if (inputPwr.value === 'None') {
                    inputPwr.type = 'number';
                    inputPwr.value = -1;
                }
            });
            inputPwr.addEventListener('blur', () => {
                if (inputPwr.value === '-1' || inputPwr.value === '') {
                    inputPwr.type = 'text';
                    inputPwr.value = 'None';
                }
            });
        }
    }
    loadETHPins(sel, type, selected) {
        let arr = [];
        switch (type) {
            case 'power':
                arr.push({ val: -1, label: 'None' });
                break;
        }
        for (let i = 0; i < 36; i++) {
            if (i === 2) continue;
            arr.push({ val: i, label: `GPIO ${i > 9 ? i : '0' + i}` });
        }
        this.loadETHDropdown(sel, arr, selected);
    }
    loadETHDropdown(sel, arr, selected) {
        if (!sel) return;
        while (sel.firstChild) sel.removeChild(sel.firstChild);
        for (let i = 0; i < arr.length; i++) {
            let elem = arr[i];
            sel.options[sel.options.length] = new Option(elem.label, elem.val, elem.val === selected, elem.val === selected);
        }
    }
    onETHBoardTypeChanged(sel) {
        if (!sel) return;
        let type = this.ethBoardTypes.find(elem => parseInt(sel.value, 10) === elem.val);
        if (typeof type !== 'undefined') {
            if (typeof type.ct !== 'undefined') get('selETHPhyType').value = type.ct;
            if (typeof type.clk !== 'undefined') get('selETHClkMode').value = type.clk;
            if (typeof type.addr !== 'undefined') get('selETHAddress').value = type.addr;

            const inputPwr = get('inputETHPWRPin');
            if (inputPwr && typeof type.pwr !== 'undefined') {
                const isNone = (type.pwr === -1);
                if (isNone) {
                    inputPwr.type = 'text';
                    inputPwr.value = 'None';
                } else {
                    inputPwr.type = 'number';
                    inputPwr.value = type.pwr;
                }
                this.togglePowerIcon(isNone);
            }

            if (typeof type.mdc !== 'undefined') get('inputETHMDCPin').value = type.mdc;
            if (typeof type.mdio !== 'undefined') get('inputETHMDIOPin').value = type.mdio;

            get('divETHSettings').style.display = type.val === 0 ? '' : 'none';
        }
    }
    updateEthernetSummary(pinKey, value) {
        const targetLabel = pinKey.replace('Pin', '').toUpperCase() + ':';
        document.querySelectorAll('#divEthernetSummary .gpioRadio-label').forEach(lbl => {
            const text = lbl.textContent.trim();
            if (text === targetLabel) {
                const valSpan = lbl.nextElementSibling;
                if (valSpan && valSpan.classList.contains('gpioRadio-val')) {
                    valSpan.textContent = (value === -1 || value === 'None') ? 'None' : `GPIO${value}`;
                }
            }
        });
    }
    togglePowerIcon(isNone) {
        const btnIcon = document.querySelector('#btnEthPwrShortcut use');
        if (btnIcon) {
            btnIcon.setAttribute('href', isNone ? '#svg-powerOff' : '#svg-power');
        }
    }
    stepGpio(pinKey, direction) {
        const inputEl = get(`inputETH${pinKey}`);

        if (pinKey === 'PWRPin' && inputEl && inputEl.value === 'None' && direction === 1) {
            inputEl.type = 'number';
            inputEl.value = 0;
            inputEl.dispatchEvent(new Event('change', { bubbles: true }));
            this.updateEthernetSummary('PWRPin', 0);
            this.togglePowerIcon(false); // Numeric mode -> icon ON
            return;
        }

        const newValue = stepDeviceGpio(pinKey, direction, 'ETH', 'selETHBoardType', val => val === 0, this.pinMaps || [{ name: '', maxPins: 39 }]);

        if (newValue === undefined) return;
        if (pinKey === 'PWRPin' && inputEl) {
            const isNone = (parseInt(newValue, 10) === -1 || newValue === '');
            if (isNone) {
                inputEl.type = 'text';
                inputEl.value = 'None';
            } else {
                inputEl.type = 'number';
            }
            this.togglePowerIcon(isNone);
        }

        this.updateEthernetSummary(pinKey, newValue);
    }
    setPowerToNone() {
        const inputPwr = get('inputETHPWRPin');
        if (!inputPwr) return;
        if (inputPwr.value === 'None') {
            inputPwr.type = 'number';
            inputPwr.value = 0;
            inputPwr.dispatchEvent(new Event('change', { bubbles: true }));
            this.updateEthernetSummary('PWRPin', 0);
            this.togglePowerIcon(false);
            return;
        }
        inputPwr.type = 'text';
        inputPwr.value = -1;
        inputPwr.dispatchEvent(new Event('change', { bubbles: true }));
        inputPwr.type = 'text';
        inputPwr.value = 'None';

        this.updateEthernetSummary('PWRPin', -1);
        this.togglePowerIcon(true); // None mode -> icon OFF
    }
    onDHCPClicked(cb) { get('divStaticIP').style.display = cb.checked ? 'none' : ''; }

    loadNetwork() {
        let pnl = get('divNetAdapter');
        getJSONBusy('/networksettings', (err, settings) => {
            if(DBG) console.log(settings);
            if (err) {
                ui.serviceError(err);
            }
            else {
                get('cbHardwired').checked = settings.connType >= 2;
                get('cbFallbackWireless').checked = settings.connType === 3;
                ui.toElement(pnl, settings);

                // The passphrase is never sent by the server; show a presence
                // placeholder instead of prefilling the field.
                const fldPassphrase = get('fldPassphrase');
                if (fldPassphrase) {
                    fldPassphrase.value = '';
                    fldPassphrase.placeholder = settings.wifi && settings.wifi.hasPassphrase ? tr('SECRET_SET_PLH') : tr('SECURITY_PASSWORD_PLH');
                }

                const inputPwr = get('inputETHPWRPin');
                if (inputPwr && settings.ethernet && settings.ethernet.PWRPin !== undefined) {
                    const pwrVal = parseInt(settings.ethernet.PWRPin, 10);
                    const isNone = (pwrVal === -1);

                    if (isNone) {
                        inputPwr.type = 'text';
                        inputPwr.value = 'None';
                    } else {
                        inputPwr.type = 'number';
                        inputPwr.value = pwrVal;
                    }
                    this.togglePowerIcon(isNone);
                    this.updateEthernetSummary('PWRPin', pwrVal);
                }

                ui.toElement(get('divDHCP'), settings);
                get('divETHSettings').style.display = settings.ethernet.boardType === 0 ? '' : 'none';
                get('divStaticIP').style.display = settings.ip.dhcp ? 'none' : '';
                get('spanCurrentIP').textContent = settings.ip.ip;
                this.updateStatusBadge(settings);
                this.syncRadiosWithCheckbox();
                this.useEthernetClicked();
                this.hiddenSSIDClicked();
            }
        });
    }
    updateStatusBadge(settings) {
        const options = document.querySelectorAll('.opt-badge');
        if (!options.length) return;
        const connType = parseInt(settings.connType);
        let activeType = "wifi";
        if (connType >= 2) {
            const boardType = (settings.ethernet && settings.ethernet.boardType !== undefined) ? parseInt(settings.ethernet.boardType) : 0;
            const pwrPin = (settings.ethernet && settings.ethernet.PWRPin !== undefined) ? parseInt(settings.ethernet.PWRPin) : -1;
            if (boardType === 1) {
                activeType = "lan";
            }
            else if (pwrPin !== -1) {
                activeType = "poe";
            }
            else {
                activeType = "lan";
            }
        }
        options.forEach(opt => {
            opt.classList.toggle('active', opt.getAttribute('data-conn') === activeType);
        });
        // Mirror the active type into the compact mobile indicator (the top-bar
        // badges are hidden below 780px).
        const mc = get('mobileConnStatus');
        if (mc) mc.querySelector('.conn-type').textContent = activeType.toUpperCase();
    }
    setConnectionType(isEthernet) {
        get('cbHardwired').checked = isEthernet;
        this.syncRadiosWithCheckbox();
        this.useEthernetClicked();
        get('cbHardwired').dispatchEvent(new Event('change'));
    }
    syncRadiosWithCheckbox() {
        const isEthernet = get('cbHardwired').checked;
        get('radConnEthernet').checked = isEthernet;
        get('radConnWifi').checked = !isEthernet;
    }
    useEthernetClicked() {
        let useEthernet = get('cbHardwired').checked;
        get('divWiFiMode').style.display = useEthernet ? 'none' : '';
        get('divEthernetMode').style.display = useEthernet ? '' : 'none';
        get('divTypeCardMode').style.display = useEthernet ? '' : 'none';
        get('divFallbackWireless').style.display = useEthernet ? '' : 'none';
        get('divRoaming').style.display = useEthernet ? 'none' : '';
        get('divHiddenSSID').style.display = useEthernet ? 'none' : '';
    }
    hiddenSSIDClicked() {
        let hidden = get('cbHiddenSSID').checked;
        if (hidden) get('cbRoaming').checked = false;
        get('cbRoaming').disabled = hidden;
    }
    async loadAPs() {
        const btnScan = get('btnScanAPs');
        const divAps = get('divAps');

        if (btnScan.classList.contains('disabled')) return;
        divAps.innerHTML = `<div class="no-wifi"><div class="wifiConnectScan"><div class="lds-roller"><div></div><div></div><div></div><div></div><div></div><div></div><div></div><div></div></div></div><div>${tr("CONNECTION_SCANNING")}</div></div>`;

        btnScan.classList.add('disabled');

        getJSON('/scanaps', (err, aps) => {
            btnScan.classList.remove('disabled');
            if (err || !aps || !aps.accessPoints) {
                this.displayAPs({ accessPoints: [] });
            } else {
                this.displayAPs(aps);
            }
        });
    }
    displayAPs(aps) {
        let nets = [];
        if (aps && aps.accessPoints) {
            for (let i = 0; i < aps.accessPoints.length; i++) {
                let ap = aps.accessPoints[i];
                let p = nets.find(elem => elem.name === ap.name);
                if (p) {
                    p.channel = p.strength > ap.strength ? p.channel : ap.channel;
                    p.macAddress = p.strength > ap.strength ? p.macAddress : ap.macAddress;
                    p.strength = Math.max(p.strength, ap.strength);
                } else {
                    nets.push(ap);
                }
            }
        }
        nets.sort((a, b) => b.strength - a.strength);

        let div = "";
        if (nets.length > 0) {
            div = `<div class="aps-title">${tr("CONNECTION_WIFI_AVAILABLE")}</div><hr class="aps-hr">`;
            for (let i = 0; i < nets.length; i++) {
                let ap = nets[i];
                div += `
                <div class="wifiSignal" ${a11yBtn(trf('A11Y_SELECT_NETWORK', ap.name))} onclick="wifi.selectSSID(this);" data-channel="${esc(ap.channel)}" data-encryption="${esc(ap.encryption)}" data-strength="${esc(ap.strength)}" data-mac="${esc(ap.macAddress)}"><span class="ssid">${esc(ap.name)}</span><span class="strength">${this.displaySignal(ap.strength)}</span>
                </div>`;
            }
        } else {
            div = `
            <div class="no-wifi"><div>${tr("ERR_NO_WIFI_FOUND")}</div><div class="button-container-row"><button id="btnRetryWifi" pop type="button" onclick="wifi.loadAPs();">${tr("BT_RETRY")}</button><button id="btnCancelWifi" pop line type="button" onclick="wifi.cancelScan();">${tr("BT_CANCEL_1")}</button>
            </div>`;
        }

        let divAps = get('divAps');
        divAps.setAttribute('data-lastloaded', new Date().getTime());
        divAps.innerHTML = div;
    }
    cancelScan() {
        const btnScan = get('btnScanAPs');
        if (btnScan) btnScan.classList.remove('disabled');

        const divAps = get('divAps');
        if (divAps) divAps.innerHTML = '';
        if (typeof ui !== 'undefined' && ui.unlock) ui.unlock();
    }
    selectSSID(el) {
        let obj = {
            // Read decoded text (not innerHTML) so escaped SSIDs round-trip correctly.
            name: el.querySelector('span.ssid').textContent,
            encryption: el.getAttribute('data-encryption'),
            strength: parseInt(el.getAttribute('data-strength'), 10),
            channel: parseInt(el.getAttribute('data-channel'), 10)
        };
        if(DBG) console.log(obj);
        document.getElementsByName('ssid')[0].value = obj.name;
    }
    calcWaveStrength(sig) {
        let wave = 0;
        if (sig > -90) wave = 0;
        if (sig > -80) wave = 1;
        if (sig > -70) wave = 2;
        if (sig > -60) wave = 3;
        return wave;
    }
    displaySignal(sig) {
        let level = this.calcWaveStrength(sig);
        if (level > 3) level = 3;

        const getPart = (idNum) => {
            const active = idNum <= level;
            return `<use href="#svg-wifi-${idNum}" fill="${active ? 'var(--accent-sucess)' : '#ccc'}" style="opacity:${active ? '1' : '0.3'}" />`;
        };

        return `
        <div class="signal">
        <svg>
        ${getPart(0)}
        ${getPart(1)}
        ${getPart(2)}
        ${getPart(3)}
        </svg>
        </div>`;
    }
    saveIPSettings() {
        let pnl = get('divDHCP');
        let obj = ui.fromElement(pnl).ip;
        if(DBG) console.log(obj);
        if (!obj.dhcp) {
            let fnValidateIP = (addr) => { return /^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(addr); };
            if (typeof obj.ip !== 'string' || obj.ip.length === 0 || obj.ip === '0.0.0.0') {
                ui.errorMessage(tr('ERR_STATIC_IP_REQUIRED'));
                return;
            }
            else if (!fnValidateIP(obj.ip)) {
                ui.errorMessage(tr('ERR_STATIC_IP_INVALID'));
                return;
            }
            if (typeof obj.subnet !== 'string' || obj.subnet.length === 0 || obj.subnet === '0.0.0.0') {
                ui.errorMessage(tr('ERR_NETMASK_REQUIRED'));
                return;
            }
            else if (!fnValidateIP(obj.subnet)) {
                ui.errorMessage(tr('ERR_NETMASK_INVALID'));
                return;
            }
            if (typeof obj.gateway !== 'string' || obj.gateway.length === 0 || obj.gateway === '0.0.0.0') {
                ui.errorMessage(tr('ERR_GATEWAY_REQUIRED'));
                return;
            }
            else if (!fnValidateIP(obj.gateway)) {
                ui.errorMessage(tr('ERR_GATEWAY_INVALID'));
                return;
            }
            if (obj.dns1.length !== 0 && !fnValidateIP(obj.dns1)) {
                ui.errorMessage(tr('ERR_DNS1_INVALID'));
                return;
            }
            if (obj.dns2.length !== 0 && !fnValidateIP(obj.dns2)) {
                ui.errorMessage(tr('ERR_DNS2_INVALID'));
                return;
            }
        }
        putJSONBusy('/setIP', obj, (err, response) => {
            if (err) {
                ui.serviceError(err);
            } else {
                ui.successMessage(tr('MSG_SAVE_SUCCESS'));
                if(DBG) console.log(response);
            }
        });
    }
    saveNetwork() {
        let pnl = get('divNetAdapter'), obj = ui.fromElement(pnl);
        const eth = obj.ethernet;
        // Reset to -1 when the extracted value is NaN, empty or "None"
        if (isNaN(eth.PWRPin) || eth.PWRPin === 'None' || eth.PWRPin === '') {
            eth.PWRPin = -1;
        }
        obj.connType = eth.hardwired ? (eth.wirelessFallback ? 3 : 2) : 1;

        if (obj.connType >= 2) {
            const [board, phy, clk] = [
                this.ethBoardTypes.find(e => eth.boardType === e.val),
                this.ethPhyTypes.find(e => eth.phyType === e.val),
                this.ethClockModes.find(e => eth.CLKMode === e.val)
            ];

            let boardLabel = board ? board.label : tr("MANUAL_SETTINGS");
            let boardVal = board ? board.val : 0;
            let phyLabel = phy ? phy.label : '---';
            let phyVal = phy ? phy.val : 0;
            let clkLabel = clk ? clk.label : '---';
            let clkVal = clk ? clk.val : 0;

            let div = document.createElement('div');
            div.className = 'inst-overlay';
            div.innerHTML = `
            <div class="instructions-content">
            <div class="overlay-scroll-content">
            ${overlayHeader('ETH_SETTINGS_TITLE', 'ETH_SETTINGS_DESC', 'svg-ethernet')}
            <div class="unibloc"><p>${tr("ETH_SETTINGS_WARNING_DESC_1")}</p></div>
            <div class="blocEthBoardSettings">
            <div>
            <div class="eth-setting-line"><label>${tr("ETH_SETTINGS_BOARD_TYPE")}</label><span>${boardLabel} [${boardVal}]</span></div>
            <div class="eth-setting-line"><label>${tr("ETH_SETTINGS_PHY_TYPE")}</label><span>${phyLabel} [${phyVal}]</span></div>
            <div class="eth-setting-line"><label>${tr("ETH_SETTINGS_PHY_ADDRESS")}</label><span>${eth.phyAddress ?? 0}</span></div>
            <div class="eth-setting-line"><label>${tr("ETH_SETTINGS_CLOCK_MODE")}</label><span>${clkLabel} [${clkVal}]</span></div>
            <div class="eth-setting-line"><label>${tr("ETH_SETTINGS_POWER_PIN")}</label><span>${(eth.PWRPin === undefined || eth.PWRPin === -1) ? tr("NONE") : eth.PWRPin}</span></div>
            <div class="eth-setting-line"><label>${tr("ETH_SETTINGS_MDC_PIN")}</label><span>${eth.MDCPin ?? 0}</span></div>
            <div class="eth-setting-line"><label>${tr("ETH_SETTINGS_MDIO_PIN")}</label><span>${eth.MDIOPin ?? 0}</span></div>
            </div>
            </div>
            <div class="error">
            <label class="safety-checkbox-container">
            <div><input type="checkbox" id="chkConfirmEth"><span class="custom-checkbox"></span></div>
            <div><b>${tr('MSG_DANGER')}</b> <span>${tr("ETH_SETTINGS_WARNING_DESC_2")}</span></div>
            </label>
            </div>
            </div>
            <div class="hrDivFooter"></div>
            <div class="button-container-overlay">
            <button id="btnCancel" line type="button">${tr("BT_CANCEL_1")}</button>
            <button id="btnSaveEthernet" style="background:#ccc;cursor:not-allowed" type="button" disabled>${tr("BT_SAVE")}</button>
            </div>
            </div>
            </div>`;

            shOverlay(div);

            const chk = div.querySelector('#chkConfirmEth'), btn = div.querySelector('#btnSaveEthernet');
            chk.onchange = () => {
                const ok = chk.checked;
                btn.disabled = !ok;
                btn.style.background = ok ? "var(--txtwarning-color)" : "#ccc";
                btn.style.cursor = ok ? "pointer" : "not-allowed";
            };
            btn.onclick = () => { this.sendNetworkSettings(obj); closeOverlay(div); };
            div.querySelector('#btnCancel').onclick = () => closeOverlay(div);
        } else {
            this.sendNetworkSettings(obj);
        }
    }
    sendNetworkSettings(obj) {
        putJSONBusy('/setNetwork', obj, (err, response) => {
            if (err) {
                ui.serviceError(err);
            } else {
                ui.successMessage(tr('MSG_SAVE_SUCCESS'));
                if(DBG) console.log("Network settings updated:", response);
            }
        });
    }
    connectWiFi() {
        if (get('btnConnectWiFi').classList.contains('disabled')) return;
        get('btnConnectWiFi').classList.add('disabled');
        let obj = {
            ssid: document.getElementsByName('ssid')[0].value,
            passphrase: document.getElementsByName('passphrase')[0].value
        };
        if (obj.ssid.length > 64) {
            ui.errorMessage(tr('ERR_WIFI_SSID_INVALID')).querySelector('.sub-message').innerHTML = tr('ERR_WIFI_SSID_MAX_LENGTH_64');
            return;
        }
        if (obj.passphrase.length > 64) {
            ui.errorMessage(tr('ERR_WIFI_PASSPHRASE_INVALID')).querySelector('.sub-message').innerHTML = tr('ERR_WIFI_PASSPHRASE_MAX_LENGTH_64');
            return;
        }
        let overlay = ui.waitMessage(get('divNetAdapter'));
        putJSON('/connectwifi', obj, (err, response) => {
            overlay.remove();
            get('btnConnectWiFi').classList.remove('disabled');
            if(DBG) console.log(response);
        });
    }
    procWifiStrength(strength) {
        if (!strength) return;

        const ssid = strength.ssid || strength.name;
        const sVal = parseInt(strength.strength);
        const elSSID = get('spanNetworkSSID');
        const elChan = get('spanNetworkChannel');
        const elStrength = get('spanNetworkStrength');

        // The SSID is attacker-controlled (any nearby AP can broadcast one) and lands in
        // innerHTML, so it must go through the central escaper like every other network string.
        if (elSSID) elSSID.innerHTML = !ssid || ssid === '' ? '-------------' : esc(ssid);
        if (elChan) elChan.innerHTML = isNaN(strength.channel) || strength.channel < 0 ? '--' : strength.channel;
        if (elStrength) elStrength.innerHTML = isNaN(sVal) || sVal <= -100 ? '----' : sVal;

        let level = (isNaN(sVal) || sVal >= 0 || sVal <= -100) ? -1 : this.calcWaveStrength(sVal);
        if (level >= 3) level = 3;

        for (let i = 0; i <= 3; i++) {
            const part = get('wifi_' + i);
            if (part) {
                if (i <= level) {
                    part.classList.add('active');
                } else {
                    part.classList.remove('active');
                }
            }
        }
    }
    procEthernet(ethernet) {
        if(DBG) console.log(ethernet);
        const spanStatus = get('spanEthernetStatus');
        const divStatus = get('divEthernetStatus');
        const divWifi = get('divWiFiStrength');
        const spanSpeed = get('spanEthernetSpeed');

        divStatus.style.display = ethernet.connected ? '' : 'none';
        divWifi.style.display = ethernet.connected ? 'none' : '';
        spanStatus.innerHTML = ethernet.connected ? 'Connected' : 'Disconnected';
        spanStatus.style.color = ethernet.connected ? 'var(--accent-sucess)' : '';
        spanSpeed.innerHTML = !ethernet.connected ? '--------' : `${ethernet.speed} Mbps ${ethernet.fullduplex ? 'Full-duplex' : 'Half-duplex'}`;
    }
}
var wifi = new Wifi();
class Somfy {
    initialized = false;
    frames = [];
    isScanClosing = false;
    scanObserver = null;
    shadeTypes = [
        { type: 0, name: 'Roller Shade', ico: 'svg-window-shade', lift: true, sun: true, fcmd: true, fpos: true },
        { type: 1, name: 'Blind', ico: 'svg-window-blind', lift: true, tilt: true, sun: true, fcmd: true, fpos: true },
        { type: 2, name: 'Drapery (left)', ico: 'svg-ldrapery', lift: true, sun: true, fcmd: true, fpos: true },
        { type: 3, name: 'Awning', ico: 'svg-awning', lift: true, sun: true, fcmd: true, fpos: true },
        { type: 4, name: 'Shutter', ico: 'svg-shutter', lift: true, sun: true, fcmd: true, fpos: true },
        { type: 5, name: 'Garage (1-button)', ico: 'svg-garage', lift: true, light: true, fpos: true },
        { type: 6, name: 'Garage (3-button)', ico: 'svg-garage', lift: true, light: true, fcmd: true, fpos: true },
        { type: 7, name: 'Drapery (right)', ico: 'svg-rdrapery', lift: true, sun: true, fcmd: true, fpos: true },
        { type: 8, name: 'Drapery (center)', ico: 'svg-cdrapery', lift: true, sun: true, fcmd: true, fpos: true },
        { type: 9, name: 'Dry Contact (1-button)', ico: 'svg-contactBulb', fpos: true },
        { type: 10, name: 'Dry Contact (2-button)', ico: 'svg-contactBulb', fcmd: true, fpos: true },
        { type: 11, name: 'Gate (left)', ico: 'svg-lgate', lift: true, fcmd: true, fpos: true },
        { type: 12, name: 'Gate (center)', ico: 'svg-cgate', lift: true, fcmd: true, fpos: true },
        { type: 13, name: 'Gate (right)', ico: 'svg-rgate', lift: true, fcmd: true, fpos: true },
        { type: 14, name: 'Gate (1-button left)', ico: 'svg-lgate', lift: true, fcmd: true, fpos: true },
        { type: 15, name: 'Gate (1-button center)', ico: 'svg-cgate', lift: true, fcmd: true, fpos: true },
        { type: 16, name: 'Gate (1-button right)', ico: 'svg-rgate', lift: true, fcmd: true, fpos: true },
    ];
    radioBoardTypes = [
        { val: 0, label: 'DEFAULT', showGPIO: false },
        { val: 1, label: 'ESP32-D1 mini', showGPIO: false, chips: ['esp32'], pins: { SCKPin: 18, CSNPin: 5, MOSIPin: 23, MISOPin: 19, TXPin: 21, RXPin: 22 } },
        { val: 2, label: 'WT32-ETH01', showGPIO: false, chips: ['esp32'], pins: { SCKPin: 14, CSNPin: 12, MOSIPin: 15, MISOPin: 4, TXPin: 2, RXPin: 35 } },
        { val: 3, label: 'Olimex ESP32-PoE/EVB', showGPIO: false, chips: ['esp32'], pins: { SCKPin: 14, CSNPin: 13, MOSIPin: 15, MISOPin: 16, TXPin: 4, RXPin: 36 } },
        { val: 4, label: 'LilyGO T-Internet POE', showGPIO: false, chips: ['esp32'], pins: { SCKPin: 14, CSNPin: 12, MOSIPin: 15, MISOPin: 16, TXPin: 4, RXPin: 35 } },
        { val: 5, label: 'wESP POE', showGPIO: false, chips: ['esp32'], pins: { SCKPin: 18, CSNPin: 5, MOSIPin: 13, MISOPin: 32, TXPin: 4, RXPin: 39 } },
        { val: 6, label: 'ESP-PoE-32', showGPIO: false, chips: ['esp32'], pins: { SCKPin: 14, CSNPin: 5, MOSIPin: 13, MISOPin: 32, TXPin: 4, RXPin: 35 } },
        { val: 7, label: 'ESP32s3 Mini', showGPIO: false, chips: ['s3'], pins: { SCKPin: 7, CSNPin: 6, MOSIPin: 9, MISOPin: 8, TXPin: 3, RXPin: 4 } },
        { val: 8, label: 'XIAO-ESP32-C3', showGPIO: false, chips: ['c3'], pins: { SCKPin: 8, CSNPin: 6, MOSIPin: 10, MISOPin: 9, TXPin: 3, RXPin: 4 } },
        { val: 255, label: 'MANUAL_SETTINGS', showGPIO: true }
    ];

    init() {
        if (this.initialized) return;
        this.initialized = true;
    }
    initPins() {
        document
        .getElementById('selRadioBoardType')
        .addEventListener('change', e => this.onRadioBoardTypeChanged(e.target));

        const sel = get('selRadioBoardType');

        sel.addEventListener('change', e => this.onRadioBoardTypeChanged(e.target));

        this.loadPins('inout', get('selTransSCKPin'));
        this.loadPins('inout', get('selTransCSNPin'));
        this.loadPins('inout', get('selTransMOSIPin'));
        this.loadPins('input', get('selTransMISOPin'));
        this.loadPins('out', get('selTransTXPin'));
        this.loadPins('input', get('selTransRXPin'));

        ui.toElement(get('divTransceiverSettings'), {
            transceiver: { config: { proto: 0, radioBoardType: 0, SCKPin: 18, CSNPin: 5, MOSIPin: 23, MISOPin: 19, TXPin: 13, RXPin: 12, frequency: 433.42, rxBandwidth: 97.96, type: 56, deviation: 11.43, txPower: 10, enabled: false } }
        });

        this.loadPins('out', get('selShadeGPIOUp'));
        this.loadPins('out', get('selShadeGPIODown'));
        this.loadPins('out', get('selShadeGPIOMy'));
        this.loadRadioBoardTypes(get('selRadioBoardType'));
        this.loadRadioBoardTypes(sel);
        this.onRadioBoardTypeChanged(sel);
    }
    loadRadioBoardTypes(sel) {
        while (sel.firstChild) sel.removeChild(sel.firstChild);

        let rawCm = get('divContainer').getAttribute('data-chipmodel') || "";
        let cm = rawCm.toLowerCase().trim();

        if (cm.includes("s3")) cm = "s3";
        else if (cm.includes("c3")) cm = "c3";
        else if (cm.includes("s2")) cm = "s2";
        else cm = "esp32";

        this.radioBoardTypes.forEach(t => {
            if (t.chips && !t.chips.includes(cm)) {
                return;
            }
            let labelKey = t.label;
            if (t.val === 0 && labelKey === 'DEFAULT') {
                labelKey = `BOARD_DEFAULT_${cm.toUpperCase()}`;
            }

            const labelText = tr(labelKey);
            sel.options.add(new Option(labelText, t.val));
        });
    }
    onRadioBoardTypeChanged(sel, isInit = false) {
        const val = parseInt(sel.value, 10),
        cm = (get('divContainer').getAttribute('data-chipmodel') || "").toLowerCase(),
        divS = get('divGPIOSummary'),
        divG = get('divShowGpio'),
        pk = ['SCKPin', 'CSNPin', 'MOSIPin', 'MISOPin', 'TXPin', 'RXPin'],
        isM = (val === 255),
        board = this.radioBoardTypes.find(t => t.val === val);

        let def = { SCKPin: 18, CSNPin: 5, MOSIPin: 23, MISOPin: 19, TXPin: 13, RXPin: 12 };
        if (cm === "s3") def = { SCKPin: 12, CSNPin: 10, MOSIPin: 11, MISOPin: 13, TXPin: 15, RXPin: 14 };
        else if (cm === "s2") def = { SCKPin: 36, CSNPin: 34, MOSIPin: 35, MISOPin: 37, TXPin: 15, RXPin: 14 };
        else if (cm === "c3") def = { SCKPin: 15, CSNPin: 14, MOSIPin: 16, MISOPin: 17, TXPin: 13, RXPin: 12 };

        const target = val === 0 ? def : (board?.pins || null);

        if (target) {
            const labels = ['SCLK:', 'CSN:', 'MOSI:', 'MISO:', 'TX:', 'RX:'];
            let html = `<div class="gpioRadio-container"><div class="help-container" ${a11yBtn(tr('A11Y_HELP'))} onclick="toggleTooltip(this)"><svg class="help-svg"><use href=#icon-question></use></svg><div class="tooltip-text"><b>${tr('RADIO_TOOLTIP_GPIO_0')}</b><br><br>${tr('RADIO_TOOLTIP_GPIO_1')}<br>${tr('RADIO_TOOLTIP_GPIO_2')}<br><br><i>${tr('RADIO_TOOLTIP_GPIO_3')}</i><br><br></div></div>`;

            pk.forEach((k, i) => {
                const v = target[k], selP = get(`selTrans${k}`), inpP = get(`inputTrans${k}`);
                if (selP) {
                    if (![...selP.options].some(o => parseInt(o.value, 10) === v)) {
                        selP.options.add(new Option(`GPIO-${v < 10 ? '0' + v : v}`, v));
                    }
                    selP.value = v;
                }
                if (inpP) inpP.value = v;
                html += `<div class="gpioRadio-item"><span class="gpioRadio-label">${labels[i]}</span><span class="gpioRadio-val">GPIO${v}</span></div>${i < 5 ? `<div class="gpioRadio-sep${i === 2 ? ' gpioRadioSep' : ''}">|</div>` : ''}`;
            });
            divS.innerHTML = html + `</div>`;
        }

        pk.forEach(k => {
            const selP = get(`selTrans${k}`), inpP = get(`inputTrans${k}`);
            if (selP) selP.style.display = target ? 'inline-block' : 'none';
            if (inpP) {
                if (isM) inpP.value = (isInit && parseInt(selP?.value || inpP.value, 10)) || def[k];
                inpP.style.display = isM ? 'inline-block' : 'none';
            }
        });

        get('divManualSafety').style.display = isM ? 'block' : 'none';
        divS.style.display = target ? 'block' : 'none';
        divG.style.display = target ? 'none' : 'inline-block';
    }
    async loadSomfy() {
        //console.trace("loadSomfy called");
        getJSONBusy('/controller', (err, somfy) => {
            if (err) {
                if(DBG) console.log(err);
                ui.serviceError(err);
            } else {
                get('spanMaxRooms').innerText = (somfy.maxRooms - 2);
                get('spanMaxShades').innerText = (somfy.maxShades - 2);
                get('spanMaxGroups').innerText = (somfy.maxGroups - 2);

                ui.toElement(get('divTransceiverSettings'), somfy);

                const selBoard = get('selRadioBoardType');
                if (selBoard) {
                    this.loadRadioBoardTypes(selBoard);
                }

                if (somfy.transceiver && somfy.transceiver.config) {
                    if (selBoard) selBoard.value = somfy.transceiver.config.radioBoardType || 0;
                    this.onRadioBoardTypeChanged(selBoard, true);
                }

                const cbRadio = get('cbEnableRadio');
                const txtStatus = get('divRadioEnableStatus');
                const row = get('divRadioEnableColor');
                const radioTab = document.querySelector('.tab-container span[data-grpid="divRadioSettings"]');
                const updateRadioText = () => {
                    const currentState = cbRadio.checked;
                    const isActuallyEnabled = radioTab && !radioTab.classList.contains('radio-error');

                    if (currentState === isActuallyEnabled) {
                        txtStatus.textContent = currentState ? tr('RADIO_ENABLED') : tr('RADIO_DISABLED');
                    } else {
                        txtStatus.textContent = tr('RADIO_SAVE_REQUIRED');
                    }
                };
                const isRadioInit = somfy.transceiver.config.radioInit;
                const sideNote = get('barsideRadioDisable');
                if (radioTab) {
                    radioTab.classList.toggle('radio-error', !isRadioInit);
                    if (sideNote) sideNote.style.display = isRadioInit ? 'none' : 'inline';
                    row.classList.toggle('radioOn', !!isRadioInit);
                }
                cbRadio.addEventListener('change', updateRadioText);
                updateRadioText();

                this.setRoomsList(somfy.rooms);
                this.setShadesList(somfy.shades);
                this.setGroupsList(somfy.groups);
                this.setRepeaterList(somfy.repeaters);
                if (typeof somfy.version !== 'undefined') {
                    firmware.procFwStatus(somfy.version);
                }
            }
        });
    }
    stepGpio(pinKey, direction) {
        const newValue = stepDeviceGpio(pinKey, direction, 'Trans', 'selRadioBoardType', val => val === 255, this.pinMaps);
        if (newValue === undefined) return;

        const targetLabel = pinKey.replace('Pin', '').toUpperCase() + ':';
        document.querySelectorAll('#divGPIOSummary .gpioRadio-label').forEach(lbl => {
            const text = lbl.textContent.trim();
            if (text === targetLabel || (targetLabel === 'SCK:' && text === 'SCLK:')) {
                const valSpan = lbl.nextElementSibling;
                if (valSpan && valSpan.classList.contains('gpioRadio-val')) valSpan.textContent = `GPIO${newValue}`;
            }
        });
    }
    saveRadio() {
        let valid = true;
        const d = get('divTransceiverSettings'),
        t = ui.fromElement(d).transceiver,
        pk = ['SCKPin', 'CSNPin', 'MOSIPin', 'MISOPin', 'TXPin', 'RXPin'],
        bv = parseInt(get('selRadioBoardType').value, 10),
        isM = (bv === 255);

        if (!t.config) t.config = {};
        t.config.radioBoardType = bv;

        if (isM && !get('cbManualSafety')?.checked) {
            return ui.errorMessage(d, tr('ERR_RADIO_SAFETY_REQUIRED'));
        }

        pk.forEach(k => {
            const el = get((isM ? 'inputTrans' : 'selTrans') + k);
            if (el) t.config[k] = parseInt(el.value, 10);
        });

            if (!t.config.type || t.config.type === 'none') {
                ui.errorMessage(d, tr('ERR_RADIO_TYPE_REQUIRED'));
                valid = false;
            }

            if (valid) {
                const cm = (get('divContainer').getAttribute('data-chipmodel') || "").toLowerCase(),
                pm = this.pinMaps.find(x => x.name === cm) || { maxPins: 39 };

                try {
                    for (const k of pk) {
                        const v = t.config[k];
                        if (v === undefined || isNaN(v)) {
                            ui.errorMessage(d, tr('ERR_RADIO_PINS_REQUIRED'));
                            valid = false; break;
                        }
                        if (v < 0 || v > pm.maxPins) {
                            ui.errorMessage(d, tr('ERR_GPIO_NOT_EXIST').replace('{pin}', v).replace('{maxPins}', pm.maxPins));
                            valid = false; break;
                        }
                        for (let s in t.config) {
                            if (s.endsWith('Pin') && s !== k && t.config[s] === v) {
                                if ((k === 'TXPin' && s === 'RXPin') || (k === 'RXPin' && s === 'TXPin')) continue;
                                ui.errorMessage(d, tr('ERR_GPIO_PIN_DUPLICATED').replace('%1', k.replace('Pin', '')).replace('%2', s.replace('Pin', '')));
                                valid = false; break;
                            }
                        }
                        if (!valid) break;
                    }
                } catch (err) {
                    console.error(err);
                    valid = false;
                }
            }

            if (!valid) return;

            const proceedSave = () => {
                putJSONBusy('/saveRadio', t, (err, res) => {
                    if (err) return ui.serviceError(err);

                    ui.successMessage(tr('MSG_SAVE_SUCCESS'));
                    get('btnSaveRadio').classList.remove('disabled');

                    const init = res.config.radioInit,
                    tab = document.querySelector('.tab-container span[data-grpid="divRadioSettings"]'),
                            sn = get('barsideRadioDisable'),
                            cb = get('cbEnableRadio');

                            if (tab) {
                                tab.classList.toggle('radio-error', !init);
                                if (sn) sn.style.display = init ? 'none' : 'inline';
                                get('divRadioEnableColor').classList.toggle('radioOn', !!init);
                            }
                            get('divRadioEnableStatus').textContent = tr(cb.checked === init ? (cb.checked ? 'RADIO_ENABLED' : 'RADIO_DISABLED') : 'RADIO_SAVE_REQUIRED');
                });
            };
            if (isM) {
                let prompt = ui.promptMessage(get('divContainer'), tr('PROMPT_RADIO_MANUAL_TITLE'), () => {
                    proceedSave();
                });
                prompt.querySelector('.sub-message').innerHTML = `<p>${tr("PROMPT_RADIO_MANUAL_WARNING")}</p>`;
            } else {
                proceedSave();
            }
    }
    pinMaps = [
        { name: '', maxPins: 39, inputs: [0, 1, 6, 7, 8, 9, 10, 11, 37, 38], outputs: [3, 6, 7, 8, 9, 10, 11, 34, 35, 36, 37, 38, 39] },
        { name: 's2', maxPins: 46, inputs: [0, 19, 20, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 45], outputs: [0, 19, 20, 26, 27, 28, 29, 30, 31, 32, 45, 46]},
        { name: 's3', maxPins: 48, inputs: [19, 20, 22, 23, 24, 25, 27, 28, 29, 30, 31, 32], outputs: [19, 20, 22, 23, 24, 25, 27, 28, 29, 30, 31, 32] },
        { name: 'c3', maxPins: 21, inputs: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20], outputs: [11, 12, 13, 14, 15, 16, 17, 21] }
    ];
    loadPins(type, sel, opt) {
        if (!sel) return;
        let currentVal = (typeof opt !== 'undefined') ? opt : parseInt(sel.value, 10);
        while (sel.firstChild) sel.removeChild(sel.firstChild);

        let cm = get('divContainer').getAttribute('data-chipmodel');
        let pm = this.pinMaps.find(x => x.name === cm);
        if (!pm) {
            pm = { name: '', maxPins: 39, inputs: [0, 1, 6, 7, 8, 9, 10, 11, 37, 38], outputs: [3, 6, 7, 8, 9, 10, 11, 34, 35, 36, 37, 38, 39] };
        }

        for (let i = 0; i <= pm.maxPins; i++) {

            if (type.includes('in') && pm.inputs.includes(i)) continue;
            if (type.includes('out') && pm.outputs.includes(i)) continue;

            sel.options[sel.options.length] = new Option(
                `GPIO-${i > 9 ? i.toString() : '0' + i.toString()}`,
                                                         i
            );
        }
        if (!isNaN(currentVal)) {
            sel.value = currentVal;
        }
    }
    procFrequencyScan(scan) {
        // console.log(scan);
        let div = this.scanFrequency();
        let spanTestFreq = get('spanTestFreq');
        let spanTestRSSI = get('spanTestRSSI');
        let spanBestFreq = get('spanBestFreq');
        let spanBestRSSI = get('spanBestRSSI');

        if (spanBestFreq) {
            spanBestFreq.innerHTML = scan.RSSI !== -100 ? scan.frequency.fmt('###.00') : '----';
        }
        if (spanBestRSSI) {
            spanBestRSSI.innerHTML = scan.RSSI !== -100 ? scan.RSSI : '----';
        }
        if (spanTestFreq) {
            spanTestFreq.innerHTML = scan.testFreq.fmt('###.00');
        }
        if (spanTestRSSI) {
            spanTestRSSI.innerHTML = scan.testRSSI !== -100 ? scan.testRSSI : '----';

            if (this.rssiGraph) {
                this.rssiGraph.update(scan.testRSSI);
            }
        }
        if (scan.RSSI !== -100)
            div.setAttribute('data-frequency', scan.frequency);
    }
    scanFrequency(initScan) {
        if (this.isScanClosing) return;
        let div = get('divScanFrequency');

        if (!div) {
            div = document.createElement('div');
            div.id = 'divScanFrequency';
            div.className = 'inst-overlay';
            div.innerHTML = `
            <div class="instructions-content">
            <div class="overlay-scroll-content">
            ${overlayHeader('SCANFREQ_TITLE', 'SCANFREQ_DESC', 'icon-tabRadio')}
            <div class="unibloc"><div>${tr("SCANFREQ_SCAN_DESC")}</div></div>
            <div class="unibloc">
            <div class="uniRow">
            <div class="scanfreqRssiLeft"><div class="uniLabel">${tr("SCANFREQ_SCAN")}</div><div class="scanfreqValue"><span id="spanTestFreq">433.00</span> <span>${tr("MHZ")}</span></div></div>
            <div class="scanfreqRssiRight"><div class="uniLabel">RSSI</div><div class="scanfreqValue"><span id="spanTestRSSI">----</span> <span>${tr("DBM")}</span></div></div>
            </div>
            <hr>
            <div class="uniRow" style="justify-content:space-between;align-items:flex-end">
            <div class="scanfreqRssiLeft"><div class="uniLabel">${tr("SCANFREQ_FREQUENCY")}</div><div class="scanfreqValueColor"><span id="spanBestFreq">---.--</span> <span>${tr("MHZ")}</span></div></div>
            <div class="scanfreqRssiRight"><div class="uniLabel">RSSI</div><div class="scanfreqValueColor"><span id="spanBestRSSI">----</span> <span>${tr("DBM")}</span></div></div>
            </div>
            </div>
            <div class="uniblocrRssiCanvas"><canvas id="rssiCanvas"></canvas></div>
            <div class="button-container-col">
            <button id="btnStopScanning" type="button" onclick="somfy.stopScanningFrequency(true)">${tr("BT_STOP_SCAN")}</button>
            <div style="display:flex;gap:10px;width:100%">
            <button id="btnRestartScanning" type="button" style="display:none" onclick="somfy.scanFrequency(true)">${tr("BT_START_SCAN")}</button>
            <button id="btnCopyFrequency" type="button" style="display:none" onclick="somfy.setScannedFrequency()">${tr("BT_COPY_FREQUENCY")}</button>
            </div>
            <button id="btnCloseScanning" line type="button" style="display:none" line>${tr("BT_CLOSE")}</button>
            </div>
            <div class="unibloc scanfreqwhat">
            <div><span>💡</span> ${tr('SCANFREQ_UNDERSTANDING_RSSI')}</div><p>${tr('SCANFREQ_RSSI_EXPLANATION')}</p>
            <div class="scanfreqSignal">
            <div class="success"><svg><use href=#svg-succes></use></svg><div><b>${tr('SCANFREQ_RSSI_EXCELLENT')}</b> <span>${tr('SCANFREQ_RSSI_EXCELLENT_DESC')}</span></div></div>
            <div class="warning"><svg><use href=#svg-warning></use></svg><div><b>${tr('SCANFREQ_RSSI_WEAK')}</b> <span>${tr('SCANFREQ_RSSI_WEAK_DESC')}</span></div></div>
            <div class="error"><svg><use href=#svg-error></use></svg><div><b>${tr('SCANFREQ_RSSI_NOISE')}</b> <span>${tr('SCANFREQ_RSSI_NOISE_DESC')}</span></div></div>
            </div>
            </div>
            </div>
            </div>`;

            shOverlay(div);
            div.querySelector('#btnCloseScanning').onclick = () => closeOverlay(div);

            if (this.scanObserver) this.scanObserver.disconnect();
            this.scanObserver = new MutationObserver(() => { if (!get('divScanFrequency')) this.terminateScanUI(true); });
            this.scanObserver.observe(get('divContainer'), { childList: true });

            this.rssiGraph = {
                points: [],
                maxPoints: 100,
                canvas: get('rssiCanvas'),
                update(val) {
                    const c = this.canvas;
                    if (!c) return;
                    const ctx = c.getContext('2d'), w = c.width = c.clientWidth, h = c.height = c.clientHeight;
                    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent-color').trim() || '#f8a525';
                    const lblW = 50, gW = w - lblW;
                    let v = parseInt(val);
                    if (isNaN(v) || v === -100) v = -110;

                    this.points.push(v);
                    if (this.points.length > this.maxPoints) this.points.shift();

                    ctx.clearRect(0, 0, w, h);
                    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
                    ctx.setLineDash([5, 5]);
                    ctx.font = "10px Arial";
                    ctx.fillStyle = "rgba(255,255,255,0.5)";

                    [-40, -70, -100].forEach(lv => {
                        const y = h - (((lv + 110) / 90) * h);
                        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
                        ctx.fillText(lv + " dBm", 5, y - 5);
                    });
                    ctx.setLineDash([]);
                    ctx.beginPath();
                    ctx.strokeStyle = accent;
                    ctx.lineWidth = 2;
                    ctx.lineJoin = 'round';

                    const step = gW / (this.maxPoints - 1);
                    this.points.forEach((p, i) => {
                        const x = lblW + (i * step), y = h - (((p + 110) / 90) * h);
                        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
                    });
                    ctx.stroke();

                    const grad = ctx.createLinearGradient(0, 0, 0, h);
                    grad.addColorStop(0, accent.includes('#') ? accent + '4D' : accent);
                    grad.addColorStop(1, 'rgba(0,0,0,0)');
                    ctx.lineTo(lblW + ((this.points.length - 1) * step), h);
                    ctx.lineTo(lblW, h);
                    ctx.fillStyle = grad;
                    ctx.fill();
                }
            };
        }
        if (initScan) {
            div.setAttribute('data-initscan', true);
            putJSONBusy('/beginFrequencyScan', {}, (err) => {
                if (!err) {
                    ['btnStopScanning'].forEach(id => get(id).style.display = '');
                    ['btnRestartScanning', 'btnCopyFrequency', 'btnCloseScanning'].forEach(id => get(id).style.display = 'none');
                }
            });
        }
        return div;
    }
    setScannedFrequency() {
        let div = get('divScanFrequency');
        let freq = parseFloat(div.getAttribute('data-frequency'));
        let slid = get('slidFrequency');
        slid.value = Math.round(freq * 1000);
        somfy.frequencyChanged(slid);
        closeOverlay(div);
    }
    stopScanningFrequency(killScan) {
        let div = get('divScanFrequency');
        if (!div) return;
        if (killScan !== true) {
            closeOverlay(div);
            return;
        }
        putJSONBusy('/endFrequencyScan', {}, (err, trans) => {
            if (err) {
                ui.serviceError(err);
            } else {
                let freqAttr = div.getAttribute('data-frequency');
                let freq = parseFloat(freqAttr);

                get('btnStopScanning').style.display = 'none';
                get('btnRestartScanning').style.display = '';
                if (typeof freq === 'number' && !isNaN(freq) && freq > 0) {
                    get('btnCopyFrequency').style.display = '';
                }
                get('btnCloseScanning').style.display = '';
            }
        });
    }
    terminateScanUI(killScan) {
        this.isScanClosing = true;

        if (this.scanObserver) {
            this.scanObserver.disconnect();
            this.scanObserver = null;
        }
        if (killScan) {
            putJSONBusy('/endFrequencyScan', {}, (err) => {
                if (err) console.error(err);
            });
        }
        let div = get('divScanFrequency');
        if (div) closeOverlay(div);
        setTimeout(() => { this.isScanClosing = false; }, 1000);
    }

    btnDown = null;
    btnTimer = null;

    setStep(type, stepValue) {
        const map = {
            'freq':      { slider: 'slidFrequency',   container: '#stepButtons' },
            'bandwidth': { slider: 'slidRxBandwidth', container: '#stepButtonsRx' },
            'deviation': { slider: 'slidDeviation',   container: '#stepButtonsDeviation' }
        };

        const config = map[type];
        if (!config) return;

        const slider = get(config.slider);
        if (slider) slider.step = stepValue;

        const container = document.querySelector(config.container);
        if (container) {
            container.querySelectorAll(".step-btn").forEach(btn => btn.classList.remove("active"));
            const activeBtn = container.querySelector(`.step-btn[onclick*="${stepValue}"]`);
            if (activeBtn) activeBtn.classList.add("active");
        }
    }
    stepValue(sliderId, direction) {
        const slider = get(sliderId);
        if (!slider) return;
        const currentVal = parseFloat(slider.value);
        const step = parseFloat(slider.step) || 1;
        const min = parseFloat(slider.min);
        const max = parseFloat(slider.max);
        let newVal = currentVal + (step * direction);
        if (newVal < min) newVal = min;
        if (newVal > max) newVal = max;

        slider.value = newVal;
        slider.dispatchEvent(new Event('input'));
    }
    checkEmptyState() {
        const getEl = id => get(id);
        const setDisp = (el, show, style = 'block') => { if (el) el.style.display = show ? style : 'none'; };
        const togglePair = (hasData, emptyId, contentId) => {
            setDisp(getEl(emptyId), !hasData);
            setDisp(getEl(contentId), hasData);
        };

        const divShadeControls = getEl('divShadeControls');
        const divGroupControls = getEl('divGroupControls');
        const divConfigPnl = getEl('divConfigPnl');
        const divHomePnl = getEl('divHomePnl');
        if (!divShadeControls || !divGroupControls) return;

        const activePill = document.querySelector('.room-pill.active');
        const currentRoomId = activePill ? parseInt(activePill.getAttribute('data-roomid'), 10) : 0;
        const isConfigOpen = divConfigPnl && divConfigPnl.style.display !== 'none';

        const shades = divShadeControls.querySelectorAll('.somfyShadeCtl');
        const groups = divGroupControls.querySelectorAll('.somfyGroupCtl');
        const hasRooms = _rooms.length > 1;
        const totalDevices = shades.length + groups.length;

        togglePair(hasRooms, 'divRoomEmptyState', 'divRoomListContent');
        togglePair(groups.length > 0, 'divGroupEmptyState', 'divGroupListContent');
        togglePair(shades.length > 0, 'divShadeEmptyState', 'divShadeListContent');

        const divRepeatList = getEl('divRepeatList');
        togglePair(divRepeatList && divRepeatList.children.length > 0, 'divRepeaterEmptyState', 'divRepeaterListContent');

        let visibleShadesCount = 0, visibleGroupsCount = 0;
        shades.forEach(el => { if (currentRoomId === 0 || parseInt(el.getAttribute('data-roomid'), 10) === currentRoomId) visibleShadesCount++; });
        groups.forEach(el => { if (currentRoomId === 0 || parseInt(el.getAttribute('data-roomid'), 10) === currentRoomId) visibleGroupsCount++; });
        const visibleCount = visibleShadesCount + visibleGroupsCount;
        const showLogoHeader = getEl('showLogoHeader');
        if (showLogoHeader) {
            showLogoHeader.style.visibility = (isConfigOpen || totalDevices > 0 || hasRooms) ? 'visible' : 'hidden';
        }
        if (divHomePnl) divHomePnl.style.display = isConfigOpen ? 'none' : '';

        const divGetStarted = getEl('divGetStarted');
        const divNoDevice = getEl('divNoDevice');

        if (totalDevices === 0 && !hasRooms) {
            setDisp(divGetStarted, !isConfigOpen, 'flex');
            setDisp(divNoDevice, false);
            setDisp(divShadeControls, false);
            setDisp(divGroupControls, false);
        } else {
            setDisp(divGetStarted, false);
            setDisp(divNoDevice, visibleCount === 0 && !isConfigOpen, 'flex');

            if (divShadeControls) divShadeControls.style.display = isConfigOpen ? 'none' : '';
            if (divGroupControls) divGroupControls.style.display = isConfigOpen ? 'none' : '';

            const divShadeListContent = getEl('divShadeListContent');
            const divGroupListContent = getEl('divGroupListContent');
            if (divShadeListContent) divShadeListContent.style.display = visibleShadesCount === 0 ? 'none' : '';
            if (divGroupListContent) divGroupListContent.style.display = visibleGroupsCount === 0 ? 'none' : '';
        }
    }
    procRoomAdded(room) {
        let r = _rooms.find(x => x.roomId === room.roomId);
        if (typeof r === 'undefined' || !r) {
            _rooms.push(room);
            _rooms.sort((a, b) => { return a.sortOrder - b.sortOrder });
            this.setRoomsList(_rooms);
            this.checkEmptyState();
        }
    }
    procRoomRemoved(room) {
        if (room.roomId === 0) return;
        let r = _rooms.find(x => x.roomId === room.roomId);
        if (typeof r !== 'undefined' && r.roomId === room.roomId) {
            _rooms = _rooms.filter(x => x.roomId === room.roomId);
            _rooms.sort((a, b) => { return a.sortOrder - b.sortOrder });
            this.setRoomsList(_rooms);
            this.checkEmptyState();
            let rs = get('divRoomSelector');
            let ss = get('divShadeControls');
            let gs = get('divGroupControls');
            let ctls = ss.querySelectorAll('.somfyShadeCtl');
            for (let i = 0; i < ctls.length; i++) {
                let x = ctls[i];
                if (parseInt(x.getAttribute('data-roomid'), 10) === room.roomId)
                    x.setAttribute('data-roomid', '0');
            }
            ctls = gs.querySelectorAll('.somfyGroupCtl');
            for (let i = 0; i < ctls.length; i++) {
                let x = ctls[i];
                if (parseInt(x.getAttribute('data-roomid'), 10) === room.roomId)
                    x.setAttribute('data-roomid', '0');
            }
            if (parseInt(rs.getAttribute('data-roomid'), 10) === room.roomId) this.selectRoom(0);
        }
    }
    selectRoom(roomId) {
        document.querySelectorAll('.room-pill').forEach(pill => {
            const pId = parseInt(pill.getAttribute('data-roomid'), 10);
            pill.classList.toggle('active', pId === roomId);
            // The active pill is only signalled by colour; expose the state to assistive tech too.
            pill.setAttribute('aria-pressed', pId === roomId ? 'true' : 'false');
        });

        const ctls = document.querySelectorAll('.somfyShadeCtl');
        ctls.forEach(x => {
            const rId = parseInt(x.getAttribute('data-roomid'), 10);
            x.style.display = (roomId === 0 || rId === roomId) ? '' : 'none';
        });
        this.checkEmptyState();
    }
    setRoomsList(rooms) {
        let divCfg = '';
        const homeName = tr('HOME');
        const slider = get('divRoomSelector');
        // The pill text is the room name, so it already is the accessible name: no aria-label
        // here, or voice-control users would have to say something they cannot see.
        let divPills = `<div class="room-pill active" role="button" tabindex="0" aria-pressed="true" data-roomid="0" onclick="somfy.selectRoom(0)">${homeName}</div>`;
        let divOpts = `<option value="0">${homeName}</option>`;
        _rooms = [{ roomId: 0, name: homeName }];

        rooms.sort((a, b) => a.sortOrder - b.sortOrder);
        rooms.forEach(room => {
            divPills += `<div class="room-pill animScale" role="button" tabindex="0" aria-pressed="false" data-roomid="${room.roomId}" onclick="somfy.selectRoom(${room.roomId})">${esc(room.name)}</div>`;
            // ... foreach room ...
            divCfg += `<div class="somfyRoom room-draggable" data-roomid="${room.roomId}">
            <div class="drag-handle"><svg class="icon-svg"><use href=#svg-drag></use></svg></div>
            <div class="room-name"><span class="name-text">${esc(room.name)}</span></div><span class="vr"></span>
            <div class="divEditDelete-svg" ${a11yBtn(trf('A11Y_EDIT', room.name))} onclick="somfy.openEditRoom(${room.roomId});"><svg class="icon-svg"><use href=#svg-edit></use></svg></div>
            <div class="divEditDelete-svg" ${a11yBtn(trf('A11Y_DELETE', room.name))} onclick="somfy.deleteRoom(${room.roomId});"><svg class="icon-svg"><use href=#svg-close></use></svg></div>
            </div>`;

            divOpts += `<option value="${room.roomId}">${esc(room.name)}</option>`;
            _rooms.push(room);
        });

        slider.innerHTML = divPills;
        slider.style.display = 'flex';

        const navContainer = document.querySelector('.room-nav-container');
        if(navContainer) navContainer.style.display = rooms.length === 0 ? 'none' : 'flex';

        get('divRoomList').innerHTML = divCfg;
        get('selShadeRoom').innerHTML = divOpts;
        get('selGroupRoom').innerHTML = divOpts;

        this.checkEmptyState();
        this.setListDraggable(get('divRoomList'), '.room-draggable', (list) => {
            let order = Array.from(list.querySelectorAll('.room-draggable')).map(item =>
            parseInt(item.getAttribute('data-roomid'), 10)
            );
            putJSONBusy('/roomSortOrder', order, (err) => {
                if (err) ui.serviceError(err);
                else this.updateRoomsList();
            });
        });
        this.initRoomScroll(slider);
    }
    initRoomScroll(c) {
        const update = () => {
            const btnL = get('btnScrollLeft'), btnR = get('btnScrollRight');
            if (c && btnL && btnR) {
                const canL = c.scrollLeft > 10;
                const canR = c.scrollWidth > (c.scrollLeft + c.clientWidth + 10);
                btnL.style.display = canL ? 'block' : 'none';
                btnR.style.display = canR ? 'block' : 'none';
                // Edge fades signaling that more rooms are scrolled off-screen.
                c.classList.toggle('can-left', canL);
                c.classList.toggle('can-right', canR);
            }
        };
        let isDown = 0, startX, scrollLeft;

        c.addEventListener('wheel', (e) => {
            if (e.deltaY) { e.preventDefault(); c.scrollLeft += e.deltaY; }
        }, { passive: false });

        c.onmousedown = (e) => {
            isDown = 1;
            c.style.cursor = 'grabbing';
            startX = e.pageX - c.offsetLeft;
            scrollLeft = c.scrollLeft;
        };

        const stop = () => { isDown = 0; c.style.cursor = 'grab'; };
        c.onmouseleave = c.onmouseup = stop;

        c.onmousemove = (e) => {
            if (!isDown) return;
            e.preventDefault();
            c.scrollLeft = scrollLeft - (e.pageX - c.offsetLeft - startX) * 2;
        };

        c.onscroll = update;
        window.onresize = update;
        setTimeout(update, 150);
        this.checkArrows = update;
    }
    scrollRooms(dir) {
        get('divRoomSelector')?.scrollBy({ left: dir * 200, behavior: 'smooth' });
    }
    setRepeaterList(addresses) {
        let divCfg = '';
        if (typeof addresses !== 'undefined') {
            for (let i = 0; i < addresses.length; i++) {

                divCfg += `<div class="somfyRepeater" data-address="${addresses[i]}"><div class="idRemoteAddress"><span class="AddrId-label">${tr("ADDR")}</span><span class="repeater-name">${addresses[i]}</span></div><div class="divEditDelete-svg" ${a11yBtn(trf('A11Y_UNLINK_REPEATER', addresses[i]))} onclick="somfy.unlinkRepeater('${addresses[i]}');"><svg class="icon-svg"><use href=#svg-close></use></svg></div></div>`;
            }
        }
        get('divRepeatList').innerHTML = divCfg;
        this.checkEmptyState();
    }
    setShadesList(shades) {
        this.shades = shades;
        let divCfg = '';
        let divCtl = '';
        shades.sort((a, b) => { return a.sortOrder - b.sortOrder });
        if(DBG) console.log(shades);
        let roomId = document.querySelector('.room-pill.active') ? parseInt(document.querySelector('.room-pill.active').getAttribute('data-roomid'), 10) : 0;
        let vrList = get('selVRMotor');
        // First get the optiongroup for the shades.
        let optGroup = get('optgrpVRShades');
        if (typeof shades === 'undefined' || shades.length === 0) {
            if (optGroup && typeof optGroup !== 'undefined') optGroup.remove();
        }
        else {
            if (typeof optGroup === 'undefined' || !optGroup) {
                optGroup = document.createElement('optgroup');
                optGroup.setAttribute('id', 'optgrpVRShades');
                optGroup.setAttribute('label', 'Shades');
                vrList.appendChild(optGroup);
            }
            else {
                optGroup.innerHTML = '';
            }
        }
        for (let i = 0; i < shades.length; i++) {
            let shade = shades[i];
            let room = _rooms.find(x => x.roomId === shade.roomId) || { roomId: 0, name: '' };
            let isLightOn = (shade.flags & 0x08);
            let isSunOn = (shade.flags & 0x01);
            let st = this.shadeTypes.find(x => x.type === shade.shadeType) || { type: shade.shadeType, ico: 'svg-window-shade' };

            divCfg += `<div class="somfyShade shade-draggable" draggable="true" data-roomid="${shade.roomId}" data-mypos="${shade.myPos}" data-shadeid="${shade.shadeId}" data-remoteaddress="${shade.remoteAddress}" data-tilt="${shade.tiltType}" data-shadetype="${shade.shadeType}" data-flipposition="${shade.flipPosition ? 'true' : 'false'}"><div class="drag-handle"><svg class="icon-svg"><use href=#svg-drag></use></svg></div><div class="shade-name"><div class="cfg-room">${esc(room.name)}</div><div class="name-text">${esc(shade.name)}</div></div><div class="idRemoteAddress"><span class="AddrId-label">${tr("ID")}</span><span class="shade-address">${shade.remoteAddress}</span></div><span class="vr"></span><div class="divEditDelete-svg" ${a11yBtn(trf('A11Y_EDIT', shade.name))} onclick="somfy.openEditShade(${shade.shadeId});"><svg class="icon-svg"><use href=#svg-edit></use></svg></div><div class="divEditDelete-svg" ${a11yBtn(trf('A11Y_DELETE', shade.name))} onclick="somfy.deleteShade(${shade.shadeId});"><svg class="icon-svg"><use href=#svg-close></use></svg></div></div>`;
            // --- SECTION CONTROLE ---
            divCtl += `<div class="somfyShadeCtl" style="${roomId === 0 || roomId === room.roomId ? '' : 'display:none'}" data-shadeid="${shade.shadeId}" data-roomid="${shade.roomId}" data-direction="${shade.direction}" data-remoteaddress="${shade.remoteAddress}" data-position="${shade.position}" data-target="${shade.target}" data-mypos="${shade.myPos}" data-mytiltpos="${shade.myTiltPos}" data-shadetype="${shade.shadeType}" data-tilt="${shade.tiltType}" data-flipposition="${shade.flipPosition ? 'true' : 'false'}"
            data-windy="${(shade.flags & 0x10) === 0x10 ? 'true' : 'false'}" data-sunny="${(shade.flags & 0x20) === 0x20 ? 'true' : 'false'}">
            <div class="shadectl-side-handle" ${a11yBtn(trf('A11Y_SET_POS', shade.name))} onclick="event.stopPropagation(); somfy.openSetPosition(${shade.shadeId});"><svg class="handle-icon"><use href="#svg-arrowRight"></use></svg></div>
            <div class="shadectl-right-content">
            <div class="shadectl-main-content">
            <div class="shadectl-header-row"><span class="shadectl-name">${esc(shade.name)}</span></div>
            <div class="shade-icon" data-shadeid="${shade.shadeId}">
            <svg class="somfy-shade-icon" data-shadeid="${shade.shadeId}" style="--shade-position:${shade.flipPosition ? 100 - shade.position : shade.position}; --fpos:${shade.flipPosition ? 100 - shade.position : shade.position}%">
            <use href="#${st.ico}"></use>
            </svg>
            </div>
            <div class="shade-name">
            <span class="shadectl-room">${esc(room.name)}</span>`;
            divCtl += `<span class="shadectl-mypos"><span class="val-pos">${tr('SHADE_POS')}${shadePosLabel(shade.position, shade.flipPosition)}</span>`;
            if (shade.tiltType !== 0) divCtl += `<span class="val-pos"> ${tr('SHADE_TILT')}${shade.tiltPosition}%</span>`;
            // Surface the hidden long-press actions (set My / tilt) as tooltips.
            const tiltTitle = shade.tiltType !== 0 ? ` title="${tr('TT_HOLD_TILT')}"` : '';
            divCtl += `</span></div>
            <div class="shadectl-buttons" data-shadeType="${shade.shadeType}">
            <div class="button-outline cmd-button btn-somfy-svg animScale" ${a11yBtn(trf('A11Y_CMD_UP', shade.name))} data-cmd="up" data-shadeid="${shade.shadeId}"${tiltTitle}><svg><use href="#svg-up"></use></svg></div>
            <div class="button-outline cmd-button btn-somfy-svg animScale" ${a11yBtn(trf('A11Y_CMD_MY', shade.name))} data-cmd="my" data-shadeid="${shade.shadeId}" title="${tr('TT_HOLD_MY')}"><svg><use href="#svg-my"></use></svg></div>
            <div class="button-outline cmd-button btn-somfy-svg animScale" ${a11yBtn(trf('A11Y_CMD_DOWN', shade.name))} data-cmd="down" data-shadeid="${shade.shadeId}"${tiltTitle}><svg><use href="#svg-down"></use></svg></div>
            <div class="button-outline cmd-button btn-somfy-svg-wide animScale" ${a11yBtn(trf('A11Y_CMD_TOGGLE', shade.name))} data-cmd="toggle" data-shadeid="${shade.shadeId}"><svg><use href="#svg-toggle"></use></svg></div>
            </div>
            <div class="shadectl-status-bar">
            <div class="shadectl-status-left">
            <div class="indicator indicator-wind"><svg><use href="#indic-wind"></use></svg></div>
            <div class="indicator indicator-sun"><svg><use href="#indic-sun"></use></svg></div>
            <div class="val-my myShade-badge">My: ${shade.myPos === -1 ? '---' : shade.myPos + '%'}</div>`;
            if (shade.tiltType !== 0) divCtl += `<div class="val-tilt myShade-badge">${tr('SHADE_MY_TILT')}${shade.myTiltPos === -1 ? '---' : shade.myTiltPos + '%'}</div>`;
            divCtl += `</div>
            <div class="status-group-right">
            <div class="button-light cmd-button" ${a11yBtn(trf('A11Y_CMD_LIGHT', shade.name))} data-cmd="light" data-shadeid="${shade.shadeId}" data-on="${isLightOn ? 'true' : 'false'}" style="${!shade.light ? 'display:none' : ''}">
            <svg><use href="#svg-lightbulb"></use></svg>
            </div>`;
            if (shade.sunSensor) {
                divCtl += `<div class="button-sunflag cmd-button" ${a11yBtn(trf('A11Y_CMD_SUN', shade.name))} data-cmd="sunflag" data-shadeid="${shade.shadeId}" data-on="${isSunOn ? 'true' : 'false'}">
                <svg><use href="#svg-sun"></use></svg>
                </div>`;
            }
            divCtl += `<div class="button-my" ${a11yBtn(trf('A11Y_SET_MY', shade.name))} onclick="event.stopPropagation(); somfy.openSetMyPosition(${shade.shadeId});">
            <svg><use href="#svg-favori"></use></svg>
            </div></div></div></div></div></div></div>`;

            let opt = document.createElement('option');
            opt.textContent = shade.name;

            opt.setAttribute('data-address', shade.remoteAddress);
            opt.setAttribute('data-type', 'shade');
            opt.setAttribute('data-shadetype', shade.shadeType);
            opt.setAttribute('data-shadeid', shade.shadeId);
            opt.setAttribute('data-bitlength', shade.bitLength);
            optGroup.appendChild(opt);
        }
        let sopt = vrList.options[vrList.selectedIndex];
        get('divVirtualRemote').setAttribute('data-bitlength', sopt ? sopt.getAttribute('data-bitlength') : 'none');
        get('divShadeList').innerHTML = divCfg;
        let shadeControls = get('divShadeControls');
        shadeControls.innerHTML = divCtl;
        this.checkEmptyState();
        // Long-press handling for the shade command buttons.  Mouse and touch share
        // the same handlers so the two input methods behave identically: a tap sends
        // the command, holding 2s triggers the secondary action (set My / tilt).
        // While armed, an accent ring grows on the button (.lp-hold) so the user can
        // see that keeping it pressed does something.
        let btns = shadeControls.querySelectorAll('div.cmd-button');
        const lpClear = (btn) => {
            if (this.btnTimer) { clearTimeout(this.btnTimer); this.btnTimer = null; }
            btn.classList.remove('lp-hold');
        };
        const lpArm = (btn, fn) => {
            btn.classList.add('lp-hold');
            this.btnTimer = setTimeout(() => { btn.classList.remove('lp-hold'); fn(); }, 2000);
        };
        const onCmdDown = (event) => {
            lpClear(event.currentTarget);
            if(DBG) console.log({ msg: 'cmd-down', evt: event });
            let elShade = event.currentTarget.closest('div.somfyShadeCtl');
            let cmd = event.currentTarget.getAttribute('data-cmd');
            let shadeId = parseInt(event.currentTarget.getAttribute('data-shadeid'), 10);
            this.btnDown = new Date().getTime();
            if (cmd === 'light' || cmd === 'sunflag') return;
            if (cmd === 'my') {
                if (parseInt(elShade.getAttribute('data-direction'), 10) === 0)
                    lpArm(event.currentTarget, () => this.openSetMyPosition(shadeId));
            }
            else if (makeBool(elShade.getAttribute('data-tilt')))
                lpArm(event.currentTarget, () => this.sendTiltCommand(shadeId, cmd));
        };
        const onCmdUp = (event) => {
            if(DBG) console.log({ msg: 'cmd-up', evt: event });
            let cmd = event.currentTarget.getAttribute('data-cmd');
            let shadeId = parseInt(event.currentTarget.getAttribute('data-shadeid'), 10);
            if (this.btnTimer) {
                lpClear(event.currentTarget);
                // Released before the 2s threshold: plain tap, send the command.
                // Past 2s the long-press action already fired from the timer.
                if (new Date().getTime() - this.btnDown <= 2000) this.sendCommand(shadeId, cmd);
            }
            else if (cmd === 'light') {
                event.currentTarget.setAttribute('data-on', !makeBool(event.currentTarget.getAttribute('data-on')));
            }
            else if (cmd === 'sunflag') {
                if (makeBool(event.currentTarget.getAttribute('data-on')))
                    this.sendCommand(shadeId, 'flag');
                else
                    this.sendCommand(shadeId, 'sunflag');
            }
            else this.sendCommand(shadeId, cmd);
        };
        for (let i = 0; i < btns.length; i++) {
            btns[i].addEventListener('mousedown', onCmdDown, true);
            btns[i].addEventListener('mouseup', onCmdUp, true);
            btns[i].addEventListener('touchstart', (event) => { this._touchMoved = false; onCmdDown(event); }, true);
            // A scroll that starts on the button must not fire the command.
            btns[i].addEventListener('touchmove', (event) => { this._touchMoved = true; lpClear(event.currentTarget); }, true);
            // preventDefault stops the browser from synthesizing a mouseup afterwards,
            // which would double-send the command.
            btns[i].addEventListener('touchend', (event) => {
                event.preventDefault();
                if (!this._touchMoved) onCmdUp(event); else lpClear(event.currentTarget);
            }, true);
            // Dragging the pointer/finger away cancels a pending long-press instead of
            // letting it fire under the user's nose.
            btns[i].addEventListener('mouseleave', (event) => lpClear(event.currentTarget), true);
            btns[i].addEventListener('touchcancel', (event) => lpClear(event.currentTarget), true);
            // These buttons are driven by mousedown/mouseup, which a keyboard never fires, so
            // Enter/Space reached them and did nothing. The delegated role="button" handler
            // dispatches a synthetic click (detail === 0); a real pointer click always has
            // detail >= 1, so keying off it runs the plain-tap path exactly once.
            btns[i].addEventListener('click', (event) => { if (event.detail === 0) onCmdUp(event); });
        }
        this.setListDraggable(get('divShadeList'), '.shade-draggable', (list) => {
            // Get the shade order
            let items = list.querySelectorAll('.shade-draggable');
            let order = [];
            for (let i = 0; i < items.length; i++) {
                order.push(parseInt(items[i].getAttribute('data-shadeid'), 10));
                // Reorder the shades on the main page.
            }
            putJSONBusy('/shadeSortOrder', order, (err) => {
                for (let i = order.length - 1; i >= 0; i--) {
                    let el = shadeControls.querySelector(`.somfyShadeCtl[data-shadeid="${order[i]}"`);
                    if (el) {
                        shadeControls.prepend(el);
                    }
                }
            });
        });
    }
    setListDraggable(list, cl, cb) {
        let el = null, gh = null, ch = false, sA = null;
        let r = null, sY = 0, cY = 0, its = [];

        const stop = () => { if(sA) cancelAnimationFrame(sA); sA = null; };
        const scroll = (y) => {
            stop();
            let sp = 0;
            if (y < 100) sp = -14;
            else if (y > window.innerHeight - 100) sp = 14;

            if (sp && gh) {
                window.scrollBy(0, sp);
                cY += sp;
                gh.style.transform = "translateY(" + (cY - sY) + "px)";
                sA = requestAnimationFrame(() => scroll(y));
                sort();
            }
        };
        const sort = () => {
            if (!el || !gh) return;
            let mid = gh.getBoundingClientRect().top + (r.height / 2);
            let idx = its.indexOf(el);

            its.forEach((it, i) => {
                if (it === el) return;
                let iM = it.getBoundingClientRect().top + (r.height / 2);
                let o = 0;
                if (mid < iM && its.indexOf(el) > i) {
                    o = r.height + 10;
                    if(i < idx) idx = i;
                } else if (mid > iM && its.indexOf(el) < i) {
                    o = -(r.height + 10);
                    if(i >= idx) idx = i + 1;
                }
                it.style.transform = o ? "translateY(" + o + "px)" : "";
            });
            el.dataset.idx = idx;
        };
        // The window listeners only make sense while a drag is actually running.
        // Binding them at setup time leaked four handlers per list refresh (the shade and
        // group lists are rebuilt on every socket update), so they are now bound on drag
        // start and released on drag end.
        const bindWindow = () => {
            window.addEventListener('touchmove', move, { passive: false });
            window.addEventListener('touchend', end);
            window.addEventListener('mousemove', move);
            window.addEventListener('mouseup', end);
        };
        const unbindWindow = () => {
            window.removeEventListener('touchmove', move, { passive: false });
            window.removeEventListener('touchend', end);
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', end);
        };
        const end = () => {
            unbindWindow();
            stop();
            if (gh) { gh.remove(); gh = null; }
            if (el) {
                el.classList.remove('drag-orig');
                let n = parseInt(el.dataset.idx, 10), o = its.indexOf(el);
                if (!isNaN(n) && n !== o) {
                    list.insertBefore(el, its[n] || null);
                    ch = true;
                }
            }
            its.forEach(it => it.style.transform = "");
            if (ch && typeof cb === 'function') cb(list);
            el = null; ch = false; its = [];
        };
        const move = (e) => {
            if (!gh) return;
            if (e.cancelable) e.preventDefault();
            let t = e.touches ? e.touches[0] : e;
            cY = t.clientY;
            gh.style.transform = "translateY(" + (cY - sY) + "px)";
            scroll(cY);
            sort();
        };
        const start = (e, it) => {
            if (e.type === 'mousedown') e.preventDefault();
            el = it;
            r = el.getBoundingClientRect();
            its = Array.prototype.slice.call(list.querySelectorAll(cl));
            let t = e.touches ? e.touches[0] : e;
            sY = cY = t.clientY;

            gh = el.cloneNode(true);
            gh.className = 'drag-ghost';

            const style = window.getComputedStyle(el);
            Object.assign(gh.style, {
                width: r.width + 'px',
                height: r.height + 'px',
                top: r.top + 'px',
                left: r.left + 'px',
            });
            document.body.appendChild(gh);
            el.classList.add('drag-orig');
            if (navigator.vibrate) navigator.vibrate(30);
            bindWindow();
        };

        // The per-item handlers die with the items, which are replaced wholesale on every
        // refresh, so they need no explicit teardown.
        list.querySelectorAll(cl).forEach(it => {
            let h = it.querySelector('.drag-handle');
            if (h) {
                h.addEventListener('touchstart', (e) => start(e, it), { passive: true });
                h.addEventListener('mousedown', (e) => start(e, it));
            }
        });
    }
    setGroupsList(groups) {
        this.groups = groups;
        let divCfg = '';
        let divCtl = '';
        let vrList = get('selVRMotor');
        let optGroup = get('optgrpVRGroups');

        if (typeof groups === 'undefined' || groups.length === 0) {
            if (optGroup) optGroup.remove();
        } else {
            if (!optGroup) {
                optGroup = document.createElement('optgroup');
                optGroup.setAttribute('id', 'optgrpVRGroups');
                optGroup.setAttribute('label', 'Groups');
                vrList.appendChild(optGroup);
            } else {
                optGroup.innerHTML = '';
            }
        }
        let roomId = document.querySelector('.room-pill.active') ? parseInt(document.querySelector('.room-pill.active').getAttribute('data-roomid'), 10) : 0;

        if (typeof groups !== 'undefined') {
            groups.sort((a, b) => a.sortOrder - b.sortOrder);

            for (let i = 0; i < groups.length; i++) {
                let group = groups[i];
                let room = _rooms.find(x => x.roomId === group.roomId) || { roomId: 0, name: '' };
                // --- Section Configuration ---
                divCfg += `<div class="somfyGroup group-draggable" draggable="true" data-roomid="${group.roomId}" data-groupid="${group.groupId}" data-remoteaddress="${group.remoteAddress}"><div class="drag-handle"><svg class="icon-svg"><use href=#svg-drag></use></svg></div> <div class="group-name"><div class="cfg-room">${esc(room.name)}</div><div class="name-text">${esc(group.name)}</div></div><div class="idRemoteAddress"><span class="AddrId-label">${tr("ID")}</span><span class="group-address">${group.remoteAddress}</span></div><span class="vr"></span><div class="divEditDelete-svg" ${a11yBtn(trf('A11Y_EDIT', group.name))} onclick="somfy.openEditGroup(${group.groupId});"><svg class="icon-svg"><use href=#svg-edit></use></svg></div><div class="divEditDelete-svg" ${a11yBtn(trf('A11Y_DELETE', group.name))} onclick="somfy.deleteGroup(${group.groupId});"><svg class="icon-svg" style="color: var(--danger-color, red);"><use href=#svg-close></use></svg></div></div>`;
                // --- Control section (divCtl) ---
                divCtl += `<div class="somfyGroupCtl" style="${roomId === 0 || roomId === room.roomId ? '' : 'display:none'}" data-groupId="${group.groupId}" data-roomid="${group.roomId}" data-remoteaddress="${group.remoteAddress}">
                <div class="group-name">
                <span class="groupctl-room">${esc(room.name)}</span>
                <span class="groupctl-name">${esc(group.name)}</span>
                <div class="groupctl-shades">`;
                if (typeof group.linkedShades !== 'undefined') {
                    divCtl += `<label>Members:</label><span>${group.linkedShades.length}</span>`;
                }
                divCtl += `</div></div>
                <div class="groupctl-buttons">
                <div class="button-sunflag cmd-button" ${a11yBtn(trf('A11Y_CMD_SUN', group.name))} data-cmd="sunflag" data-groupid="${group.groupId}" data-on="${(group.flags & 0x01) ? 'true' : 'false'}" style="${!group.sunSensor ? 'display:none' : ''}"><svg><use href="#svg-sun"></use></svg></div>
                <div class="button-outline cmd-button btn-somfy-svg animScale" ${a11yBtn(trf('A11Y_CMD_UP', group.name))} data-cmd="up" data-groupid="${group.groupId}"><svg><use href="#svg-up"></use></svg></div>
                <div class="button-outline cmd-button btn-somfy-svg animScale" ${a11yBtn(trf('A11Y_CMD_MY', group.name))} data-cmd="my" data-groupid="${group.groupId}"><svg><use href="#svg-my"></use></svg></div>
                <div class="button-outline cmd-button btn-somfy-svg animScale" ${a11yBtn(trf('A11Y_CMD_DOWN', group.name))} data-cmd="down" data-groupid="${group.groupId}"><svg><use href="#svg-down"></use></svg></div>
                </div>
                </div>`;

                let opt = document.createElement('option');
                opt.textContent = group.name;
                opt.setAttribute('data-address', group.remoteAddress);
                opt.setAttribute('data-type', 'group');
                opt.setAttribute('data-groupid', group.groupId);
                opt.setAttribute('data-bitlength', group.bitLength);
                optGroup.appendChild(opt);
            }
        }
        let sopt = vrList.options[vrList.selectedIndex];
        get('divVirtualRemote').setAttribute('data-bitlength', sopt ? sopt.getAttribute('data-bitlength') : 'none');
        get('divGroupList').innerHTML = divCfg;
        let groupControls = get('divGroupControls');
        groupControls.innerHTML = divCtl;
        this.checkEmptyState();
        // Attach the timer for setting the My Position for the Group.
        let btns = groupControls.querySelectorAll('div.cmd-button');
        for (let i = 0; i < btns.length; i++) {
            btns[i].addEventListener('click', (event) => {
                if(DBG) console.log(this);
                if(DBG) console.log(event);
                let groupId = parseInt(event.currentTarget.getAttribute('data-groupid'), 10);
                let cmd = event.currentTarget.getAttribute('data-cmd');
                if (cmd === 'sunflag') {
                    if (makeBool(event.currentTarget.getAttribute('data-on')))
                        this.sendGroupCommand(groupId, 'flag');
                    else
                        this.sendGroupCommand(groupId, 'sunflag');
                }
                else
                    this.sendGroupCommand(groupId, cmd);
            }, true);
        }
        this.setListDraggable(get('divGroupList'), '.group-draggable', (list) => {
            // Get the shade order
            let items = list.querySelectorAll('.group-draggable');
            let order = [];
            for (let i = 0; i < items.length; i++) {
                order.push(parseInt(items[i].getAttribute('data-groupid'), 10));
                // Reorder the shades on the main page.
            }
            putJSONBusy('/groupSortOrder', order, (err) => {
                for (let i = order.length - 1; i >= 0; i--) {
                    let el = groupControls.querySelector(`.somfyGroupCtl[data-groupid="${order[i]}"`);
                    if (el) {
                        groupControls.prepend(el);
                    }
                }
            });
        });
    }
    closeShadePositioners() {
        let ctls = document.querySelectorAll('.shade-positioner');
        for (let i = 0; i < ctls.length; i++) {
            if(DBG) console.log('Closing shade positioner');
            ctls[i].remove();
        }
    }
    openSetMyPosition(shadeId) {
        if (typeof shadeId === 'undefined') return;

        const shade = document.querySelector(`div.somfyShadeCtl[data-shadeid="${shadeId}"]`);
        if (!shade) return;

        const arrowUse = shade.querySelector('.handle-icon use');

        document.querySelectorAll('.shade-positioner').forEach(el => {
            el.remove();
            document.querySelectorAll('.handle-icon use').forEach(u => u.setAttribute('href', '#svg-arrowRight'));
        });

        const currPos = parseInt(shade.getAttribute('data-position'), 10) || 0;
        const currTiltPos = parseInt(shade.getAttribute('data-tiltposition'), 10) || 0;
        const myPos = parseInt(shade.getAttribute('data-mypos'), 10);
        const myTiltPos = parseInt(shade.getAttribute('data-mytiltpos'), 10);
        const tiltType = parseInt(shade.getAttribute('data-tilt'), 10) || 0;
        const lbl = makeBool(shade.getAttribute('data-flipposition')) ? `% ${tr('POPUP_OPEN')}` : `% ${tr('POPUP_CLOSED')}`;

        const positionSlider = (tiltType !== 3) ? `
        <div class="slider-group">
        <div class="slider-header"><span class="title">${tr('POPUP_TARGET_POSITION')}</span><span class="val"><span id="spanShadeTarget">${currPos}</span> ${lbl}</span></div>
        <input id="slidShadeTarget" type="range" min="0" max="100" step="1" value="${currPos}" oninput="get('spanShadeTarget').innerHTML=this.value;">
        </div>` : '';

        const tiltSlider = (tiltType > 0) ? `
        <div class="slider-group">
        <div class="slider-header"><span class="title">${tr('POPUP_TARGET_TILT_POSITION')}</span><span class="val"><span id="spanShadeTiltTarget">${currTiltPos}</span> ${lbl}</span></div>
        <input id="slidShadeTiltTarget" type="range" min="0" max="100" step="1" value="${currTiltPos}" oninput="get('spanShadeTiltTarget').innerHTML=this.value;">
        </div>` : '';

        const div = document.createElement('div');
        div.className = 'shade-positioner shade-positioner-popup';
        div.setAttribute('data-shadeid', shadeId);
        div.onclick = (e) => e.stopPropagation();
        div.innerHTML = `
        <div class="shade-positioner-inner">
        ${positionSlider}${tiltSlider}
        <div class="popup-actions">
        <button id="btnSetMyPosition" pop type="button">${tr("BT_SET_MY_POSITION")}</button>
        <button id="btnCancelMy" pop line type="button">${tr("BT_CANCEL_1")}</button>
        </div>
        </div>`;

        shade.appendChild(div);
        if (arrowUse) arrowUse.setAttribute('href', '#svg-arrowLeft');

        const animateClose = () => {
            div.classList.add('popup-slide-out');
            if (arrowUse) arrowUse.setAttribute('href', '#svg-arrowRight');
            setTimeout(() => { div.remove(); }, 300);
        };
        const elTarget = div.querySelector('#slidShadeTarget');
        const elTiltTarget = div.querySelector('#slidShadeTiltTarget');
        const elBtnSave = div.querySelector('#btnSetMyPosition');
        const elBtnCancel = div.querySelector('#btnCancelMy');
        const fnUpdateUI = () => {
            const pos = elTarget ? parseInt(elTarget.value, 10) : 0;
            const tilt = elTiltTarget ? parseInt(elTiltTarget.value, 10) : 0;
            const isSameAsMy = (tiltType === 3) ? (tilt === myTiltPos) : (pos === myPos && (tiltType === 0 || tilt === myTiltPos));

            if (isSameAsMy) {
                elBtnSave.innerHTML = tr('BT_CLEAR_MY_POSITION');
                elBtnSave.style.background = 'var(--txtwarning-color)';
            } else {
                elBtnSave.innerHTML = tr('BT_SET_MY_POSITION');
                elBtnSave.style.background = '';
            }
        };
        if (elTarget) elTarget.oninput = () => {
            get('spanShadeTarget').innerHTML = elTarget.value;
            fnUpdateUI();
        };
        if (elTiltTarget) elTiltTarget.oninput = () => {
            get('spanShadeTiltTarget').innerHTML = elTiltTarget.value;
            fnUpdateUI();
        };

        elBtnCancel.onclick = (e) => { e.preventDefault(); animateClose(); };
        elBtnSave.onclick = (e) => {
            e.preventDefault();
            const pos = elTarget ? parseInt(elTarget.value, 10) : 0;
            const tilt = elTiltTarget ? parseInt(elTiltTarget.value, 10) : 0;
            somfy.sendShadeMyPosition(shadeId, pos, tilt);
            animateClose();
        };

        setTimeout(() => {
            document.body.addEventListener('click', animateClose, { once: true });
        }, 100);

        fnUpdateUI();
    }
    sendShadeMyPosition(shadeId, pos, tilt) {
        if(DBG) console.log(`Sending My Position for shade id ${shadeId} to ${pos} and ${tilt}`);
        let overlay = ui.waitMessage(get('divContainer'));
        putJSON('/setMyPosition', { shadeId: shadeId, pos: pos, tilt: tilt }, (err, response) => {
            this.closeShadePositioners();
            overlay.remove();
            if(DBG) console.log(response);
        });
    }
    setLinkedRemotesList(shade) {
        const container = get('divLinkedRemoteList');
        const remotes = shade.linkedRemotes || [];

        if (remotes.length === 0) {
            container.innerHTML = '';
            container.style.display = 'none';
            return;
        }
        container.style.display = 'block';

        let html = `<div class="linkedRheader">${tr("LINKED_R")}</div>`;

        html += `<div class="linkedScrollArea">`;
        html += remotes.map((remote, i) => `
        ${i > 0 ? '<hr>' : ''}
        <div class="somfyLinkedRemote" data-shadeid="${shade.shadeId}" data-remoteaddress="${remote.remoteAddress}"><div class="linkedWrap"><svg class="icon-svg"><use href=#svg-remote></use></svg></div><div class="linkedContent"><div class="label">${tr("LINKED_R_T")} ${i + 1}</div><div><span class="uniStatus">${tr("ADDR")} ${remote.remoteAddress}, </span><span class="uniStatus">${tr("CODE")} ${remote.lastRollingCode}</span></div></div><div class="button-outline-svg svgDelete" ${a11yBtn(trf('A11Y_UNLINK_REMOTE', remote.remoteAddress))} onclick="somfy.unlinkRemote(${shade.shadeId}, '${remote.remoteAddress}');"><svg class="icon-svg"><use href=#svg-close></use></svg></div></div>
        `).join('');

        html += `</div>`;

        container.innerHTML = html;
    }
    setLinkedShadesList(group) {
        const container = get('divLinkedShadeList');
        const btnContainer = get('divSomfyGroupButtons');
        const btnLink = get('btnLinkShade');
        const shades = group.linkedShades || [];

        if (shades.length === 0) {
            container.innerHTML = '';
            container.style.display = 'none';
        } else {
            container.style.display = 'block';
        }
        const hasShades = shades.length > 0;
        if (btnContainer) {
            if (!hasShades) {
                btnContainer.classList.add('disabled');
            } else {
                btnContainer.classList.remove('disabled');
            }
        }
        ui.setFocus(btnLink, !hasShades);

        if (!hasShades) return;

        let html = `<div class="linkedRheader">${tr("GROUP_LINKED_S")}</div>`;

        html += `<div class="linkedScrollArea">`;
        html += shades.map((shade, i) => `
        ${i > 0 ? '<hr>' : ''}
        <div class="somfyLinkedRemote" data-shadeid="${shade.shadeId}" data-remoteaddress="${shade.remoteAddress}">
        <div class="linkedWrap"><svg class="icon-svg"><use href=#svg-simpleShutter></use></svg></div><div class="linkedContent"><div class="label">${esc(shade.name)}</div><div><span class="uniStatus">${tr("ADDR")} ${shade.remoteAddress}</span></div></div><div class="button-outline-svg svgDelete" ${a11yBtn(trf('A11Y_UNLINK_SHADE', shade.name))} onclick="somfy.unlinkGroupShade(${group.groupId}, ${shade.shadeId});"><svg class="icon-svg"><use href=#svg-close></use></svg></div></div>
        `).join('');

        html += `</div>`;

        container.innerHTML = html;
    }
    procGroupState(state) {
        if(DBG) console.log(state);
        let flags = document.querySelectorAll(`.button-sunflag[data-groupid="${state.groupId}"]`);
        for (let i = 0; i < flags.length; i++) {
            flags[i].style.display = state.sunSensor ? '' : 'none';
            flags[i].setAttribute('data-on', (state.flags & 0x01) === 0x01 ? 'true' : 'false');
        }
    }
    procShadeState(state) {
        const g = get, sId = state.shadeId;

        document.querySelectorAll(`.somfy-shade-icon[data-shadeid="${sId}"]`).forEach(ico => {
            const p = state.flipPosition ? 100 - state.position : state.position;
            ico.style.setProperty('--shade-position', p);
            ico.style.setProperty('--fpos', state.position + '%');
        });
        if (g('spanShadeId')?.innerText == sId) {
            if (g('valPos')) g('valPos').innerText = state.position;

            const lTC = g('labelTiltContainer'), sVT = g('valTilt');
            if (state.tiltType !== 0) {
                if (lTC) lTC.style.display = 'block';
                if (sVT) sVT.innerText = state.tiltPosition;
            } else if (lTC) {
                lTC.style.display = 'none';
            }
        }
        document.querySelectorAll(`.button-sunflag[data-shadeid="${sId}"]`).forEach(btn => {
            btn.style.display = state.sunSensor ? '' : 'none';
            btn.dataset.on = (state.flags & 0x01) === 0x01;
        });
        document.querySelectorAll(`.somfyShadeCtl[data-shadeid="${sId}"]`).forEach(d => {
            Object.assign(d.dataset, {
                direction: state.direction,
                position: state.position,
                target: state.target,
                mypos: state.myPos,
                windy: (state.flags & 0x10) === 0x10,
                          sunny: (state.flags & 0x20) === 0x20,
                          mytiltpos: state.myTiltPos ?? -1
            });

            if (state.tiltType !== 0) {
                Object.assign(d.dataset, {
                    tiltdirection: state.tiltDirection,
                    tiltposition: state.tiltPosition,
                    tilttarget: state.tiltTarget
                });
            }

            const spans = d.querySelectorAll('.val-pos');
            if (spans[0]) spans[0].innerText = `${tr('SHADE_POS')}${shadePosLabel(state.position, state.flipPosition)}`;
            if (state.tiltType !== 0 && spans[1]) spans[1].innerText = `${tr('SHADE_TILT')}${state.tiltPosition}%`;

            const upTxt = (sel, pre, val) => {
                const el = d.querySelector(sel);
                if (el) el.innerText = `${pre}${val !== undefined && val >= 0 ? val + '%' : '---'}`;
            };
            upTxt('.val-my', 'My: ', state.myPos);
            upTxt('.val-tilt', tr('SHADE_MY_TILT'), state.myTiltPos);
        });
    }
    procRemoteFrame(frame) {
        const qs = (s) => get(s);
        qs('spanRssi').textContent = frame.rssi;
        qs('spanFrameCount').innerHTML = parseInt(qs('spanFrameCount').innerHTML || 0, 10) + 1;

        const lnk = qs('divLinking') || qs('divLinkRepeater');
        if (lnk) {
            const isRepeater = lnk.id === 'divLinkRepeater';
            const url = isRepeater ? '/linkRepeater' : '/linkRemote';
            const obj = isRepeater ? {address: frame.address} : {
                shadeId: parseInt(lnk.dataset.shadeid, 10),
                remoteAddress: frame.address,
                rollingCode: frame.rcode
            };

            const overlay = ui.waitMessage(lnk);
            putJSON(url, obj, (err, data) => {
                overlay.remove();
                lnk.remove();
                if (err) ui.serviceError(err);
                else isRepeater ? this.setRepeaterList(data) : this.setLinkedRemotesList(data);
            });
        }
        const dt = new Date();
        const timeStr = `${dt.getHours().fmt('00')}:${dt.getMinutes().fmt('00')}:${dt.getSeconds().fmt('00')}.${dt.getMilliseconds().fmt('000')}`;
        const protos = { 1: '-W', 2: '-V' };
        const proto = protos[frame.proto] || '-S';
        const row = document.createElement('div');
        row.className = 'frame-row';
        row.dataset.valid = frame.valid;

        row.innerHTML = `<span>${esc(frame.encKey)}</span><span>${esc(frame.address)}</span><span>${esc(frame.command)}<sup>${esc(frame.stepSize || '')}</sup></span><span>${esc(frame.rcode)}</span><span>${esc(frame.rssi)}dBm</span><span>${esc(frame.bits)}${proto}</span><span>${timeStr}</span><div class="frame-pulses">${esc(frame.pulses.join(','))}</div>`;

        qs('divFrames').prepend(row);
        this.frames.push(frame);
    }
    JSONPretty(obj, indent = 2) {
        if (Array.isArray(obj)) {
            let output = '[';
            for (let i = 0; i < obj.length; i++) {
                if (i !== 0) output += ',\n';
                output += this.JSONPretty(obj[i], indent);
            }
            output += ']';
            return output;
        }
        else {
            let output = JSON.stringify(obj, function (k, v) {
                if (Array.isArray(v)) return JSON.stringify(v);
                return v;
            }, indent).replace(/\\/g, '')
            .replace(/\"\[/g, '[')
            .replace(/\]\"/g, ']')
            .replace(/\"\{/g, '{')
                .replace(/\}\"/g, '}')
                .replace(/\{\n\s+/g, '{');
                    return output;
                }
        }
    JSONPretty(obj, indent = 2) {
        if (Array.isArray(obj)) {
            let output = '[';
            for (let i = 0; i < obj.length; i++) {
                if (i !== 0) output += ',\n';
                output += this.JSONPretty(obj[i], indent);
            }
            output += ']';
            return output;
        }
        else {
            let output = JSON.stringify(obj, function (k, v) {
                if (Array.isArray(v)) return JSON.stringify(v);
                return v;
            }, indent).replace(/\\/g, '')
            .replace(/\"\[/g, '[')
            .replace(/\]\"/g, ']')
            .replace(/\"\{/g, '{')
            .replace(/\}\"/g, '}')
            .replace(/\{\n\s+/g, '{');
                return output;
            }
    }
    framesToClipboard() {
        if (typeof navigator.clipboard !== 'undefined')
            navigator.clipboard.writeText(this.JSONPretty(this.frames, 2));
        else {
            let dummy = document.createElement('textarea');
            document.body.appendChild(dummy);
            dummy.value = this.JSONPretty(this.frames, 2);
            dummy.focus();
            dummy.select();
            document.execCommand('copy');
            document.body.removeChild(dummy);
        }
    }
    onShadeTypeChanged(el) {
        const g = get,
        type = parseInt(g('selShadeType').value, 10),
        tilt = parseInt(g('selTiltType').value, 10),
        bitL = g('selShadeBitLength')?.value,
        ico = g('icoShade'),
        isNew = g('spanShadeId').innerText === '*',
        st = this.shadeTypes.find(x => x.type === type) || { type };

        ['somfyShade', 'divSomfyButtons'].forEach(id => g(id)?.setAttribute('data-shadetype', type));

        if (ico) {

            this.shadeTypes.forEach(t => t.ico !== st.ico && ico.classList.remove(t.ico));

            const use = ico.querySelector('use');
            if (use && st.ico) {
                const href = '#' + st.ico;
                use.setAttribute('href', href);
                use.setAttribute('xlink:href', href);
            }
        }
        const hasLift = !!st.lift;
        const curTilt = st.tilt ? tilt : 0;
        const showLiftSettings = hasLift && tilt !== 3;
        const disp = (id, cond, d = 'block') => {
            const e = g(id);
            if (e) e.style.display = cond ? d : 'none';
        };

            disp('divTiltSettings', st.tilt);
            disp('divShadeTimings', hasLift);
            disp('divLiftSettings', showLiftSettings);
            // The slat lift time only applies to shades without tilt; the firmware
            // ignores it for the other types through effectiveLiftTime.
            disp('divLiftTime', curTilt === 0);
            disp('divSunSensor', st.sun);
            disp('divLightSwitch', st.light);
            disp('divFlipPosition', st.fpos);
            disp('divFlipCommands', st.fcmd);

            const fldTilt = g('fldTiltTime')?.parentElement;
            if (fldTilt) fldTilt.style.display = curTilt ? 'inline-block' : 'none';

            const showStepHR = [7, 8, 2, 4, 0].includes(type) || (type === 1 && [2, 3, 4].includes(tilt));

        disp('hrDivStepSettings', showStepHR);
        disp('hrTiltSettings', curTilt !== 3);
        disp('hrDldTiltTime', !(curTilt === 0 && bitL === "56"));
        disp('labelPosContainer', hasLift && !isNew);
        disp('labelTiltContainer', curTilt && !isNew);

        if (!st.light && g('cbHasLight')) g('cbHasLight').checked = false;
        if (!st.sun && g('cbHasSunsensor')) g('cbHasSunsensor').checked = false;
    }
    onShadeBitLengthChanged(el) {
        get('somfyShade').setAttribute('data-bitlength', el.value);
        this.onShadeTypeChanged(el);
    }
    onShadeProtoChanged(el) {
        get('somfyShade').setAttribute('data-proto', el.value);
    }
    openEditRoom(roomId) {
        if (typeof roomId === 'undefined') {
            if (_rooms.length >= 15) {
                ui.errorMessage(get('divSomfySettings'), tr('ERR_ROOM_LIMIT_REACHED'));
                return;
            }
            get('btnSaveRoom').innerText = tr('BT_CREATE');
            getJSONBusy('/getNextRoom', (err, room) => {
                get('spanRoomId').innerText = '*';
                if (err) ui.serviceError(err);
                else {
                    if(DBG) console.log(room);
                    let elRoom = get('somfyRoom');
                    room.name = '';
                    ui.toElement(elRoom, room);
                    this.showEditRoom(true);
                }
            });
        }
        else {
            get('btnSaveRoom').innerText = tr('BT_SAVE');
            getJSONBusy(`/room?roomId=${roomId}`, (err, room) => {
                if (err) ui.serviceError(err);
                else {
                    if(DBG) console.log(room);
                    get('spanRoomId').innerText = roomId;
                    ui.toElement(get('somfyRoom'), room);
                    this.showEditRoom(true);
                    get('btnSaveRoom').style.display = 'inline-block';
                }
            });
        }
    }
    openEditShade(shadeId) {
        const g = get,
        isNew = shadeId === undefined,
        ico = g('icoShade'),
        btns = ['btnPairShade', 'btnUnpairShade', 'btnLinkRemote', 'hrSetRollingC', 'btnSetRollingCode'];

        if (isNew && this.shades?.length >= 30)
            return ui.errorMessage(g('divSomfySettings'), tr('ERR_DEVICE_LIMIT_REACHED'));

        const s = (id, d) => { const e = g(id); if(e) e.style.display = d; };

        s('divshowSomfyButtons', 'flex');
        g('divshowSomfyButtons')?.classList.toggle('disabled', isNew);
        btns.forEach(id => s(id, 'none'));
        ['blocPairDevice', 'divLinkedRemoteList', 'labelPosContainer'].forEach(id => s(id, 'none'));

        getJSONBusy(isNew ? '/getNextShade' : `/shade?shadeId=${shadeId}`, (err, shade) => {
            if (err) return ui.serviceError(err);

            if (isNew) {
                Object.assign(shade, {
                    name: '', shadeType: 4, roomId: 0, downTime: 10000, upTime: 10000, liftTime: 0,
                    tiltTime: 7000, tiltType: 0, flipCommands: 0, flipPosition: 0, paired: 0, sunSensor: 0, simMy: 0, repeats: 0
                });
            }
            if (!isNew) {
                s('labelPosContainer', 'block');
                s('blocPairDevice', 'flex');
                ['btnLinkRemote', 'btnSetRollingCode'].forEach(id => s(id, 'flex'));
                s('hrSetRollingC', 'block');
                s(shade.paired ? 'btnUnpairShade' : 'btnPairShade', 'inline-block');

                if (g('valPos')) g('valPos').innerText = shade.position;
                this.setLinkedRemotesList(shade);
            }

            if (g('valTilt')) g('valTilt').innerText = shade.tiltPosition || 0;

            ui.setFocus('btnPairShade', !isNew && !shade.paired);

            const rev = shade.flipPosition,
            p = rev ? 100 - shade.position : shade.position,
            tp = rev ? 100 - shade.tiltPosition : shade.tiltPosition;

            if (ico) {
                const st = ico.style;
                st.setProperty('--shade-position', p);
                st.setProperty('--fpos', p + '%');
                st.setProperty('--tilt-position', tp + '%');
                ico.setAttribute('data-shadeid', isNew ? '*' : shadeId);
            }
            g('btnSaveShade').innerText = tr(isNew ? 'BT_CREATE' : 'BT_SAVE');
            g('spanShadeId').innerText = isNew ? '*' : shadeId;

            ui.toElement(g('somfyShade'), shade);
            if (g('selShadeBitLength')) g('somfyShade').setAttribute('data-bitlength', g('selShadeBitLength').value);
            this.onShadeTypeChanged(g('selShadeType'));
            this.showEditShade(true);
            // A freshly-loaded panel matches the server, so it starts clean: clear the
            // unsaved-changes flag and swallow the change events fired while the fields
            // are (re)populated. Prevents false "unsaved changes" prompts after a save
            // or any programmatic reload of the shade (e.g. the calibration wizard).
            navSuppress(); navClearDirty();
        });
    }
    openEditGroup(groupId) {
        const g = get,
        isNew = groupId === undefined,
        elGroup = g('somfyGroup'),
        btnLink = g('btnLinkShade'),
        btnSave = g('btnSaveGroup'),
        btnContainer = g('divSomfyGroupButtons'),
        divLinkedShades = g('divLinkedShadeList'),
        blocPairParent = g('blocPairGroup');

        if (isNew && this.groups?.length >= 14)
            return ui.errorMessage(g('divSomfySettings'), tr('ERR_GROUP_LIMIT_REACHED'));

        const s = (idOrElem, d) => { const e = (typeof idOrElem === 'string') ? g(idOrElem) : idOrElem; if(e) e.style.display = d; };

        divLinkedShades.innerHTML = '';

        s(btnContainer, 'flex');
        btnContainer?.classList.toggle('disabled', isNew);
        s(btnLink, 'none');
        s(btnSave, 'none');
        s(blocPairParent, 'none');
        s(divLinkedShades, 'none');

        getJSONBusy(isNew ? '/getNextGroup' : `/group?groupId=${groupId}`, (err, group) => {
            if (err) return ui.serviceError(err);

            if (isNew) {
                Object.assign(group, {
                    name: '', flipCommands: false, shades: []
                });
            }
            if (!isNew) {
                s(btnLink, 'inline-block');
                s(blocPairParent, 'flex');
                s(divLinkedShades, 'block');

                const hasShades = (group.shades && group.shades.length > 0);
                btnContainer?.classList.toggle('disabled', !hasShades);

                ui.setFocus(btnLink, !isNew && !hasShades);
                this.setLinkedShadesList(group);
            }
            g('btnSaveGroup').innerText = tr(isNew ? 'BT_CREATE' : 'BT_SAVE');
            s(btnSave, 'inline-block');
            g('spanGroupId').innerText = isNew ? '*' : groupId;

            ui.toElement(elGroup, group);
            this.showEditGroup(true);
        });
    }
    showEditRoom(bShow) {
        let el = get('divLinking');
        if (el) el.remove();
        el = get('divLinkRepeater');
        if (el) el.remove();
        el = get('divPairing');
        if (el) el.remove();
        el = get('divRollingCode');
        if (el) el.remove();
        el = get('somfyRoom');
        if (el) el.style.display = bShow ? '' : 'none';
        el = get('divRoomListContainer');
        if (el) el.style.display = bShow ? 'none' : '';
        if (bShow) {
            this.showEditGroup(false);
            this.showEditShade(false);
        }
    }
    showEditShade(bShow) {
        let el = get('divLinking');
        if (el) el.remove();
        el = get('divLinkRepeater');
        if (el) el.remove();
        el = get('divPairing');
        if (el) el.remove();
        el = get('divRollingCode');
        if (el) el.remove();
        el = get('somfyShade');
        if (el) el.style.display = bShow ? '' : 'none';
        el = get('divShadeListContainer');
        if (el) el.style.display = bShow ? 'none' : '';
        if (bShow) {
            this.showEditGroup(false);
            this.showEditRoom(false);
        }
    }
    showEditGroup(bShow) {
        let el = get('divLinking');
        if (el) el.remove();
        el = get('divLinkRepeater');
        if (el) el.remove();
        el = get('divPairing');
        if (el) el.remove();
        el = get('divRollingCode');
        if (el) el.remove();
        el = get('somfyGroup');
        if (el) el.style.display = bShow ? '' : 'none';
        el = get('divGroupListContainer');
        if (el) el.style.display = bShow ? 'none' : '';
        if (bShow) {
            this.showEditRoom(false);
            this.showEditShade(false);
        }
    }
    saveRoom() {
        let roomId = parseInt(get('spanRoomId').innerText, 10);
        let obj = ui.fromElement(get('somfyRoom'));
        let valid = true;
        if (valid && (typeof obj.name !== 'string' || obj.name === '' || obj.name.length > 20)) {
            ui.errorMessage(get('divSomfySettings'), tr('ERR_ROOM_NAME_INVALID'));
            valid = false;
        }
        if (valid) {
            if (isNaN(roomId) || roomId === 0) {
                // We are adding.
                putJSONBusy('/addRoom', obj, (err, room) => {
                    if (err) {
                        ui.serviceError(err);
                        if(DBG) console.log(err);
                    }
                    else {
                        if(DBG) console.log(room);
                        ui.successMessage(tr('MSG_ADD_SUCCESS'));
                        get('spanRoomId').innerText = room.roomId;
                        get('btnSaveRoom').innerText = tr('BT_SAVE');
                        get('btnSaveRoom').style.display = 'inline-block';
                        this.updateRoomsList();
                    }
                });
            }
            else {
                obj.roomId = roomId;
                putJSONBusy('/saveRoom', obj, (err, room) => {
                    if (err) {
                        ui.serviceError(err);
                    } else {
                        ui.successMessage(tr('MSG_SAVE_SUCCESS'));
                        this.updateRoomsList();
                    }
                    if(DBG) console.log(room);
                });
            }
        }
    }
    saveShade() {
        const g = get,
        sId = parseInt(g('spanShadeId').innerText, 10),
        obj = ui.fromElement(g('somfyShade')),
        settings = g('divSomfySettings');

        // Empty field, or firmware older than the UI (JSON without liftTime): 0 = original behaviour.
        if (isNaN(obj.liftTime)) obj.liftTime = 0;

        const checks = [
            [isNaN(obj.remoteAddress) || obj.remoteAddress < 1 || obj.remoteAddress > 16777215, 'ERR_REMOTE_ADDRESS_INVALID'],
            [!obj.name || obj.name.length > 20, 'ERR_DEVIVE_NAME_INVALID'],
            [isNaN(obj.upTime) || obj.upTime < 1 || obj.upTime > 180000, 'ERR_UP_TIME_INVALID'],
            [isNaN(obj.downTime) || obj.downTime < 1 || obj.downTime > 180000, 'ERR_DOWN_TIME_INVALID'],
            [obj.liftTime < 0 || obj.liftTime > 60000, 'ERR_LIFT_TIME_INVALID']
        ];

        const basicError = checks.find(c => c[0]);
        if (basicError) return ui.errorMessage(settings, tr(basicError[1]));
        if (obj.proto === 8 || obj.proto === 9) {
            const isSp = [5, 14, 15, 16, 10].includes(obj.shadeType);

            if (obj.gpioUp === obj.gpioDown && !(isSp && obj.proto === 9)) {
                return ui.errorMessage(settings, tr('ERR_GPIO_UP_DOWN_NOT_UNIQUE'));
            }
            if (!isSp && obj.proto === 9 && (obj.gpioMy === obj.gpioUp || obj.gpioMy === obj.gpioDown)) {
                return ui.errorMessage(settings, tr('ERR_GPIO_UP_DOWN_MY_NOT_UNIQUE'));
            }
        }
        const isNew = isNaN(sId) || sId >= 255;
        if (!isNew) obj.shadeId = sId;

        putJSONBusy(isNew ? '/addShade' : '/saveShade', obj, (err, shade) => {
            if (err) return ui.serviceError(err);

            if(DBG) console.log("Shade saved/added:", shade);
            const msg = isNew ? tr('MSG_ADD_SUCCESS') : tr('MSG_SAVE_SUCCESS');
            ui.successMessage(msg);
            this.updateShadeList();
            this.openEditShade(shade.shadeId);
        });
    }
    saveGroup() {
        const g = get,
        sId = g('spanGroupId').innerText,
        groupId = parseInt(sId, 10),
        obj = ui.fromElement(g('somfyGroup')),
        isNew = isNaN(groupId) || groupId >= 255;

        const checks = [
            [isNaN(obj.remoteAddress) || obj.remoteAddress < 1 || obj.remoteAddress > 16777215, 'ERR_REMOTE_ADDRESS_INVALID'],
            [!obj.name || obj.name.length > 20, 'ERR_DEVIVE_NAME_INVALID']
        ];
        const error = checks.find(c => c[0]);
        if (error) return ui.errorMessage(tr(error[1]));
        if (!isNew) obj.groupId = groupId;

        putJSONBusy(isNew ? '/addGroup' : '/saveGroup', obj, (err, group) => {
            if (err) return ui.serviceError(err);

            if(DBG) console.log("Group saved:", group);
            const msg = isNew ? tr('MSG_ADD_SUCCESS') : tr('MSG_SAVE_SUCCESS');
            ui.successMessage(msg);
            this.openEditGroup(group.groupId);
            this.updateGroupList();
        });
    }
    updateRoomsList() {
        getJSONBusy('/rooms', (err, shades) => {
            if (err) {
                if(DBG) console.log(err);
                ui.serviceError(err);
            }
            else {
                this.setRoomsList(shades);
            }
        });
    }
    updateShadeList() {
        getJSONBusy('/shades', (err, shades) => {
            if (err) {
                if(DBG) console.log(err);
                ui.serviceError(err);
            }
            else {
                //console.log(shades);
                // Create the shades list.
                this.setShadesList(shades);
            }
        });
    }
    updateGroupList() {
        getJSONBusy('/groups', (err, groups) => {
            if (err) {
                if(DBG) console.log(err);
                ui.serviceError(err);
            }
            else {
                if(DBG) console.log(groups);
                // Create the groups list.
                this.setGroupsList(groups);
            }
        });
    }
    updateRepeatList() {
        getJSONBusy('/repeaters', (err, repeaters) => {
            if (err) {
                if(DBG) console.log(err);
                ui.serviceError(err);
            }
            else this.setRepeaterList(repeaters);
        });
    }
    deleteRoom(roomId) {
        let valid = true;
        if (isNaN(roomId) || roomId >= 255 || roomId <= 0) {
            ui.errorMessage(tr('ERR_ROOM_ID_REQUIRED'));
            valid = false;
        }
        if (valid) {
            getJSONBusy(`/room?roomId=${roomId}`, (err, room) => {
                if (err) ui.serviceError(err);
                else {
                    let prompt = ui.promptMessage(tr('PROMPT_DELETE_ROOM'), () => {
                        ui.clearErrors();
                        putJSONBusy('/deleteRoom', { roomId: roomId }, (err, room) => {
                            prompt.remove();
                            if (err) ui.serviceError(err);
                            else
                                this.updateRoomsList();
                        });
                    });
                    prompt.querySelector('.sub-message').innerHTML = `<p>${tr("PROMPT_DELETE_ROOM_WARNING")}</p>`;
                }
            });
        }
    }
    deleteShade(shadeId) {
        let valid = true;
        if (isNaN(shadeId) || shadeId >= 255 || shadeId <= 0) {
            ui.errorMessage(tr('ERR_DEVICE_ID_REQUIRED'));
            valid = false;
        }
        if (valid) {
            getJSONBusy(`/shade?shadeId=${shadeId}`, (err, shade) => {
                if (err) ui.serviceError(err);
                else if (shade.inGroup) ui.errorMessage(tr('ERR_DEVICE_IN_GROUP'));
                else {
                    let prompt = ui.promptMessage(tr('PROMPT_DELETE_SHADE'), () => {
                        ui.clearErrors();
                        putJSONBusy('/deleteShade', { shadeId: shadeId }, (err, shade) => {
                            if (err) ui.serviceError(err);
                            else ui.successMessage(tr('MSG_DELETE_SUCCESS'));
                            this.updateShadeList();
                            prompt.remove();
                        });
                    });
                    prompt.querySelector('.sub-message').innerHTML = `<p>${tr("PROMPT_DELETE_SHADE_WARNING")}</p><p>${tr("PROMPT_DELETE_SHADE_CONFIRM").replace("{SHADE_NAME}", esc(shade.name))}</p>`;
                }
            });
        }
    }
    deleteGroup(groupId) {
        let valid = true;
        if (isNaN(groupId) || groupId >= 255 || groupId <= 0) {
            ui.errorMessage(tr('ERR_INVALID_GROUP_ID'));
            valid = false;
        }
        if (valid) {
            getJSONBusy(`/group?groupId=${groupId}`, (err, group) => {
                if (err) ui.serviceError(err);
                else {
                    if (group.linkedShades.length > 0) {
                        ui.errorMessage(tr('ERR_GROUP_NOT_EMPTY'));
                    }
                    else {
                        let prompt = ui.promptMessage(tr('PROMPT_DELETE_GROUP'), () => {
                            putJSONBusy('/deleteGroup', { groupId: groupId }, (err, g) => {
                                if (err) ui.serviceError(err);
                                else ui.successMessage(tr('MSG_DELETE_SUCCESS'));
                                this.updateGroupList();
                                prompt.remove();
                            });
                        });
                        prompt.querySelector('.sub-message').innerHTML = `<p>${tr("PROMPT_DELETE_GROUP_CONFIRM").replace("{GROUP_NAME}", esc(group.name))}</p>`;
                    }
                }
            });
        }
    }
    setRollingCode(shadeId, rollingCode) {
        putJSONBusy('/setRollingCode', { shadeId: shadeId, rollingCode: rollingCode }, (err, shade) => {
            if (err) ui.serviceError(get('divSomfySettings'), err);
            else {
                let dlg = get('divRollingCode');
                if (dlg) dlg.remove();
            }
        });
    }
    openSetRollingCode(shadeId) {
        let overlay = ui.waitMessage(get('divContainer'));
        getJSON(`/shade?shadeId=${shadeId}`, (err, shade) => {
            overlay.remove();
            if (err) return ui.serviceError(err);

            let div = document.createElement('div');
            div.id = 'divRollingCode';
            div.className = 'inst-overlay';

            div.innerHTML = `
            <div class="instructions-content">
            <div class="overlay-scroll-content">
            ${overlayHeader("ROLLING_CODE_TITLE", "ROLLING_CODE_DESC", "svg-warning")}
            <div class="error">
            <svg><use href=#svg-warning></use></svg>
            <div><b>${tr("MSG_DANGER")}</b><span>${tr("ROLLING_CODE_WARNING_DESC_1")}</span></div>
            </div>
            <div class="uniblocStep">${tr("ROLLING_CODE_WARNING_DESC_2")}</div>
            <div class="unibloc uniblocRollingCode">
            <label class="label" for="fldNewRollingCode">${tr("BT_ROLLING_CODE")}</label>
            <input id="fldNewRollingCode" class="inputAndSelect" min="0" max="65535" name="newRollingCode" type="number" value="${shade.lastRollingCode}">
            </div>
            </div>
            <div class="hrDivFooter"></div>
            <div class="button-container-overlay">
            <button id="btnChangeRollingCode" class="bouton-Danger" type="button" onclick="somfy.setRollingCode(${shadeId}, parseInt(get('fldNewRollingCode').value, 10));">${tr("BT_SET_ROLLING_CODE")}</button>
            <button id="btnCancel" line type="button">${tr("BT_CANCEL_1")} </button>
            </div>
            </div>`;

            shOverlay(div);
            div.querySelector('#btnCancel').onclick = () => closeOverlay(div);
            ui.setFocus(btnCancel, true, 'var(--accent-sucess)');
        });
    }
    setPaired(shadeId, paired) {
        let obj = { shadeId: shadeId, paired: paired || false };
        let div = get('divPairing');
        let overlay = typeof div === 'undefined' ? undefined : ui.waitMessage(div);
        putJSONBusy('/setPaired', obj, (err, shade) => {
            if (overlay) overlay.remove();
            if (err) {
                if(DBG) console.log(err);
                ui.errorMessage(err.message);
            }
            else if (div) {
                if(DBG) console.log(shade);
                this.showEditShade(true);
                get('btnSaveShade').style.display = 'inline-block';
                get('btnLinkRemote').style.display = '';
                if (shade.paired) {
                    get('btnUnpairShade').style.display = 'inline-block';
                    get('btnPairShade').style.display = 'none';
                }
                else {
                    get('btnPairShade').style.display = 'inline-block';
                    get('btnUnpairShade').style.display = 'none';
                }
                this.setLinkedRemotesList(shade);
                closeOverlay(div);
            }
        });
    }
    _shWiz(shadeId, isUnpair) {
        const sType = parseInt(get('somfyShade').getAttribute('data-shadetype'), 10);
        const isG = (sType === 5 || sType === 6);
        const pre = isUnpair ? 'UNPAIR' : 'PAIR';
        const dev = isG ? 'GARAGE' : 'SHADE';
        const progId = isUnpair ? 'btnSendUnpairing' : 'btnSendPairing';
        const stopId = isUnpair ? 'btnStopUnpairing' : 'btnStopPairing';
        const sucBtnId = isUnpair ? 'btnUnpairShade' : 'btnPairShade';
        const sucVal = isUnpair ? 0 : 1;
        const focusVal = isUnpair ? 1 : 0;
        const sucAction = `somfy.setPaired(${shadeId},${sucVal});ui.setFocus('${sucBtnId}',${focusVal});closeOverlay(get('divPairing'));`;
        const descKey = `${pre}_${dev}_DESC`;
        const stepTitles = ["WIZ_TITLE_STEP1", `${pre}_TITLE_STEP2`, "WIZ_TITLE_STEP3"];
        const t = (s, l) => {
            const sk = `${pre}_${dev}_STEP_${s}_${l}`, fk = `WIZ_${dev}_STEP_${s}_${l}`, r = tr(sk);
            return (r === sk) ? tr(fk) : r;
        };
        const it = (n, s, l) => `<div class="step-item"><div class="step-number">${n}</div><div class="step-text">${t(s, l)}</div></div>`;
        const inf = (s, l) => `<div class="information wizard-step" data-stepid="${s}"><svg><use href=#svg-info></use></svg><div><b>${tr("MSG_NOTE")}</b><span>${t(s, l)}</span></div></div>`;

        let div = document.createElement('div');
        div.className = `inst-overlay wizard${ui.isExpertMode ? ' is-expert' : ''}`;
        div.id = 'divPairing';
        div.setAttribute('data-stepid', '1');
        div.setAttribute('data-type', 'link-remote');
        div.setAttribute('data-shadeid', shadeId);

        div.innerHTML = `
        <div class="instructions-content">
        <div class="overlay-scroll-content">
        ${overlayHeader(isUnpair ? "UNPAIR_TITLE" : "PAIR_TITLE", tr(descKey), isG ? "svg-simpleGarage" : "svg-simpleShutter", 1)}
        ${wizardStepper(stepTitles)}
        <div class="blocsteps">
        <div class="uniblocStep wizard-step" data-stepid="1">
        ${it('a', 1, 1)} ${it('b', 1, 2)} ${isG ? it('c', 1, 3) : ''}
        </div>
        ${!isG ? inf(1, 3) : ''}
        <div class="button-container-col wizard-step marginB" data-expert data-stepid="2">
        <button id="${progId}" type="button">${tr("BT_PROG")}</button>
        </div>
        <div class="uniblocStep wizard-step" data-stepid="2">
        ${it('a', 2, 1)} ${it('b', 2, 2)} ${!isG ? it('c', 2, 3) : ''}
        </div>
        ${!isG ? inf(2, 4) : ''}
        <div class="button-container-col wizard-step marginB" data-expert data-stepid="3">
        <button id="btnWizMarkSuc" type="button" class="btn-success" onclick="${sucAction}">${tr(isUnpair ? "BT_UNPAIRING_SUCCESS" : "BT_PAIRING_SUCCESS")}</button>
        </div>
        <div class="uniblocStep wizard-step" data-stepid="3">${it('a', 3, 1)}</div>
        <div class="empty-state wizard-step" data-stepid="3"><svg class="empty-icon"><use href=#svg-succes></use></svg></div>
        </div>
        </div>
        <div class="hrDivFooter"></div>
        <div class="expert-only-buttons" data-expert>
        <button type="button" line onclick="closeOverlay(this.closest('.inst-overlay'))">${tr("BT_CANCEL_1")}</button>
        </div>
        <div class="button-container-overlay">
        <button id="${stopId}" class="wizard-step" data-stepid="1" line type="button">${tr("BT_CLOSE")}</button>
        <button id="btnWizPrev" class="wizard-step" data-mstepid="2,3" line type="button" onclick="ui.wizSetPrevStep(this.closest('.wizard'));">${tr("BT_GO_BACK")}</button>
        <button id="btnWizNext" class="wizard-step" data-mstepid="1,2" type="button" onclick="ui.wizSetNextStep(this.closest('.wizard'));">${tr("BT_NEXT")}</button>
        <button id="btnWizEnd" class="wizard-step" data-stepid="3" type="button">${tr(isG ? "BT_CLOSE" : "BT_CANCEL_1")}</button>
        </div>
        </div>`;

        const clearT = () => { if (this.btnTimer) { clearInterval(this.btnTimer); this.btnTimer = null; } };
        const fnRep = (err, shade) => {
            clearT();
            if (!err && mouseDown) somfy.sendCommandRepeat(shadeId, 'prog', null, fnRep);
        };

        let btnProg = div.querySelector(`#${progId}`);
        if (btnProg) {
            const onP = () => somfy.sendCommand(shadeId, 'prog', null, fnRep);
            btnProg.addEventListener('mousedown', onP, true);
            // preventDefault stops the synthesized mousedown that would double-send.
            btnProg.addEventListener('touchstart', (e) => { e.preventDefault(); onP(); }, true);
        }
        div.querySelectorAll(`#${stopId}, #btnWizEnd`).forEach(btn => {
            btn.onclick = () => closeOverlay(div, clearT);
        });

        ui.wizSetStep(div, 1);
        shOverlay(div, clearT);

        return div;
    }
    pairShade(shadeId) {
        return this._shWiz(shadeId, false);
    }

    unpairShade(shadeId) {
        return this._shWiz(shadeId, true);
    }
    sendCommand(shadeId, command, repeat, cb) {
        let obj = {};
        if (typeof shadeId.shadeId !== 'undefined') {
            obj = shadeId;
            cb = command;
            shadeId = obj.shadeId;
            repeat = obj.repeat;
            command = obj.command;
        }
        else {
            obj = { shadeId: shadeId };
            if (isNaN(parseInt(command, 10))) obj.command = command;
            else obj.target = parseInt(command, 10);
            if (typeof repeat === 'number') obj.repeat = parseInt(repeat);
        }
        putJSON('/shadeCommand', obj, (err, shade) => {
            if (!err) somfy.flashCommandSent(shadeId);
            if (typeof cb === 'function') cb(err, shade);
        });
    }
    // Brief visual acknowledgment that the radio order left the device; pure-RTS
    // shades have no position feedback, so without it a tap looks like a failure.
    flashCommandSent(shadeId) {
        document.querySelectorAll(`.somfy-shade-icon[data-shadeid="${shadeId}"]`).forEach(el => {
            el.classList.remove('cmd-sent');
            void el.offsetWidth;  // restart the CSS animation on rapid re-taps
            el.classList.add('cmd-sent');
            setTimeout(() => el.classList.remove('cmd-sent'), 950);
        });
    }
    sendCommandRepeat(shadeId, command, repeat, cb) {
        //console.log(`Sending Shade command ${shadeId}-${command}`);
        let obj = {};
        if (typeof shadeId.shadeId !== 'undefined') {
            obj = shadeId;
            cb = command;
            shadeId = obj.shadeId;
            repeat = obj.repeat;
            command = obj.command;
        }
        else {
            obj = { shadeId: shadeId, command: command };
            if (typeof repeat === 'number') obj.repeat = parseInt(repeat);
        }
        putJSON('/repeatCommand', obj, (err, shade) => {
            if (typeof cb === 'function') cb(err, shade);
        });
    }
    sendGroupRepeat(groupId, command, repeat, cb) {
        let obj = { groupId: groupId, command: command };
        if (typeof repeat === 'number') obj.repeat = parseInt(repeat);
        putJSON(`/repeatCommand?groupId=${groupId}&command=${command}`, null, (err, group) => {
            if (typeof cb === 'function') cb(err, group);
        });
    }
    sendVRCommand(el) {
        if (typeof mouseDown === 'undefined') window.mouseDown = false;
        let pnl = get('divVirtualRemote');
        let dd = pnl.querySelector('#selVRMotor');
        let opt = dd.selectedOptions[0];
        let o = {
            type: opt.getAttribute('data-type'),
            address: opt.getAttribute('data-address'),
            cmd: el.getAttribute('data-cmd')
        };
        ui.fromElement(el.parentElement.parentElement, o);
        switch (o.type) {
            case 'shade':
                o.shadeId = parseInt(opt.getAttribute('data-shadeId'), 10);
                o.shadeType = parseInt(opt.getAttribute('data-shadeType'), 10);
                break;
            case 'group':
                o.groupId = parseInt(opt.getAttribute('data-groupId'), 10);
                break;
        }
        if(DBG) console.log(o);
        let fnRepeatCommand = (err, shade) => {
            if (this.btnTimer) {
                clearTimeout(this.btnTimer);
                this.btnTimer = null;
            }
            if (err) return;
            if (mouseDown) {
                if (o.cmd === 'Sensor')
                    somfy.sendSetSensor(o);
                else if (o.type === 'group')
                    somfy.sendGroupRepeat(o.groupId, o.cmd, null, fnRepeatCommand);
                else
                    somfy.sendCommandRepeat(o, fnRepeatCommand);
            }
        }
        o.command = o.cmd;
        if (o.cmd === 'Sensor') {
            somfy.sendSetSensor(o);
        }
        else if (o.type === 'group')
            somfy.sendGroupCommand(o.groupId, o.cmd, null, (err, group) => { fnRepeatCommand(err, group); });
        else
            somfy.sendCommand(o, (err, shade) => { fnRepeatCommand(err, shade); });
    }
    sendSetSensor(obj, cb) {
        putJSON('/setSensor', obj, (err, device) => {
            if (typeof cb === 'function') cb(err, device);
        });
    }
    sendGroupCommand(groupId, command, repeat, cb) {
        if(DBG) console.log(`Sending Group command ${groupId}-${command}`);
        let obj = { groupId: groupId };
        if (isNaN(parseInt(command, 10))) obj.command = command;
        if (typeof repeat === 'number') obj.repeat = parseInt(repeat);
        putJSON('/groupCommand', obj, (err, group) => {
            if (typeof cb === 'function') cb(err, group);
        });
    }
    sendTiltCommand(shadeId, command, cb) {
        if(DBG) console.log(`Sending Tilt command ${shadeId}-${command}`);
        const obj = isNaN(parseInt(command, 10))
            ? { shadeId: shadeId, command: command }
            : { shadeId: shadeId, target: parseInt(command, 10) };
        putJSON('/tiltCommand', obj, (err, shade) => {
            if (!err) somfy.flashCommandSent(shadeId);
            if (typeof cb === 'function') cb(err, shade);
        });
    }
    linkRemote(shadeId) {
        let div = document.createElement('div');
        div.className = 'inst-overlay';
        div.id = 'divLinking';
        div.setAttribute('data-type', 'link-remote');
        div.setAttribute('data-shadeid', shadeId);

        div.innerHTML = `
        <div class="instructions-content">
        <div class="overlay-scroll-content">
        ${overlayHeader("PAIR_TITLE", "LINK_REMOTE_DESC", "svg-remote")}
        <div class="uniblocStep">${tr("LINK_REMOTE_DESC_1")}</div>
        <div class="information">
        <svg><use href=#svg-info></use></svg>
        <div><b>${tr("MSG_NOTE")}</b><span>${tr("LINK_REMOTE_DESC_2")}</span></div>
        </div>
        </div>
        <div class="hrDivFooter"></div>
        <div class="button-container-overlay">
        <button id="btnStopLink" line type="button">${tr("BT_CANCEL_1")}</button>
        </div>
        </div>
        </div>`;

        shOverlay(div);
        div.querySelector('#btnStopLink').onclick = () => closeOverlay(div);

        return div;
    }
    linkRepeatRemote() {
        let div = document.createElement('div');
        div.className = 'inst-overlay';
        div.id = 'divLinkRepeater';
        div.setAttribute('data-type', 'link-repeatremote');

        div.innerHTML = `
        <div class="instructions-content">

        <div class="overlay-scroll-content">
        ${overlayHeader("REPEAT_REMOTE_TITLE", "REPEAT_REMOTE_DESC", "svg-repeater")}
        <div class="warning">
        <svg><use href=#svg-warning></use></svg>
        <div>
        <b>${tr("MSG_ALERT")}</b>
        <span>${tr("REPEAT_REMOTE_DESC_4")}<br><br>${tr("REPEAT_REMOTE_DESC_3")}</span>
        </div>
        </div>
        <div class="uniblocStep">
        <div class="step-item"><div class="step-number">a</div><div class="step-text">${tr("REPEAT_REMOTE_DESC_1")}</div></div>
        <div class="step-item"><div class="step-number">b</div><div class="step-text">${tr("REPEAT_REMOTE_DESC_2")}</div></div>
        <div class="step-item"><div class="step-number">c</div><div class="step-text">${tr("REPEAT_REMOTE_DESC_5")}</div></div>
        </div>
        </div>
        <div class="hrDivFooter"></div>
        <div class="button-container-overlay">
        <button id="btnStopLinking" type="button" line>${tr("BT_CANCEL_1")}</button>
        </div>
        </div>`;

        div.querySelector('#btnStopLinking').onclick = () => closeOverlay(div);
        shOverlay(div);

        return div;
    }
    _gpWiz(groupId, isUnlink, shadeId = null) {
        const pre = isUnlink ? 'UNLINK' : 'LINK';
        const stepsCount = isUnlink ? 3 : 4;
        const btnActionId = isUnlink ? 'btnUnpairFromGroup' : 'btnPairToGroup';
        const titleKey = `${pre}_GROUP_TITLE`;
        const descKey = `${pre}_GROUP_DESC`;
        const t = (s, l) => {
            const sk = `${pre}_GROUP_STEP_${s}_${l}`;
            const fk = `WIZ_LINK_GROUP_STEP_${s}_${l}`;
            const r = tr(sk);
            return (r === sk) ? tr(fk) : r;
        };
        const it = (n, s, l) => `<div class="step-item"><div class="step-number">${n}</div><div class="step-text">${t(s, l)}</div></div>`;
        const inf = (s, l) => `<div class="information wizard-step" data-stepid="${s}"><svg><use href=#svg-info></use></svg><div><b>${tr("MSG_NOTE")}</b><span>${t(s, l)}</span></div></div>`;

        let div = document.createElement('div');
        div.className = `inst-overlay wizard${ui.isExpertMode ? ' is-expert' : ''}`;
        div.id = isUnlink ? 'divUnlinkGroup' : 'divLinkGroup';
        div.setAttribute('data-groupid', groupId);
        div.setAttribute('data-stepid', '1');

        const stepTitles = [];
        for (let i = 1; i <= stepsCount; i++) {
            let titleIndex = i;
            if (isUnlink && i === 2) titleIndex = 3;
            if (isUnlink && i === 3) titleIndex = 3;

            let tk = `WIZ_LINK_GROUP_TITLE_STEP${titleIndex}`;
            if (tr(tk) === tk || (isUnlink && i === 3) || (!isUnlink && i === 2) || (!isUnlink && i === 4)) {
                tk = `${pre}_GROUP_TITLE_STEP${isUnlink && i === 3 ? '_3' : titleIndex}`;
            }
            stepTitles.push(tk);
        }

        div.innerHTML = `
        <div class="instructions-content">
        <div class="overlay-scroll-content">
        ${overlayHeader(titleKey, tr(descKey), "svg-simpleShutter", 1)}
        ${wizardStepper(stepTitles)}
        <div class="blocGroupsteps">
        ${inf(1, 1)}
        <div class="uniblocStep wizard-step" data-stepid="1">
        ${it('a', 1, 2)} ${it('c', 1, 3)}
        </div>
        ${!isUnlink ? `
        <div class="unibloc LinkGroupSelect wizard-step" data-expert data-stepid="2">
        <label class="label" for="selAvailShades">${tr("LINK_GROUP_SELECT_SHADE")}</label>
        <select id="selAvailShades" class="inputAndSelect" data-bind="shadeId" onchange="document.querySelectorAll('.divWizShadeName').forEach(el => el.textContent = this.options[this.selectedIndex].text);"></select>
        </div>
        <div class="uniblocStep wizard-step" data-stepid="2">
        ${it('a', 2, 1)} ${it('b', 2, 2)}
        </div>
        ${inf(2, 3)}
        ` : ''}
        <div class="blocsteps-row wizard-step" data-expert data-stepid="${isUnlink ? 2 : 3}">
        <div class="divWizShadeName"></div>
        <button type="button" id="btnOpenMemory">${tr("BT_OPEN_MEMORY")}</button>
        </div>
        <div class="uniblocStep wizard-step" data-stepid="${isUnlink ? 2 : 3}">
        ${it('a', isUnlink ? 2 : 3, 1)}
        ${it('b', isUnlink ? 2 : 3, 2)}
        </div>
        ${isUnlink ? inf(2, 3) : inf(3, 3)}
        <div class="blocsteps-row wizard-step" data-expert data-stepid="${isUnlink ? 3 : 4}">
        <div class="divWizShadeName"></div>
        <button id="${btnActionId}" type="button">${tr(isUnlink ? "BT_UNPAIR_GROUP" : "BT_PAIR_TO_GROUP")}</button>
        </div>
        <div class="uniblocStep wizard-step" data-stepid="${isUnlink ? 3 : 4}">
        ${it('a', isUnlink ? 3 : 4, 1)}
        ${it('b', isUnlink ? 3 : 4, 2)}
        <div class="empty-state"><svg class="empty-icon"><use href=#svg-succes></use></svg></div>
        </div>
        </div>
        </div>
        <div class="hrDivFooter"></div>
        <div class="expert-only-buttons" data-expert>
        <button type="button" line onclick="closeOverlay(this.closest('.inst-overlay'))">${tr("BT_CANCEL_1")}</button>
        </div>
        <div class="button-container-overlay">
        <button id="btnWizStop" class="wizard-step" data-stepid="1" line type="button">${tr("BT_CANCEL_1")}</button>
        <button id="btnWizPrev" class="wizard-step" data-mstepid="${isUnlink ? '2,3' : '2,3,4'}" line type="button" onclick="ui.wizSetPrevStep(this.closest('.wizard'));">${tr("BT_GO_BACK")}</button>
        <button id="btnWizNext" class="wizard-step" data-mstepid="${isUnlink ? '1,2' : '1,2,3'}" type="button" onclick="ui.wizSetNextStep(this.closest('.wizard'));">${tr("BT_NEXT")}</button>
        <button id="btnWizEnd" class="wizard-step" data-stepid="${stepsCount}" type="button">${tr("BT_CANCEL_1")}</button>
        </div>
        </div>`;

        const clearT = () => { if (this.btnTimer) { clearTimeout(this.btnTimer); this.btnTimer = null; } };

        div.querySelectorAll('#btnWizStop, #btnWizEnd').forEach(btn => btn.onclick = () => closeOverlay(div, clearT));

        const hP = div.querySelector('.instructions-header p');
        if (hP) hP.innerHTML += ' <span id="spanGroupName" class="groupNameSpan"></span>';

        div.querySelector('#btnOpenMemory').onclick = () => {
            const sId = isUnlink ? shadeId : ui.fromElement(div).shadeId;
            putJSONBusy('/shadeCommand', { shadeId: sId, command: 'prog', repeat: 40 }, (err) => {
                if (err) ui.serviceError(err);
                else {
                    let prompt = ui.promptMessage(tr('PROMPT_CONFIRM_MOTOR_RESPONSE'), () => {
                        ui.wizSetNextStep(div);
                        closeOverlay(prompt);
                    });
                    prompt.querySelector('.sub-message').innerHTML = isUnlink ?
                    `<hr><p>${tr("PROMPT_SHADE_MOVE_CONFIRM")}</p><p>${tr("UNLINK_GROUP_METHOD_1")}</p>` :
                    `<p>${tr("PROMPT_SHADE_MOVE_CONFIRM")}</p><p>${tr("LINK_GROUP_MEMORY_READY_FOR_GROUP")}</p>`;
                }
            });
        };
        const btnAction = div.querySelector(`#${btnActionId}`);
        let fnRepeat = (err, o) => {
            clearT();
            if (!err && mouseDown) {
                if (o.cmd === 'Sensor') somfy.sendSetSensor(o);
                else if (o.groupId !== undefined) somfy.sendGroupRepeat(o.groupId, 'prog', null, fnRepeat);
                else somfy.sendCommandRepeat(o.shadeId, 'prog', null, fnRepeat);
            }
        };
        if (isUnlink) {
            btnAction.onclick = () => {
                putJSONBusy('/groupCommand', { groupId: groupId, command: 'prog', repeat: 1 }, (err) => {
                    if (err) ui.serviceError(err);
                    else {
                        let prompt = ui.promptMessage(tr('PROMPT_CONFIRM_MOTOR_RESPONSE'), () => {
                            putJSONBusy('/unlinkFromGroup', { groupId: groupId, shadeId: shadeId }, (err, group) => {
                                somfy.setLinkedShadesList(group);
                                this.updateGroupList();
                            });
                            closeOverlay(prompt);
                            closeOverlay(div, clearT);
                        });
                        prompt.querySelector('.sub-message').innerHTML = `<hr><p>${tr("PROMPT_SHADE_MOVE_CONFIRM")}</p><p>${tr("PROMPT_SHADE_MOVE_DONE")}</p>`;
                    }
                });
            };
        } else {
            const progDown = () => {
                mouseDown = true;
                somfy.sendGroupCommand(groupId, 'prog', null, fnRepeat);
            };
            const progUp = () => {
                mouseDown = false;
                let obj = ui.fromElement(div);
                let prompt = ui.promptMessage(tr('PROMPT_CONFIRM_MOTOR_RESPONSE'), () => {
                    putJSONBusy('/linkToGroup', { groupId: groupId, shadeId: obj.shadeId }, (err, group) => {
                        somfy.setLinkedShadesList(group);
                        this.updateGroupList();
                    });
                    closeOverlay(prompt);
                    closeOverlay(div, clearT);
                });
                prompt.querySelector('.sub-message').innerHTML = `<p>${tr("PROMPT_SHADE_GROUP_LINK_CONFIRM")}</p><p>${tr("LINK_GROUP_LINK_DONE")}</p>`;
            };
            btnAction.onmousedown = progDown;
            btnAction.onmouseup = progUp;
            // Touch equivalents: a long hold on phones fires no synthesized mouse
            // events, which used to leave the repeat running or never open the
            // confirmation. preventDefault avoids the double-fire on short taps.
            btnAction.ontouchstart = (e) => { e.preventDefault(); progDown(); };
            btnAction.ontouchend = (e) => { e.preventDefault(); progUp(); };
        }
        const urlInit = isUnlink ? `/group?groupId=${groupId}` : `/groupOptions?groupId=${groupId}`;
        getJSONBusy(urlInit, (err, data) => {
            if (err) {
                ui.serviceError(err);
                return;
            }
            let canShow = false;
            const spanName = div.querySelector('#spanGroupName');

            if (isUnlink) {
                const shade = data.linkedShades.find(x => x.shadeId === shadeId);
                if (shade) {
                    if (spanName) spanName.textContent = data.name;
                    div.querySelectorAll('.divWizShadeName').forEach(el => el.textContent = shade.name);
                    canShow = true;
                } else {
                    ui.errorMessage(tr('ERR_DEVICE_NOT_FOUND_GROUP'));
                }
            } else {
                if (data.availShades && data.availShades.length > 0) {
                    if (spanName) spanName.textContent = data.name;
                    let selAvail = div.querySelector('#selAvailShades');
                    data.availShades.forEach(s => selAvail.options.add(new Option(s.name, s.shadeId)));
                    div.querySelectorAll('.divWizShadeName').forEach(el => el.textContent = data.availShades[0].name);
                    canShow = true;
                } else {
                    ui.errorMessage(tr('ERR_NO_DEVICE_AVAILABLE_GROUP'));
                }
            }
            if (canShow) {
                ui.wizSetStep(div, 1);
                shOverlay(div, clearT);
            }
        });
        return div;
    }
    linkGroupShade(groupId) { return this._gpWiz(groupId, false); }
    unlinkGroupShade(groupId, shadeId) { return this._gpWiz(groupId, true, shadeId); }

    unlinkRepeater(address) {
        let prompt = ui.promptMessage(tr('PROMPT_UNLINK_REPEATER'), () => {
            putJSONBusy('/unlinkRepeater', { address: address }, (err, repeaters) => {
                if (err) ui.serviceError(err);
                else this.setRepeaterList(repeaters);
                prompt.remove();
            });
        });
    }
    unlinkRemote(shadeId, remoteAddress) {
        let prompt = ui.promptMessage(tr('PROMPT_UNLINK_REMOTE'), () => {
            let obj = {
                shadeId: shadeId,
                remoteAddress: remoteAddress
            };
            putJSONBusy('/unlinkRemote', obj, (err, shade) => {

                if(DBG) console.log(shade);
                prompt.remove();
                this.setLinkedRemotesList(shade);
            });
        });
    }
    deviationChanged(el) {
        get('spanDeviation').innerText = (el.value / 100).fmt('#,##0.00');
    }
    rxBandwidthChanged(el) {
        get('spanRxBandwidth').innerText = (el.value / 100).fmt('#,##0.00');
    }
    frequencyChanged(el) {
        get('spanFrequency').innerText = (el.value / 1000).fmt('#,##0.000');
    }
    txPowerChanged(el) {
        if(DBG) console.log(el.value);
        let lvls = [-30, -20, -15, -10, -6, 0, 5, 7, 10, 11, 12];
        get('spanTxPower').innerText = lvls[el.value];
    }
    stepSizeChanged(el) {
        get('spanStepSize').innerText = parseInt(el.value, 10).fmt('#,##0');
    }
    processShadeTarget(el, shadeId) {
        let positioner = document.querySelector(`.shade-positioner[data-shadeid="${shadeId}"]`);
        if (positioner) {
            positioner.querySelector(`.shade-target`).innerHTML = el.value;
            somfy.sendCommand(shadeId, el.value);
        }
    }
    processShadeTiltTarget(el, shadeId) {
        let positioner = document.querySelector(`.shade-positioner[data-shadeid="${shadeId}"]`);
        if (positioner) {
            positioner.querySelector(`.shade-tilt-target`).innerHTML = el.value;
            somfy.sendTiltCommand(shadeId, el.value);
        }
    }
    openSelectRoom() {
        this.closeShadePositioners();
        if(DBG) console.log('Opening rooms');
        let list = get('divRoomSelector-list');
        list.style.display = 'block';
        document.body.addEventListener('click', () => {
            list.style.display = '';
        }, { once: true });
    }
    openSetPosition(shadeId) {
        if(DBG) console.log('Opening Shade Positioner');
        if (typeof shadeId === 'undefined') return;

        let shade = document.querySelector(`div.somfyShadeCtl[data-shadeid="${shadeId}"]`);
        if (!shade) return;

        let arrowUse = shade.querySelector('.handle-icon use');
        let existing = shade.querySelector('.shade-positioner');

        if (existing) {
            existing.classList.add('popup-slide-out');
            if (arrowUse) arrowUse.setAttribute('href', '#svg-arrowRight');
            setTimeout(() => { existing.remove(); }, 300);
            return;
        }
        document.querySelectorAll('.shade-positioner').forEach(el => {
            el.remove();
            document.querySelectorAll('.handle-icon use').forEach(u => u.setAttribute('href', '#svg-arrowRight'));
        });
        switch (parseInt(shade.getAttribute('data-shadetype'), 10)) {
            case 5: case 9: case 10: case 14: case 15: case 16: return;
        }

        let tiltType = parseInt(shade.getAttribute('data-tilt'), 10) || 0;
        let currPos = parseInt(shade.getAttribute('data-target'), 10) || 0;
        let currTiltPos = parseInt(shade.getAttribute('data-tilttarget'), 10) || 0;
        let lbl = makeBool(shade.getAttribute('data-flipposition')) ? `% ${tr('POPUP_OPEN')}` : `% ${tr('POPUP_CLOSED')}`;

        const positionSlider = (tiltType !== 3) ? `
        <div class="slider-group">
        <div class="slider-header">
        <span class="title">${tr('POPUP_TARGET_POSITION')}</span>
        <span class="val"><span id="spanShadeTarget" class="shade-target">${currPos}</span> ${lbl}</span>
        </div>
        <input id="slidShadeTarget" name="shadeTarget" type="range" min="0" max="100" step="1" value="${currPos}" onchange="somfy.processShadeTarget(this, ${shadeId});" oninput="get('spanShadeTarget').innerHTML = this.value;" />
        </div>` : '';

        const tiltSlider = (tiltType > 0) ? `
        <div class="slider-group" ${(tiltType !== 3) ? 'style="margin-top:10px;"' : ''}>
        <div class="slider-header">
        <span class="title">${tr('POPUP_TARGET_TILT_POSITION')}</span>
        <span class="val"><span id="spanShadeTiltTarget" class="shade-tilt-target">${currTiltPos}</span> ${lbl}</span>
        </div>
        <input id="slidShadeTiltTarget" name="shadeTarget" type="range" min="0" max="100" step="1" value="${currTiltPos}" onchange="somfy.processShadeTiltTarget(this, ${shadeId});" oninput="get('spanShadeTiltTarget').innerHTML = this.value;" />
        </div>` : '';

        let div = document.createElement('div');
        div.setAttribute('class', 'shade-positioner shade-positioner-popup');
        div.setAttribute('data-shadeid', shadeId);
        div.onclick = (event) => { event.stopPropagation(); };

        div.innerHTML = `
        <div class="shade-positioner-inner">
        ${positionSlider}
        ${tiltSlider}
        </div>`;

        shade.appendChild(div);
        if (arrowUse) arrowUse.setAttribute('href', '#svg-arrowLeft');

        document.body.addEventListener('click', () => {
            let ctls = document.querySelectorAll('.shade-positioner');
            ctls.forEach(ctl => {
                ctl.classList.add('popup-slide-out');
                let parentShade = ctl.closest('.somfyShadeCtl');
                if (parentShade) {
                    let u = parentShade.querySelector('.handle-icon use');
                    if (u) u.setAttribute('href', '#svg-arrowRight');
                }
                setTimeout(() => { ctl.remove(); }, 300);
            });
        }, { once: true });
    }
}
var somfy = new Somfy();
class MQTT {
    initialized = false;
    init() { this.initialized = true; }
    async loadMQTT() {
        getJSONBusy('/mqttsettings', (err, settings) => {
            if (err)
                if(DBG) console.log(err);
            else {
                if(DBG) console.log(settings);
                this.hasPassword = makeBool(settings.hasPassword);
                ui.toElement(get('divMQTT'), { mqtt: settings });
                // The server never sends the stored broker password: clear the field and
                // show a presence placeholder instead of prefilling it.
                const fldPwd = get('fldMqttPassword');
                if (fldPwd) { fldPwd.value = ''; fldPwd.placeholder = this.hasPassword ? tr('SECRET_SET_PLH') : ''; }
                get('divDiscoveryTopic').style.display = settings.pubDisco ? '' : 'none';
                get('hrIdDiscoveryTopic').style.display = settings.pubDisco ? '' : 'none';
            }
        });
    }
    // Picking MQTTS while the port is still the plaintext default is the most common
    // way to get an unexplained handshake failure, so follow the scheme as long as the
    // user is sitting on one of the two well-known ports.
    protocolChanged(el) {
        let port = get('fldMqttPort');
        if (!port) return;
        let secure = String(el.value || '').toLowerCase().startsWith('mqtts');
        if (secure && port.value.trim() === '1883') port.value = '8883';
        else if (!secure && port.value.trim() === '8883') port.value = '1883';
    }
    connectMQTT() {
        let obj = ui.fromElement(get('divMQTT'));
        if(DBG) console.log(obj);
        if (obj.mqtt.enabled) {
            if (typeof obj.mqtt.hostname !== 'string' || obj.mqtt.hostname.length === 0) {
                ui.errorMessage (tr('ERR_HOSTNAME')).querySelector('.sub-message').innerHTML = tr('ERR_MQTT_HOSTNAME_REQUIRED');
                return;
            }
            if (obj.mqtt.hostname.length > 64) {
                ui.errorMessage (tr('ERR_HOSTNAME')).querySelector('.sub-message').innerHTML = tr('ERR_HOSTNAME_MAX_LENGTH_64');
                return;
            }
            if (isNaN(obj.mqtt.port) || obj.mqtt.port < 0) {
                ui.errorMessage (tr('ERR_PORT_INVALID')).querySelector('.sub-message').innerHTML = tr('ERR_MQTT_PORT_HINT');
                return;
            }
            if (typeof obj.mqtt.username === 'string' && obj.mqtt.username.length > 32) {
                ui.errorMessage (tr('ERR_USERNAME_INVALID')).querySelector('.sub-message').innerHTML = tr('ERR_USERNAME_MAX_LENGTH_32');
                return;
            }
            if (typeof obj.mqtt.password === 'string' && obj.mqtt.password.length > 32) {
                ui.errorMessage (tr('ERR_PASSWORD_INVALID')).querySelector('.sub-message').innerHTML = tr('ERR_PASSWORD_MAX_LENGTH_32');
                return;
            }
            if (typeof obj.mqtt.rootTopic === 'string' && obj.mqtt.rootTopic.length > 64) {
                ui.errorMessage (tr('ERR_ROOT_TOPIC_INVALID')).querySelector('.sub-message').innerHTML = tr('ERR_ROOT_TOPIC_MAX_LENGTH_64');
                return;
            }
        }
        // The root topic scopes every command topic of this device. Empty, or with a
        // wildcard in it, and anyone else on the broker can drive the shades, so the
        // firmware refuses the payload whether MQTT is enabled or not: catch it here to
        // explain why in the user's language.
        if (typeof obj.mqtt.rootTopic !== 'string' || obj.mqtt.rootTopic.trim().length === 0
            || /[+#]/.test(obj.mqtt.rootTopic) || /^[\/$]/.test(obj.mqtt.rootTopic)) {
            ui.errorMessage (tr('ERR_ROOT_TOPIC_INVALID')).querySelector('.sub-message').innerHTML = tr('ERR_ROOT_TOPIC_HINT');
            get('fldMqttTopic').focus();
            return;
        }
        // Only send the password when the user actually typed one; an empty field
        // means "keep the stored password" (mirrors the firmware fromJSON rule).
        if (!obj.mqtt.password) delete obj.mqtt.password;
        putJSONBusy('/connectmqtt', obj.mqtt, (err, response) => {
            if (err) {
                ui.serviceError(err);
            } else {
                ui.successMessage(tr('MSG_SAVE_SUCCESS'));
                if(DBG) console.log(response);
            }
        });
    }
}
var mqtt = new MQTT();
class Firmware {
    initialized = false;
    init() { this.initialized = true; }
    isMobile() {
        let agt = navigator.userAgent.toLowerCase();
        return /Android|iPhone|iPad|iPod|BlackBerry|BB|PlayBook|IEMobile|Windows Phone|Kindle|Silk|Opera Mini/i.test(navigator.userAgent);
    }
    async backup() {
        let overlay = ui.waitMessage(get('divContainer'));
        return await new Promise((resolve, reject) => {
            let xhr = new XMLHttpRequest();
            xhr.responseType = 'blob';
            xhr.onreadystatechange = (evt) => {
                if (xhr.readyState === 4 && xhr.status === 200) {
                    let obj = window.URL.createObjectURL(xhr.response);
                    var link = document.createElement('a');
                    document.body.appendChild(link);
                    let header = xhr.getResponseHeader('content-disposition');
                    let fname = 'backup';
                    if (typeof header !== 'undefined') {
                        let start = header.indexOf('filename="');
                        if (start >= 0) {
                            let length = header.length;
                            fname = header.substring(start + 10, length - 1);
                        }
                    }
                    if(DBG) console.log(fname);
                    link.setAttribute('download', fname);
                    link.setAttribute('href', obj);
                    link.click();
                    link.remove();
                    setTimeout(() => { window.URL.revokeObjectURL(obj); }, 0);
                }
            };
            xhr.onload = (evt) => {
                if (typeof overlay !== 'undefined') overlay.remove();
                let status = xhr.status;
                if (status !== 200) {
                    if (status === 401 && typeof security !== 'undefined' && security.promptLoginOn401()) { if (typeof overlay !== 'undefined' && overlay) overlay.remove(); return; }
                    let err = xhr.response || {};
                    err.htmlError = status;
                    err.service = `GET /backup`;
                    if (typeof err.desc === 'undefined') err.desc = xhr.statusText || httpStatusText[xhr.status || 500];
                    if(DBG) console.log('Done');
                    reject(err);
                }
                else {
                    resolve();
                }
            };
            xhr.onerror = (evt) => {
                if (typeof overlay !== 'undefined') overlay.remove();
                let err = {
                    htmlError: xhr.status || 500,
                    service: `GET /backup`
                };
                if (typeof err.desc === 'undefined') err.desc = xhr.statusText || httpStatusText[xhr.status || 500];
                if(DBG) console.log(err);
                reject(err);
            };
            xhr.onabort = (evt) => {
                if (typeof overlay !== 'undefined') overlay.remove();
                if(DBG) console.log('Aborted');
                if (typeof overlay !== 'undefined') overlay.remove();
                reject({ htmlError: status, service: 'GET /backup' });
            };
            xhr.open('GET', baseUrl.length > 0 ? `${baseUrl}/backup` : '/backup', true);
            xhr.setRequestHeader('apikey', security.apiKey);
            xhr.send();
        });
    }
    restore() {
        let div = this.createFileUploader('/restore');
        let inst = div.querySelector('#divInstText');
        //[id, bind, text, checked]
        const opts = [
            ['cbRestoreShades', 'shades', 'RESTORE_SHADES_GROUPS', 1],
            ['cbRestoreRepeaters', 'repeaters', 'RESTORE_REPEATERS', 0],
            ['cbRestoreSystem', 'settings', 'RESTORE_SYSTEM_SETTINGS', 0],
            ['cbRestoreNetwork', 'network', 'RESTORE_NETWORK_SETTINGS', 0],
            ['cbRestoreMQTT', 'mqtt', 'RESTORE_MQTT_SETTINGS', 0],
            ['cbRestoreTransceiver', 'transceiver', 'RESTORE_RADIO_SETTINGS', 0]
        ];

        let html = opts.map(o => `
        <label class="uniRow" style="padding:8px 0">
        <div class="uniLabel">${tr(o[2])}</div>
        <div class="uniRight">
        <span class="switch">
        <input id="${o[0]}" type="checkbox" data-bind="${o[1]}" ${o[3]?'checked':''}>
        <div></div>
        </span>
        </div>
        </label>`).join('');

        inst.innerHTML = `
        ${overlayHeader('RESTORE_TITLE', 'RESTORE_DESC', 'svg-restore')}
        <div class="uniblocStep"><div>${tr('RESTORE_SELECT_FILE')}</div></div>
        <div id="jsUniRestore" class="unibloc">${html}</div>`;

        shOverlay(div);
    }
    createFileUploader(service) {
        const isRestore = service === '/restore', isMob = this.isMobile(), div = document.createElement('div');
        div.id = 'divUploadFile';
        div.className = 'inst-overlay';

        const step = (n, content, hide = false) => hide ? '' : `
        <div class="v-step-item">
        <div class="v-step-left"><div class="step-counter">${n}</div><div class="v-step-line"></div></div>
        <div class="v-step-right"><div>${content}</div></div>
        </div>`;

        div.innerHTML = `
        <div class="instructions-content">
        <div class="overlay-scroll-content">
        <form method="POST" action="#" enctype="multipart/form-data" id="frmUploadApp">
        <div id="divInstText"></div>
        <div class="vertical-steps-container">
        ${step(1, `
        <div style="font-size:14px;">${tr(service === '/updateFirmware' ? 'FIRMWARE_UPDATE_SYSTEM' : 'FIRMWARE_UPDATE_LITTLEFS')}</div>
        <a href="https://github.com/Pulpyyyy/ESPSomfy-RTS/releases" target="_blank" class="link">${tr('FIRMWARE_UPDATE_FROM_GITHUB')}<svg class="svgInTextSmall"><use href="#svg-linkOut"></use></svg></a>
        `, isRestore)}
        <div class="v-step-item ${isRestore ? '' : 'has-extra-content'}" style="${isRestore ? 'height:auto;margin:15px 0 0' : ''}">
        <div class="v-step-left" style="${isRestore ? 'display:none' : ''}">
        <div class="step-counter">2</div><div class="v-step-line"></div>
        </div>
        <div class="v-step-right" style="${isRestore ? 'padding-left:0' : ''}">
        <input id="fileName" type="file" name="updateFS" style="display:none"
        onchange="const f=this.files[0];if(f){const s=get('span-selected-file');s.innerText=f.name;s.style.opacity='1';firmware.checkBackupVersion(f)}"/>
        <label for="fileName" class="custom-file-upload">
        <span id="span-selected-file" class="file-name-display">${tr('CHOOSE_FILE')}</span>
        <div class="file-icon-btn"><svg><use href="#svg-upload"></use></svg></div>
        </label>
        </div>
        </div>
        <div class="v-step-item" style="${isRestore ? 'display:none' : ''}">
        <div class="v-step-left"><div class="step-counter">3</div></div>
        <div class="v-step-right"><div>${tr('FIRMWARE_UPDATE_VERIFY_0')} <svg class="svgInText"><use href="#svg-download"></use></svg> ${tr('FIRMWARE_UPDATE_VERIFY_1')}</div></div>
        </div>
        </div>
        <div class="warning" style="${isRestore ? '' : 'display:none'}">
        <svg><use href=#svg-warning></use></svg>
        <div><b>${tr('MSG_ALERT')}</b><span>${tr('RESTORE_NETWORK_WARNING')}</span></div>
        </div>
        <div class="progress-bar" id="progFileUpload" style="display:none;margin:15px 0"></div>
        </div>
        <div class="hrDivFooter"></div>
        <div class="button-container-overlay"><div class="footer-sticky-content">
        <div class="uniRow backup-row" style="${isRestore ? 'display:none' : ''}">
        <div class="uniText">
        <span class="uniLabel">${tr('FIRMWARE_SAVE_BACKUP')}</span>
        <span class="uniStatus">${tr(isMob ? 'FIRMWARE_SAVE_BACKUP_DESC_MOB' : 'FIRMWARE_SAVE_BACKUP_DESC')}</span>
        </div>
        <div id="btnBackupCfg" class="gitBackup" ${a11yBtn(tr('A11Y_BACKUP'))} onclick="firmware.backup()"><svg><use href="#svg-download"></use></svg></div>
        </div>
        <div class="button-container-row">
        <button id="btnClose" line type="button" onclick="closeOverlay(get('divUploadFile'))">${tr('BT_CANCEL_1')}</button>
        <button id="btnUploadFile" type="button" onclick="firmware.uploadFile('${service}',get('divUploadFile'),ui.fromElement(get('divUploadFile')))">${tr('BT_UPLOAD_FILE')}</button>
        </div>
        </div></div>
        </form>
        </div>`;

        return div;
    }
    checkBackupVersion(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            const lines = e.target.result.split('\n');
            if (lines.length > 0) {
                const ver = parseInt(lines[0].split(',')[0]);
                if (!isNaN(ver) && ver < 25) {
                    let prompt = ui.promptMessage(tr('PROMPT_RESTORE_FILE_TITLE'), () => closeOverlay(prompt));

                    prompt.querySelector('.sub-message').innerHTML = `<p style="color:var(--txt-orange); font-weight:bold;"><p>${tr('PROMPT_RESTORE_FILE_DESC')}</p><p><b>${tr('PROMPT_RESTORE_FILE_DESC_1')}</b></p><p>${tr('PROMPT_RESTORE_FILE_DESC_2')}</p>`;

                    const btnCan = prompt.querySelector('button[line]');
                    if (btnCan) {
                        btnCan.onclick = () => {
                            get('fileName').value = "";
                            get('span-selected-file').innerText = tr('CHOOSE_FILE');
                            closeOverlay(prompt);
                        };
                    }
                }
            }
        };
        reader.readAsText(file.slice(0, 100));
    }
    procMemoryStatus(mem) {
        if(DBG) console.log(mem);
        let sp = get('spanFreeMemory');
        if (sp) sp.innerHTML = mem.free.fmt("#,##0 ");
        sp = get('spanMaxMemory');
        if (sp) sp.innerHTML = mem.max.fmt('#,##0 ');
        sp = get('spanMinMemory');
        if (sp) sp.innerHTML = mem.min.fmt('#,##0 ');
    }
    procFwStatus(rel) {
        const divsGlobal = document.querySelectorAll('.firmware-message');
        const divLocal = get('divSystemStatus');
        const statusDesc = get('statusDesc');

        if (divsGlobal.length === 0) return;
        divsGlobal.forEach(div => {
            div.classList.remove('procFwStatusshow');
            div.onclick = null;
            setClickable(div, false);
        });
        if (rel.available && rel.status === 0 && rel.checkForUpdate !== false) {
            divsGlobal.forEach(div => {
                div.classList.add('procFwStatusshow');
                div.style.cursor = 'pointer';
                div.onclick = () => { firmware.updateGithub(); };
                div.innerHTML = `<span>${tr('FW_UPDATE_AVAILABLE')}</span>`;
                setClickable(div, true);
            });
            if (divLocal) {
                divLocal.className = "error";
                get('useStatusIcon')?.setAttribute('href', '#svg-error');
                const st = get('statusTitle');
                const isBlocked = this.needsUsbFlash();

                if (st) st.innerHTML = tr(isBlocked ? 'FW_UPDATE_REQUIRED_USB' : 'FW_UPDATE_AVAILABLE');
                statusDesc.innerHTML = isBlocked
                ? tr('FW_UPDATE_USB_DESC').replace('%1', rel.latest.name)
                : tr('FW_UPDATE_ACTION_DESC2').replace('%1', rel.latest.name);

                divLocal.style.cursor = 'pointer';
                divLocal.onclick = () => { firmware.updateGithub(); };
                setClickable(divLocal, true);
            }
        }
        else if (rel.status === 4 && rel.error !== 0) {
            let e = errors.find(x => x.code === rel.error) || { desc: tr('ERR_UNSPECIFIED') };
            let inst = get('divGitInstall');
            if (inst) inst.remove();
            ui.errorMessage(e.desc);
        }
        else {
            if (divLocal) {
                divLocal.className = "success";
                get('useStatusIcon')?.setAttribute('href', '#svg-info');
                const st = get('statusTitle');
                if (st) st.innerHTML = tr('FW_UPDATE_UPTODATE');
                statusDesc.innerHTML = tr('FW_UPDATE_ACTION_DESC');

                divLocal.style.cursor = '';
                divLocal.onclick = null;
                setClickable(divLocal, false);
            }
        }
    }
    procUpdateProgress(prog) {
        const pct = Math.round((prog.loaded / prog.total) * 100);
        general.reloadApp = true;
        const git = get('divGitInstall');

        if (git) {
            if (pct >= 100 && prog.part === 100) {
                git.remove();
                let title = `<svg><use xlink:href="#svg-succes"></use></svg>`;
                let infoDiv = ui.errorMessage(title);
                infoDiv.querySelector('.sub-message').innerHTML = `${tr('GIT_RELEASE_SUCCES_1')}<br>${tr('GIT_RELEASE_SUCCES_2')}`;

                let btn = infoDiv.querySelector('button');
                if (btn) {
                    btn.innerText = tr('BT_RELOAD') || "Recharger la page";
                    btn.onclick = function() { location.reload(); };
                }
            } else {
                if (prog.part === 100) {
                    const btnCancel = get('btnCancelUpdate');
                    if (btnCancel) btnCancel.style.display = 'none';
                }
                const p = (prog.part === 100) ?
                get('progApplicationDownload') :
                get('progFirmwareDownload');

                if (p) {
                    p.style.setProperty('--progress', `${pct}%`);
                    p.setAttribute('data-progress', `${pct}%`);
                }
            }
        }
    }
    // Extract only the first number after the 'v' (e.g. "v2.5.2" -> 2, "v3.0.0" -> 3, "3.1.2" -> 3)
    getMainVersion(verStr) {
        if (!verStr) return 0;
        const match = verStr.match(/[vV]?(\d+)/);
        return match ? parseInt(match[1], 10) : 0;
    }
    // Real partition check (replaces the old "major version 2 -> 3" heuristic):
    // the published images require the enlarged OTA layout (app slots of 1.6875 MB
    // plus a 512 KB LittleFS). A device still on the old, smaller partition table
    // cannot hold them and needs a one-time USB flash. otaSize is the inactive OTA
    // slot size reported by the firmware (loginContext). 0/unknown = don't block.
    needsUsbFlash() {
        const otaSize = parseInt(get('divContainer')?.getAttribute('data-otasize') || '0', 10);
        return otaSize > 0 && otaSize < 0x1B0000; // 0x1B0000 = 1.6875 MB (enlarged app slot)
    }

    async installGitRelease(div) {
        let obj = ui.fromElement(div);

        // Real partition guard (belt-and-braces against a tampered UI): refuse to
        // install the enlarged-layout images on a device still on the old table.
        if (this.needsUsbFlash()) {
            ui.errorMessage(tr('MSG_ALERT')).querySelector('.sub-message').innerHTML = tr('ERR_GIT_PARTITION_BLOCKED');
            return;
        }
        if (!this.isMobile()) {
            try { await firmware.backup(); }
            catch (err) { return ui.serviceError(div, err); }
        }
        putJSONBusy(`/downloadFirmware?ver=${obj.version}`, {}, (err, ver) => {
            if (err) return ui.serviceError(err);
            general.reloadApp = true;
            const desc = tr('GIT_RELEASE_DESC').replace('%1', esc(ver.name));

            div.innerHTML = `
            <div class="instructions-content">

            ${overlayHeader('GIT_RELEASE_TITLE', '', 'svg-github')}
            <div class="warning">
            <svg><use href=#svg-warning></use></svg>
            <div><b>${tr('GIT_RELEASE_WAIT_WARNING')}</b><span>${tr('GIT_RELEASE_WAIT_WARNING_1')}</span></div>
            </div>
            <div class="progress-bar" id="progFirmwareDownload"></div>
            <label for="progFirmwareDownload">${tr('GIT_RELEASE_FIRMWARE_INSTALL_PROGRESS')}</label>
            <div class="progress-bar" id="progApplicationDownload"></div>
            <label for="progApplicationDownload">${tr('GIT_RELEASE_APPLICATION_INSTALL_PROGRESS')}</label>
            <div class="button-container-col">
            <button id="btnCancelUpdate" line type="button">${tr('BT_CANCEL_1')}</button>
            </div>
            </div>`;

            const hP = div.querySelector('.instructions-header p');
            if (hP) hP.innerHTML = desc;

            div.querySelector('[close]').onclick = () => closeOverlay(div);
            div.querySelector('#btnCancelUpdate').onclick = () => firmware.cancelInstallGit(div);
        });
    }
    cancelInstallGit(div) {
        putJSONBusy(`/cancelFirmware`, {}, (err) => {
            if (err) ui.serviceError(err);
            closeOverlay(div);
        });
    }
    updateGithub() {
        getJSONBusy('/getReleases', (err, rel) => {
            if (err) return ui.serviceError(err);
            const div = document.createElement('div'), isMob = this.isMobile();
            const chip = (get('divContainer').getAttribute('data-chipmodel') || "").toLowerCase();
            div.id = 'divGitInstall';
            div.className = 'inst-overlay';
            div.setAttribute('data-installed', rel.appVersion.name);

            rel.releases.sort((a, b) => a.preRelease === b.preRelease && b.draft === a.draft ? 0 : a.preRelease ? 1 : -1);

            const optsHtml = rel.releases.map(r => {
                const name = r.name.toLowerCase();
                if (name === 'main' || name === 'master' || (r.hwVersions.length > 0 && r.hwVersions.indexOf(chip) < 0)) return '';
                return `<option value="${esc(r.version.name)}" data-prerelease="${r.preRelease}">${esc(r.name)}${r.preRelease ? ' - Pre' : ''}</option>`;
            }).join('');

            div.innerHTML = `
            <div class="instructions-content">
            <div class="overlay-static-content">
            ${overlayHeader('UPDATE_GIT_TITLE', 'UPDATE_GIT_DESC', 'svg-github')}
            <div class="uniRow"><span class="label">${tr('FIRMWARE_INSTALLED')}</span><span class="labelgrey">${esc(rel.appVersion.name)}</span></div>
            <div class="uniRow">
            <span class="label">${tr('FIRMWARE_AVAILABLE')}</span>
            <select id="selVersion" class="selectCompac" data-bind="version">${optsHtml}</select>
            </div>
            <a id="lnkGithubRelease" href="#" target="_blank" class="link">${tr('FIRMWARE_NOTE_GITHUB')}<svg class="svgInTextSmall"><use href="#svg-linkOut"></use></svg></a>
            <div id="divPrereleaseWarning" class="error" style="display:none;"><svg><use href=#svg-error></use></svg><div><span id="spanUpdateWarning"></span></div></div>
            <div id="divUpToDate" class="upToDateNote" style="display:none;"><svg><use href="#svg-succes"></use></svg><span>${tr('FW_ALREADY_CURRENT')}</span></div>
            <div class="hrDiv"></div>
            <div class="warningText"><svg><use href="#svg-warning"></use></svg><span>${tr('FIRMWARE_CACHE')}</span></div>

            <div id="notesPreview" class="release-notes-preview">
            <div class="wifiConnectScan">
            <div class="lds-roller"><div></div><div></div><div></div><div></div><div></div><div></div><div></div><div></div></div>
            </div>
            </div>
            <div class="hrDivFooter"></div>
            </div> <div class="button-container-overlay">
            <div class="footer-sticky-content">
            <div class="uniRow">
            <div class="uniText"><span class="uniLabel">${tr('FIRMWARE_SAVE_BACKUP')}</span><span class="uniStatus">${tr(isMob ? 'FIRMWARE_SAVE_BACKUP_DESC_MOB' : 'FIRMWARE_SAVE_BACKUP_DESC')}</span></div>
            <div id="btnBackupCfg" class="gitBackup" ${a11yBtn(tr('A11Y_BACKUP'))} onclick="firmware.backup()"><svg><use href="#svg-download"></use></svg></div>
            </div>
            <div class="button-container-row">
            <button id="btnClose" line type="button" onclick="closeOverlay(get('divGitInstall'))">${tr('BT_CANCEL_1')}</button>
            <button id="btnUpdate" type="button" class="btn-main" onclick="firmware.installGitRelease(get('divGitInstall'))">${tr('BT_UPDATE')}</button>
            </div>
            </div>
            </div>
            </div>`;

            shOverlay(div);
            const sel = div.querySelector('#selVersion');

            const updateNotes = async () => {
                const nDiv = div.querySelector('#notesPreview'), lnk = div.querySelector('#lnkGithubRelease');
                if (!nDiv) return;

                nDiv.innerHTML = '<div class="wifiConnectScan"><div class="lds-roller"><div></div><div></div><div></div><div></div><div></div><div></div><div></div><div></div></div></div>';

                try {
                    const r = await firmware.getReleaseInfo(sel.value, true);
                    if (r?.info?.body) {
                        nDiv.innerHTML = firmware.parseMarkdown(r.info.body);
                        if (lnk && r.info.html_url) lnk.href = r.info.html_url;
                    } else {
                        throw new Error("No body");
                    }
                } catch (e) {
                    nDiv.innerHTML = `
                    <div class="divGitNoteError">
                    <div class="gitNoteError">${tr('ERR_GIT_NOTE')}</div>
                    <div class="gitNoteErrorSub">${tr('UPDATE_GIT_NOTE')}</div>
                    </div>`;
                }
            };
            sel.addEventListener('change', () => { this.gitReleaseSelected(div); updateNotes(); });
            this.gitReleaseSelected(div);
            updateNotes();
        });
    }
    gitReleaseSelected(div) {
        const sel = div.querySelector('#selVersion');
        if (!sel || sel.selectedIndex === -1) return;

        const opt = sel.options[sel.selectedIndex];
        const isPre = opt.getAttribute('data-prerelease') === "true";
        const divPre = div.querySelector('#divPrereleaseWarning');
        const spanWarning = div.querySelector('#spanUpdateWarning');
        const btnUpdate = div.querySelector('#btnUpdate');
        // Selected version == installed version: say so plainly and stop urging an
        // update; the action becomes an explicit "Reinstall" (legitimate repair path).
        const normVer = (s) => (s || '').toLowerCase().replace(/^v/, '');
        const isCurrent = normVer(opt.value) === normVer(div.getAttribute('data-installed'));
        const divUpToDate = div.querySelector('#divUpToDate');
        if (divUpToDate) divUpToDate.style.display = isCurrent ? 'flex' : 'none';
        if (btnUpdate) btnUpdate.textContent = tr(isCurrent ? 'BT_REINSTALL' : 'BT_UPDATE');
        let isBlocked = false;
        let blockMessage = '';

        // Block on the real partition layout, not on the version number.
        if (this.needsUsbFlash()) {
            isBlocked = true;
            blockMessage = tr('UPDATE_GIT_UPDATE_V3_BLOCKED');
        }

        if (isBlocked) {
            if (spanWarning) spanWarning.innerHTML = blockMessage;
            if (divPre) divPre.style.display = 'flex';
            if (btnUpdate) btnUpdate.disabled = true;
        } else {
            if (btnUpdate) btnUpdate.disabled = false;
            if (divPre) {
                if (isPre) {
                    if (spanWarning) spanWarning.innerHTML = tr('UPDATE_GIT_RELEASE_BETA');
                    divPre.style.display = 'flex';
                } else {
                    divPre.style.display = 'none';
                }
            }
        }
        const divNotes = div.querySelector('#divReleaseNotes');
        if (divNotes) {
            const val = sel.value;
            divNotes.style.display = (!val || val === 'main') ? 'none' : '';
        }
    }
    async getReleaseInfo(tag, silent = false) {
        let overlay = null;
        if (!silent) overlay = ui.waitMessage(document.getElementById('divContainer'));
        try {
            let ret = { resp: { ok: false }, info: null };
            ret.resp = await fetch(`https://api.github.com/repos/Pulpyyyy/ESPSomfy-RTS/releases/tags/${encodeURIComponent(tag)}`);
            if (ret.resp.ok) {
                ret.info = await ret.resp.json();
            }
            return ret;
        }
        catch (err) {
            return { resp: { ok: false }, err: err };
        }
        finally {
            if (overlay) overlay.remove();
        }
    }
    formatInlineMarkdown(txt) {
        if (!txt) return '';
        // Release notes are fetched from the GitHub API and injected with innerHTML, so
        // escape the whole text first and let only the rules below emit markup. Markdown
        // syntax characters are untouched by esc(). Everything past this point is already
        // escaped -- notably link labels and hrefs -- so it must not be escaped again.
        return esc(txt)
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<i>$1</i>')
        .replace(/`([^`]+)`/g, '<code class="md-code-inline">$1</code>')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, text, url) => {
            const href = safeUrl(url);
            return href ? `<a href="${href}" target="_blank" class="md-link">${text}</a>` : text;
        })
        .replace(/(?<!["=>])(https?:\/\/[^\s<]+)/g, (m, url) => `<a href="${url}" target="_blank" class="md-link-auto">${url}</a>`);
    }
    parseMarkdown(bodyText) {
        const self = this;
        const ctx = {
            lines: (bodyText || "").split(/\r?\n/),
            ndx: 0,
            html: '',
            token(txt) {
                const trimmed = txt.trim();
                if (!trimmed) return { type: 'empty' };
                const firstChar = txt.match(/\S/);
                const indent = firstChar ? txt.indexOf(firstChar[0]) : 0;
                if (trimmed.startsWith('#')) return { type: 'head', txt: trimmed, indent };
                if (trimmed.startsWith('* ')) return { type: 'list', txt: trimmed.substring(2), indent };
                return { type: 'text', txt: trimmed, indent };
            },
            renderHead(token) {
                const level = (token.txt.match(/^#+/) || ["#"])[0].length;
                const content = token.txt.replace(/^#+\s*/, '');
                return `<h${level} style="margin: 10px 0 5px 0;">${self.formatInlineMarkdown(content)}</h${level}>`;
            },
            renderList() {
                let listHtml = '<ul class="md-list" style="padding:0; margin:5px 0;">';
                while (this.ndx < this.lines.length) {
                    const t = this.token(this.lines[this.ndx]);
                    if (t.type !== 'list') break;
                    const margin = (t.indent * 8) + 20;
                    listHtml += `<li style="margin-left:${margin}px; text-align:left; list-style-type:disc;">${self.formatInlineMarkdown(t.txt)}</li>`;
                    this.ndx++;
                }
                listHtml += '</ul>';
                return listHtml;
            },
            parse() {
                while (this.ndx < this.lines.length) {
                    const t = this.token(this.lines[this.ndx]);
                    switch (t.type) {
                        case 'head': this.html += this.renderHead(t); this.ndx++; break;
                        case 'list': this.html += this.renderList(); break;
                        case 'empty': this.html += '<div style="height:8px"></div>'; this.ndx++; break;
                        default:
                            const margin = (t.indent * 8) + (t.indent > 0 ? 20 : 0);
                            this.html += `<p style="margin: 2px 0; margin-left:${margin}px; text-align:left; line-height:1.4;">${self.formatInlineMarkdown(t.txt)}</p>`;
                            this.ndx++;
                            break;
                    }
                }
            }
        };
        ctx.parse();
        return ctx.html;
    }
    updateManual(isApp = false) {
        const service = isApp ? '/updateApplication' : '/updateFirmware';
        const div = this.createFileUploader(service);

        if (isApp) general.reloadApp = true;
        const currentVer = isApp ? (general?.appVersion || this.appVersion) : (get('spanFwVersion').innerText || '?.?.?');

        div.querySelector('#divInstText').innerHTML = `
        ${overlayHeader('MANUAL_UPDATE_TITLE', isApp ? 'UPDATE_LITTLEFS_DESC' : 'UPDATE_FIRMWARE_DESC', 'svg-update')}
        <div class="uniRow"><span class="uniLabel">${tr('FIRMWARE_INSTALLED')}</span><span class="labelgrey">${currentVer}</span></div>
        <div class="warningText"><span>${tr('FIRMWARE_CACHE')}</span></div></div>
        <div class="hrDiv"></div>`;

        div.className += isApp ? ' mode-app-update' : ' mode-firm-update';
        shOverlay(div);

        const btnB = div.querySelector('#btnBackupCfg');
        if (btnB) {
            btnB.style.display = 'flex';
            btnB.onclick = () => firmware.backup();
        }
    }
    async uploadFile(service, el, data) {
        let field = el.querySelector('input[type="file"]'),
        filename = field.value,
        file = field.files[0],
        title = tr('MSG_ALERT'),
        err = null;

        if (!filename) err = (service === '/restore') ? 'ERR_NO_FILE_BACKUP_SELECTED' : (service === '/updateApplication' ? 'ERR_NO_FILE_LITTLEFS_SELECTED' : 'ERR_NO_FILE_FIRMWARE_SELECTED');
        else if (service === '/updateApplication' && (!filename.includes('.littlefs') || !filename.endsWith('.bin'))) err = 'ERR_INVALID_FILE_LITTLEFS';
        else if (service === '/updateFirmware' && (!filename.includes('.ino.') || !filename.endsWith('.bin'))) err = 'ERR_INVALID_FILE_FIRMWARE';
        else if (service === '/restore') {
            if (file.size > 20480) {
                ui.errorMessage(title).querySelector('.sub-message').innerHTML = tr('ERR_BACKUP_TOO_LARGE').replace('%s', file.size.fmt("#,##0"));
                return;
            }
            if (!filename.endsWith('.backup')) err = 'ERR_INVALID_FILE_BACKUP';
            else if (!['shades', 'settings', 'network', 'transceiver', 'repeaters', 'mqtt'].some(k => data[k])) err = 'ERR_NO_RESTORE_OPTION';
        }
        if (err) {
            ui.errorMessage(title).querySelector('.sub-message').innerHTML = tr(err);
            return;
        }
        if (service !== '/restore' && !this.isMobile()) {
            try { await firmware.backup(); }
            catch (e) { return ui.serviceError(el, e); }
        }
        let formData = new FormData();
        formData.append('file', file);
        if (service === '/restore') formData.append('data', JSON.stringify(data));

        ['btnBackupCfg', 'btnUploadFile'].forEach(id => { let b = el.querySelector('#' + id); if (b) b.style.display = 'none'; });
        field.disabled = true;
        let steps = el.querySelector('.vertical-steps-container');
        if (steps) steps.style.display = 'none';
        let prog = el.querySelector('#progFileUpload'),
        btnCancel = el.querySelector('#btnClose');
        prog.style.display = '';

        let xhr = new XMLHttpRequest();
        xhr.open('POST', baseUrl ? `${baseUrl}${service}` : service, true);
        // Upload endpoints check auth before writing to flash.
        xhr.setRequestHeader('apikey', security.apiKey);

        xhr.upload.onprogress = (evt) => {
            let pct = evt.total ? Math.round((evt.loaded / evt.total) * 100) : 0;
            prog.style.setProperty('--progress', `${pct}%`);
            prog.setAttribute('data-progress', `${pct}%`);
        };

        xhr.onload = async () => {
            btnCancel.innerText = tr('BT_CLOSE');
            if (service === '/restore') {
                await somfy.init();
                closeOverlay(get('divUploadFile'));
            }
        };
        xhr.onerror = () => ui.serviceError(el, 'Upload Failed');
        btnCancel.onclick = () => { xhr.abort(); closeOverlay(el); };
        xhr.send(formData);
    }
}
var firmware = new Firmware();
