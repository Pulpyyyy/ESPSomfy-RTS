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
        let sockUrl;
        if (window.location.protocol !== 'file:' && basePath.length > 0) {
            // Behind a reverse proxy under a sub-path: tunnel the socket
            // through the proxy at <basePath>/ws on the page's own origin
            // (wss on HTTPS pages — no mixed content, no direct :8080 access).
            sockUrl = `${protocol}//${window.location.host}${basePath}/ws`;
        } else {
            const port = window.location.protocol === 'https:' ? '' : ':8080';
            sockUrl = `${protocol}//${host}${port}/`;
        }
        socket = new WebSocket(sockUrl);
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
                    // One round trip for the four payloads below; each loader
                    // then reads it from the cache instead of opening its own
                    // connection. Behind a reverse proxy that is seconds saved.
                    await new Promise(res => bootstrapPrime(res));
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
// Save buttons mirror the dirty flag: fully hidden until an edit exists,
// hidden again once the save went through. The disabled property stays set
// underneath as a guard against programmatic clicks.  #btnLogin is excluded
// on purpose.
const NAV_SAVE_SEL = '[id^="btnSave"], #btnConnectMQTT';
function navSyncSaveButtons() {
    document.querySelectorAll(NAV_SAVE_SEL).forEach(b => { b.disabled = !_navDirty; b.classList.toggle('save-idle', !_navDirty); });
}
function navSuppress() { _navSuppress = true; setTimeout(() => { _navSuppress = false; }, 900); }
function navClearDirty() { _navDirty = false; navSyncSaveButtons(); }
function navMarkDirty() { if (!_navSuppress) { _navDirty = true; navSyncSaveButtons(); } }
function navGuardSetup() {
    navSyncSaveButtons();
    // After a save click, consider the edits persisted unless a validation error
    // surfaced (same heuristic as the leave-prompt Save path above).
    document.addEventListener('click', (e) => {
        const b = e.target && e.target.closest && e.target.closest(NAV_SAVE_SEL);
        if (!b) return;
        setTimeout(() => { if (!document.querySelector('.error-message')) navClearDirty(); }, 300);
    }, true);
    const mark = (e) => {
        if (!e.isTrusted) return;                       // programmatic change events are not user edits
        const t = e.target;
        if (!t || !t.matches || !t.matches('input,select,textarea')) return;
        if (t.classList.contains('pin-digit')) return;  // PIN entry (login or security page) is not a config edit
        if (t.closest && t.closest('#divUnauthenticated')) return;  // nothing on the login screen counts
        if (t.closest && t.closest('#divHomePnl')) return;  // dashboard controls act immediately, there is nothing to save
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
// Discarded edits must also leave the DOM: the panels are only repopulated on
// socket open, so the abandoned values would keep showing on the next visit as
// if they were the device's active settings.
function navReloadPanels() {
    navSuppress();
    (async () => {
        try {
            await general.loadGeneral();
            await somfy.loadSomfy();
            const authed = (typeof security === 'undefined') || security.type === 0 || security.authenticated;
            if (authed) { await wifi.loadNetwork(); await mqtt.loadMQTT(); }
        } catch (err) { console.error(err); }
    })();
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
    div.querySelector('#navDiscard').onclick = () => { navClearDirty(); done(); navReloadPanels(); proceed(); };
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
    rfdiag.init();
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
    // A rejected field is a correction to make, not an incident: it belongs under the
    // field, with the focus moved there, instead of behind a modal the user has to
    // dismiss before hunting for the cause. role="alert" is what carries the message to
    // a screen reader, since the focus lands on the input and not on the text.
    fieldError(el, msg) {
        this.clearFieldErrors();
        // A field belonging to a collapsed section cannot show or receive anything; the
        // modal is the honest fallback there rather than a message nobody can see.
        if (!el || el.offsetParent === null) return this.errorMessage(msg);
        let div = document.createElement('div');
        div.className = 'field-error';
        div.setAttribute('role', 'alert');
        div.textContent = msg;
        (el.parentElement || el).appendChild(div);
        el.setAttribute('aria-invalid', 'true');
        el.classList.add('is-invalid');
        el.focus();
        if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
        return div;
    }
    clearFieldErrors(scope) {
        const root = scope || document;
        root.querySelectorAll('.field-error').forEach((e) => e.remove());
        root.querySelectorAll('[aria-invalid]').forEach((e) => {
            e.removeAttribute('aria-invalid');
            e.classList.remove('is-invalid');
        });
    }
    clearErrors() {
        this.clearFieldErrors();
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
        // The toast is the only confirmation a save ever gets, and it removes itself after
        // 3.5s. Without a live region a screen reader user is never told the save landed.
        div.setAttribute('role', 'status');
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
