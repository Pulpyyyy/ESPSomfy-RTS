class RfDiag {
    // Passive RF statistics page.  Data comes from /rfStats (aggregates kept by the
    // firmware for every remote address heard over the air); shade names are joined
    // client-side through each shade's linkedRemotes list.
    loaded = false;
    refreshTimer = null;
    init() {
        // Lazy-load on first visit to the panel; navigation binding is generic so we
        // only need a click hook on the elements that target our group id.
        document.querySelectorAll('[data-grpid="divRFDiagnostics"]').forEach((el) => {
            el.addEventListener('click', () => this.load());
        });
    }
    isVisible() {
        const div = get('divRFDiagnostics');
        return div && div.style.display !== 'none' && div.offsetParent !== null;
    }
    onRemoteFrame(frame) {
        // While the guided wizard is open it consumes every frame; otherwise a frame
        // just means fresh stats, so refresh the table shortly after, debounced so a
        // repeat train (dozens of frames) causes a single reload.
        if (frame && this.guidedFrame(frame)) return;
        if (!this.isVisible()) return;
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = null;
            // The user may have navigated away during the debounce window.
            if (this.isVisible()) this.reload();
        }, 1500);
    }
    // ---- Guided measurement session ----
    // The user stands NEXT TO each shade and holds a button of its remote: every RTS
    // repeat is one RSSI sample of the remote->ESP path from the motor's location,
    // which by antenna reciprocity approximates the ESP->motor path.  The median of
    // the burst is stored per remote address and takes over the difficulty ranking.
    guided = null;
    startGuided() {
        const shades = (somfy.shades || []).filter((s) => (s.linkedRemotes || []).length);
        if (!shades.length) {
            ui.infoMessage(get('divRFDiagnostics'), tr('RFDIAG_GUIDED_NONE'));
            return;
        }
        this.guided = { shades, idx: 0, samples: [] };
        let div = get('divRfGuided');
        // A div caught mid exit-animation is about to be removed: rebuild instead of
        // writing into a node that disappears 300ms later.
        if (div && div.classList.contains('overlay-exit')) {
            div.remove();
            div = null;
        }
        if (!div) {
            div = document.createElement('div');
            div.id = 'divRfGuided';
            div.className = 'inst-overlay';
            div.innerHTML = `
            <div class="instructions-content">
            <div class="overlay-scroll-content">
            ${overlayHeader('RFDIAG_GUIDED_TITLE', 'RFDIAG_GUIDED_DESC', 'icon-tabRadio')}
            <div class="unibloc">
            <div id="divRfGuidedStep" class="uniLabel"></div>
            <div class="uniStatus">${tr('RFDIAG_GUIDED_HINT')}</div>
            </div>
            <div class="unibloc">
            <div class="uniRow">
            <div class="uniText"><div class="uniLabel">${tr('RFDIAG_GUIDED_SAMPLES')}</div><div id="divRfGuidedCount" class="uniStatus">0</div></div>
            <div class="uniRight"><span id="spanRfGuidedRssi" class="rfdiag-value">--</span></div>
            </div>
            </div>
            <div class="button-container-col">
            <button id="btnRfGuidedSave" type="button" disabled onclick="rfdiag.guidedSave();">${tr('BT_SAVE')}</button>
            <div style="display:flex;gap:10px;width:100%">
            <button id="btnRfGuidedSkip" line type="button" onclick="rfdiag.guidedNext();">${tr('RFDIAG_BT_SKIP')}</button>
            <button id="btnRfGuidedClose" line type="button">${tr('BT_CLOSE')}</button>
            </div>
            </div>
            </div>
            </div>`;
            // The header X, Escape and the footer button must all tear the wizard
            // down the same way, or a stray remoteFrame dereferences removed nodes.
            const terminate = () => {
                this.guided = null;
                this.load();
            };
            shOverlay(div, terminate);
            div.querySelector('#btnRfGuidedClose').onclick = () => closeOverlay(div, terminate);
        }
        this.guidedShow();
    }
    guidedShow() {
        const g = this.guided;
        g.samples = [];
        get('divRfGuidedStep').textContent = trf('RFDIAG_GUIDED_STEP', g.idx + 1, g.shades.length, g.shades[g.idx].name);
        get('divRfGuidedCount').textContent = '0';
        get('spanRfGuidedRssi').textContent = '--';
        get('btnRfGuidedSave').disabled = true;
    }
    guidedMedian() {
        const vals = this.guided.samples.map((s) => s.rssi).sort((a, b) => a - b);
        return vals.length ? vals[Math.floor(vals.length / 2)] : 0;
    }
    guidedFrame(frame) {
        const g = this.guided;
        if (!g) return false;
        // Overlay gone but state left behind (should not happen since every close
        // path clears it, but a frame in flight must never crash procRemoteFrame).
        if (!get('divRfGuided')) {
            this.guided = null;
            return false;
        }
        const shade = g.shades[g.idx];
        // Frames from unrelated remotes are ignored but still consumed by the wizard.
        if ((shade.linkedRemotes || []).some((r) => r.remoteAddress === frame.address)) {
            g.samples.push({ address: frame.address, rssi: frame.rssi });
            get('divRfGuidedCount').textContent = g.samples.length;
            get('spanRfGuidedRssi').textContent = `${this.guidedMedian()} dBm`;
            if (g.samples.length >= 8) get('btnRfGuidedSave').disabled = false;
        }
        return true;
    }
    guidedSave() {
        const g = this.guided;
        if (!g) return;
        // Store against the address that actually produced the burst (a shade can
        // have several linked remotes; the user pressed one of them).
        const counts = {};
        for (const s of g.samples) counts[s.address] = (counts[s.address] || 0) + 1;
        const address = parseInt(Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0], 10);
        putJSON('/setGuidedRssi', { address, rssi: this.guidedMedian() }, (err) => {
            if (err) ui.serviceError(err);
            else this.guidedNext();
        });
    }
    guidedNext() {
        // The wizard may have been closed while /setGuidedRssi was in flight.
        const g = this.guided;
        if (!g) return;
        if (++g.idx >= g.shades.length) {
            this.guided = null;
            const div = get('divRfGuided');
            if (div) closeOverlay(div);
            ui.successMessage(tr('RFDIAG_GUIDED_DONE'));
            this.load();
        }
        else this.guidedShow();
    }
    load() {
        const fetchStats = () => getJSONBusy('/rfStats', (err, stats) => {
            if (err) ui.serviceError(err);
            else {
                this.loaded = true;
                this.setStats(stats);
            }
        });
        // The name column joins on the shades list; make sure it is available when the
        // user deep-links straight into this panel.
        if ((somfy.shades || []).length) fetchStats();
        else getJSON('/shades', (err, shades) => {
            if (!err && Array.isArray(shades)) somfy.shades = shades;
            fetchStats();
        });
    }
    reload() {
        // Silent refresh (no busy overlay) used by the socket-driven updates.
        getJSON('/rfStats', (err, stats) => { if (!err) this.setStats(stats); });
    }
    clearStats() {
        ui.promptMessage(get('divRFDiagnostics'), tr('RFDIAG_CLEAR_CONFIRM'), () => {
            putJSONBusy('/clearRfStats', {}, (err) => {
                if (err) ui.serviceError(err);
                else this.load();
            });
        });
    }
    // Ranked from the recent (EWMA) level: the remote->ESP path is the only thing RTS
    // lets us observe, so these are relative link-budget classes, not motor guarantees.
    quality(rssi) {
        if (rssi >= -65) return { cls: 'good', key: 'RFDIAG_QUALITY_GOOD' };
        if (rssi >= -80) return { cls: 'fair', key: 'RFDIAG_QUALITY_FAIR' };
        return { cls: 'weak', key: 'RFDIAG_QUALITY_WEAK' };
    }
    deviceNames(address) {
        const names = [];
        for (const shade of somfy.shades || []) {
            if (shade.remoteAddress === address) names.push(`ESPSomfy · ${shade.name}`);
            else if ((shade.linkedRemotes || []).some((r) => r.remoteAddress === address)) names.push(shade.name);
        }
        return names;
    }
    lastSeenText(epoch) {
        if (!epoch) return '--';
        const secs = Math.max(0, Math.floor(Date.now() / 1000) - epoch);
        if (secs < 60) return trf('RFDIAG_AGO_SECONDS', secs);
        if (secs < 3600) return trf('RFDIAG_AGO_MINUTES', Math.floor(secs / 60));
        if (secs < 86400) return trf('RFDIAG_AGO_HOURS', Math.floor(secs / 3600));
        return trf('RFDIAG_AGO_DAYS', Math.floor(secs / 86400));
    }
    epochText(e) {
        // Under an hour of data a frames/day extrapolation would be noise: show --.
        const perDay = e.seconds >= 3600 ? Math.round(e.frames * 86400 / e.seconds) : null;
        return trf('RFDIAG_EPOCH_LINE',
            e.frequency.toFixed(3),
            perDay !== null ? perDay : '--',
            e.floor || '--',
            e.noiseAvg ? e.noiseAvg.toFixed(1) : '--',
            e.start ? this.lastSeenText(e.start) : tr('RFDIAG_EPOCH_THISBOOT'));
    }
    setEpochs(stats) {
        const div = get('divRfDiagEpochs');
        const cur = stats.epoch || {};
        if (!cur.frequency) { div.style.display = 'none'; return; }
        div.style.display = '';
        get('divRfDiagEpochCur').textContent = this.epochText(cur);
        const prevDiv = get('divRfDiagEpochPrev');
        const prev = stats.epochPrev || {};
        if (prev.frequency) {
            prevDiv.style.display = '';
            prevDiv.textContent = `${tr('RFDIAG_EPOCH_PREV')} : ${this.epochText(prev)}`;
        }
        else prevDiv.style.display = 'none';
    }
    setStats(stats) {
        get('spanRfDiagFreq').textContent = typeof stats.frequency === 'number' ? `${stats.frequency.toFixed(3)} MHz` : '--';
        get('spanRfDiagRemotes').textContent = stats.remotes || 0;
        get('spanRfDiagFrames').textContent = stats.frames || 0;
        const noise = get('spanRfDiagNoise');
        if (stats.noiseSamples > 0) {
            noise.textContent = `${stats.noise.toFixed(1)} dBm`;
            noise.title = trf('RFDIAG_NOISE_BASELINE', stats.noiseBaseline.toFixed(1));
            // A floor sitting well above its long-term baseline means something is jamming.
            noise.classList.toggle('rfdiag-alert', stats.noiseSamples > 360 && stats.noise - stats.noiseBaseline >= 6);
        }
        else noise.textContent = '--';
        this.setEpochs(stats);
        // A guided measurement (taken at the shade's position) outranks the passive
        // EWMA, which only reflects wherever the remote is usually pressed from.
        const eff = (e) => e.guided || e.recent;
        const entries = (stats.entries || []).slice()
            .sort((a, b) => eff(a) - eff(b)); // hardest cases first: that is what the page is for
        get('divRfDiagEmpty').style.display = entries.length ? 'none' : '';
        get('divRfDiagTable').style.display = entries.length ? '' : 'none';
        const rows = get('divRfDiagRows');
        rows.innerHTML = '';
        for (const e of entries) {
            const q = this.quality(eff(e));
            const names = this.deviceNames(e.address);
            const name = names.length ? names.join(', ') : tr('RFDIAG_UNKNOWN_REMOTE');
            const detail = e.guided
                ? `${tr('RFDIAG_GUIDED_MEASURED')} - ${trf('RFDIAG_RSSI_DETAIL', e.avg.toFixed(1), e.min, e.max)}`
                : trf('RFDIAG_RSSI_DETAIL', e.avg.toFixed(1), e.min, e.max);
            const row = document.createElement('div');
            row.className = 'frame-row rfdiag-row';
            if (!names.length) row.classList.add('rfdiag-unknown');
            row.innerHTML = `<span><span class="rfdiag-name">${esc(name)}</span><span class="rfdiag-addr">${esc(e.address)}</span></span>`
                + `<span><span class="rfdiag-badge ${q.cls}">${esc(tr(q.key))}</span></span>`
                + `<span title="${esc(detail)}">${esc(Math.round(eff(e)))} dBm${e.guided ? ' \u{1F4CD}' : ''}</span>`
                + `<span>${esc(e.frames)}</span>`
                + `<span>${esc(this.lastSeenText(e.lastSeen))}</span>`;
            rows.appendChild(row);
        }
    }
}
var rfdiag = new RfDiag();
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

                    prompt.querySelector('.sub-message').innerHTML = `<p style="color:var(--status-warn); font-weight:bold;"><p>${tr('PROMPT_RESTORE_FILE_DESC')}</p><p><b>${tr('PROMPT_RESTORE_FILE_DESC_1')}</b></p><p>${tr('PROMPT_RESTORE_FILE_DESC_2')}</p>`;

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
        // The GitHub button is the single carrier of the update state: it reports
        // "up to date" (disabled) or "update available" (call to action) instead of
        // duplicating the information in a separate banner.
        const divsGlobal = document.querySelectorAll('.firmware-message');
        const btn = get('btnUpdateGithub');
        const ghTitle = get('ghUpdTitle');
        const ghDesc = get('ghUpdDesc');

        if (divsGlobal.length === 0) return;
        divsGlobal.forEach(div => {
            div.classList.remove('procFwStatusshow');
            div.onclick = null;
            setClickable(div, false);
        });
        if (btn) {
            btn.classList.remove('upd-ok', 'upd-available');
            btn.disabled = false;
            if (ghTitle) ghTitle.innerHTML = tr('FW_UPDATE_GIT');
            if (ghDesc) ghDesc.innerHTML = tr('FW_UPDATE_GIT_DESC');
        }
        if (rel.available && rel.status === 0 && rel.checkForUpdate !== false) {
            divsGlobal.forEach(div => {
                div.classList.add('procFwStatusshow');
                div.style.cursor = 'pointer';
                div.onclick = () => { firmware.updateGithub(); };
                div.innerHTML = `<span>${tr('FW_UPDATE_AVAILABLE')}</span>`;
                setClickable(div, true);
            });
            if (btn) {
                const isBlocked = this.needsUsbFlash();
                btn.classList.add('upd-available');
                btn.disabled = isBlocked;
                if (ghTitle) ghTitle.innerHTML = tr(isBlocked ? 'FW_UPDATE_REQUIRED_USB' : 'FW_UPDATE_AVAILABLE');
                if (ghDesc) ghDesc.innerHTML = (isBlocked
                    ? tr('FW_UPDATE_USB_DESC')
                    : tr('FW_UPDATE_ACTION_DESC2')).replace('%1', rel.latest.name);
            }
        }
        else if (rel.status === 4 && rel.error !== 0) {
            let e = errors.find(x => x.code === rel.error) || { desc: tr('ERR_UNSPECIFIED') };
            let inst = get('divGitInstall');
            if (inst) inst.remove();
            ui.errorMessage(e.desc);
        }
        else {
            // Up to date: same button, informative state; disabled so a tap cannot
            // launch a pointless reinstall.
            if (btn) {
                btn.classList.add('upd-ok');
                btn.disabled = true;
                if (ghTitle) ghTitle.innerHTML = tr('FW_UPDATE_UPTODATE');
                if (ghDesc) ghDesc.innerHTML = tr('FW_UPDATE_ACTION_DESC');
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
        else if (service === '/updateApplication' || service === '/updateFirmware') {
            // Validate by CONTENT, not filename: a locally built littlefs.bin is as
            // valid as the release-named artifact.  LittleFS carries its magic at
            // offset 8 of the superblock; an ESP32 app image starts with 0xE9.
            const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
            const isLfs = String.fromCharCode(...head.slice(8, 16)) === 'littlefs';
            if (service === '/updateApplication' && !isLfs) err = 'ERR_INVALID_FILE_LITTLEFS';
            else if (service === '/updateFirmware' && (head[0] !== 0xE9 || isLfs)) err = 'ERR_INVALID_FILE_FIRMWARE';
        }
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
