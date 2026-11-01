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
        this.bindShadeTabs();
        this.bindVirtualRemoteKeys();
        this.initialized = true;
    }
    // The virtual remote's keys are drawn as divs driven by mousedown/touchstart:
    // make them focusable buttons, held from the keyboard like a pointer, and name
    // the icon-only ones (the others carry a translated title).
    bindVirtualRemoteKeys() {
        const names = { stop: 'A11Y_VR_STOP', toggle: 'A11Y_VR_TOGGLE', up: 'A11Y_VR_UP', down: 'A11Y_VR_DOWN', my: 'A11Y_VR_MY', StepUp: 'A11Y_VR_STEP_UP', StepDown: 'A11Y_VR_STEP_DOWN' };
        get('divVirtualRemote').querySelectorAll('[data-cmd]').forEach(el => {
            el.setAttribute('role', 'button');
            el.tabIndex = 0;
            const key = names[el.getAttribute('data-cmd')];
            if (key) { el.setAttribute('tr-aria', key); translator.translate(el); }
            bindHoldKeys(el, () => this.sendVRCommand(el));
        });
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

        const cm = chipFamily();

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
        cm = chipFamily(),
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
                const radioTab = document.querySelector('.nav-item[data-grpid="pgRadio"]');
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
                // Both copies of the menu (rail and mobile) flag a radio that failed to start.
                document.querySelectorAll('.nav-item[data-grpid="pgRadio"]').forEach(n => n.classList.toggle('radio-error', !isRadioInit));
                if (row) row.classList.toggle('radioOn', !!isRadioInit);
                // Any trusted edit in the panel (sliders included) flips the status line
                // to the save-required hint: the sliders preview their new value
                // instantly and nothing else said the radio still runs the old one.
                // Stepper and precision-arrow clicks count too (see navIsStepperClick).
                // Property assignment so socket reconnects do not stack listeners.
                const panel = get('divTransceiverSettings');
                panel.oninput = panel.onchange = panel.onclick = (e) => {
                    if (e.type === 'click' ? navIsStepperClick(e) : e.isTrusted) txtStatus.textContent = tr('RADIO_SAVE_REQUIRED');
                };
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
    // Nudge a numeric field, through the same clamp typing goes through so the keyboard
    // and the buttons can never disagree. An emptied field reads as `dflt`, not as zero.
    stepField(id, delta, dflt) {
        const el = get(id);
        if (!el) return;
        el.value = (parseInt(el.value, 10) || 0) + delta;
        clampNumField(el, dflt);
    }
    clampRepeats(el) { return clampNumField(el, DEFAULT_REPEATS); }
    stepRepeats(id, direction) { this.stepField(id, direction, DEFAULT_REPEATS); }
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
                const pm = this.pinMaps.find(x => x.name === chipFamily()) || { maxPins: 39 };

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
                    navSaved();

                    const init = res.config.radioInit,
                            cb = get('cbEnableRadio');

                            document.querySelectorAll('.nav-item[data-grpid="pgRadio"]').forEach(n => n.classList.toggle('radio-error', !init));
                            get('divRadioEnableColor').classList.toggle('radioOn', !!init);
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
        { name: 'esp32', maxPins: 39, inputs: [0, 1, 6, 7, 8, 9, 10, 11, 37, 38], outputs: [3, 6, 7, 8, 9, 10, 11, 34, 35, 36, 37, 38, 39] },
        { name: 's2', maxPins: 46, inputs: [0, 19, 20, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 45], outputs: [0, 19, 20, 26, 27, 28, 29, 30, 31, 32, 45, 46]},
        { name: 's3', maxPins: 48, inputs: [19, 20, 22, 23, 24, 25, 27, 28, 29, 30, 31, 32], outputs: [19, 20, 22, 23, 24, 25, 27, 28, 29, 30, 31, 32] },
        { name: 'c3', maxPins: 21, inputs: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20], outputs: [11, 12, 13, 14, 15, 16, 17, 21] }
    ];
    loadPins(type, sel, opt) {
        if (!sel) return;
        let currentVal = (typeof opt !== 'undefined') ? opt : parseInt(sel.value, 10);
        while (sel.firstChild) sel.removeChild(sel.firstChild);

        const pm = this.pinMaps.find(x => x.name === chipFamily()) || this.pinMaps[0];

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
        // During the overlay's 1s closing window scanFrequency() returns undefined;
        // a late socket event must not dereference it.
        if (!div) return;
        let spanTestFreq = get('spanTestFreq');
        let spanTestRSSI = get('spanTestRSSI');
        let spanBestFreq = get('spanBestFreq');
        let spanBestRSSI = get('spanBestRSSI');

        if (spanBestFreq) {
            spanBestFreq.innerHTML = scan.RSSI !== -100 ? scan.frequency.toFixed(3) : '----';
        }
        if (spanBestRSSI) {
            spanBestRSSI.innerHTML = scan.RSSI !== -100 ? scan.RSSI : '----';
        }
        if (spanTestFreq) {
            spanTestFreq.innerHTML = scan.testFreq.toFixed(3);
        }
        if (spanTestRSSI) {
            spanTestRSSI.innerHTML = scan.testRSSI !== -100 ? scan.testRSSI : '----';

            if (this.rssiGraph) {
                this.rssiGraph.update(scan.testRSSI);
            }
        }
        // Scan v2 phases: 1 = coarse hunt, 2 = fine edge sweep, 3 = calibrated.
        const phaseDiv = get('divScanPhase');
        if (phaseDiv) {
            if (scan.phase === 2) phaseDiv.textContent = trf('SCANFREQ_PHASE_FINE', scan.progress);
            else if (scan.phase === 3) {
                phaseDiv.textContent = scan.fLow ? trf('SCANFREQ_PHASE_DONE', scan.fLow.toFixed(3), scan.fHigh.toFixed(3)) : tr('SCANFREQ_PHASE_DONE_NOEDGE');
                const btn = get('btnCopyFrequency');
                if (btn) btn.style.display = '';
            }
            else if (scan.scanning) {
                // A coarse pass that never decodes sweeps forever: after 30s tell the
                // user why instead of scanning silently.
                if (!this.scanCoarseSince) this.scanCoarseSince = Date.now();
                phaseDiv.textContent = Date.now() - this.scanCoarseSince > 30000
                    ? tr('SCANFREQ_PHASE_COARSE_LONG') : tr('SCANFREQ_PHASE_COARSE');
            }
            else phaseDiv.textContent = '';
            if (scan.phase !== 1 || !scan.scanning) this.scanCoarseSince = null;
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
            <div class="unibloc"><div>${tr("SCANFREQ_SCAN_DESC")}</div><div id="divScanPhase" class="uniStatus"></div></div>
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
                    ctx.font = "12px Roboto, sans-serif";
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
        const secGroups = getEl('secHomeGroups');
        if (secGroups) secGroups.style.display = (!isConfigOpen && visibleGroupsCount > 0) ? '' : 'none';
        this.updateHomeSummary();
    }
    procRoomAdded(room) {
        let r = _rooms.find(x => x.roomId === room.roomId);
        if (typeof r === 'undefined' || !r) {
            _rooms.push(room);
            // _rooms carries the "Home" entry (room 0); setRoomsList adds it back itself.
            this.setRoomsList(_rooms.filter(x => x.roomId !== 0));
            this.checkEmptyState();
        }
    }
    procRoomRemoved(room) {
        if (room.roomId === 0) return;
        let r = _rooms.find(x => x.roomId === room.roomId);
        if (typeof r !== 'undefined' && r.roomId === room.roomId) {
            this.setRoomsList(_rooms.filter(x => x.roomId !== room.roomId && x.roomId !== 0));
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
            pill.setAttribute('aria-pressed', pId === roomId ? 'true' : 'false');
        });
        const sel = get('divRoomSelector');
        if (sel) sel.setAttribute('data-roomid', roomId);
        const match = el => roomId === 0 || parseInt(el.getAttribute('data-roomid'), 10) === roomId;
        document.querySelectorAll('.somfyShadeCtl').forEach(x => { x.style.display = match(x) ? '' : 'none'; });
        document.querySelectorAll('.room-sec').forEach(x => { x.style.display = match(x) ? '' : 'none'; });
        document.querySelectorAll('.somfyGroupCtl').forEach(x => { x.style.display = match(x) ? '' : 'none'; });
        this.checkEmptyState();
    }
    setRoomsList(rooms) {
        let divCfg = '';
        const homeName = tr('HOME');
        const slider = get('divRoomSelector');
        // Room filter chips: real buttons carrying their pressed state; the visible
        // name is the accessible name (voice control users say what they see).
        let divPills = `<button type="button" class="chip room-pill active" aria-pressed="true" data-roomid="0" onclick="somfy.selectRoom(0)">${esc(tr('HOME_ALL_ROOMS'))}<span class="chip-count"></span></button>`;
        // Room 0 means "no room": say so in the room pickers.
        let divOpts = `<option value="0">${esc(tr('HOME_UNASSIGNED'))}</option>`;
        _rooms = [{ roomId: 0, name: homeName }];

        rooms.sort((a, b) => a.sortOrder - b.sortOrder);
        rooms.forEach(room => {
            divPills += `<button type="button" class="chip room-pill" aria-pressed="false" data-roomid="${room.roomId}" onclick="somfy.selectRoom(${room.roomId})">${esc(room.name)}<span class="chip-count"></span></button>`;
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
        const navContainer = document.querySelector('.room-nav-container');
        if (navContainer) navContainer.style.display = rooms.length === 0 ? 'none' : '';

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
        // Shades are grouped by room: re-render them in the new room order.
        if (this.shades) this.setShadesList(this.shades);
    }
    // The room chips wrap instead of scrolling sideways, so the old drag/wheel
    // scrolling (which captured the page's vertical wheel) is gone.
    initRoomScroll() { this.checkArrows = () => {}; }
    scrollRooms() {}
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
        shades.sort((a, b) => { return a.sortOrder - b.sortOrder });
        if(DBG) console.log(shades);
        let roomId = document.querySelector('.room-pill.active') ? parseInt(document.querySelector('.room-pill.active').getAttribute('data-roomid'), 10) : 0;
        let vrList = get('selVRMotor');
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
        // Home: one section per room (in room order), "unassigned" last.
        const byRoom = new Map();
        for (const shade of shades) {
            const known = _rooms.some(r => r.roomId === shade.roomId && r.roomId !== 0);
            const rId = known ? shade.roomId : 0;
            if (!byRoom.has(rId)) byRoom.set(rId, []);
            byRoom.get(rId).push(shade);
        }
        const roomOrder = _rooms.filter(r => r.roomId !== 0).map(r => r.roomId).concat([0]);
        let divCtl = '';
        for (const rId of roomOrder) {
            const list = byRoom.get(rId);
            if (!list || !list.length) continue;
            const room = _rooms.find(x => x.roomId === rId);
            const rName = rId === 0 ? tr('HOME_UNASSIGNED') : room.name;
            divCtl += `<section class="room-sec" data-roomid="${rId}" aria-labelledby="roomHead${rId}" style="--n:${Math.min(list.length, 4)};${roomId === 0 || roomId === rId ? '' : 'display:none'}">
            <div class="room-sec-head">
            <h2 class="h2-lg" id="roomHead${rId}">${esc(rName)}${list.length > 1 ? ' <span class="room-sec-sum muted"></span>' : ''}</h2>
            ${list.filter(x => this.isCoveringType(x.shadeType)).length > 1 ? `<div class="room-sec-actions">
            <button type="button" class="btn btn-ghost btn-sm" onclick="somfy.roomCommand(${rId}, 'up')">${tr('HOME_OPEN_ALL')}<span class="sr-only">, ${esc(rName)}</span></button>
            <button type="button" class="btn btn-ghost btn-sm" onclick="somfy.roomCommand(${rId}, 'down')">${tr('HOME_CLOSE_ALL')}<span class="sr-only">, ${esc(rName)}</span></button>
            </div>` : ''}
            </div>
            <div class="tile-grid">`;
            for (const shade of list) divCtl += this.tileHtml(shade, roomId);
            divCtl += `</div></section>`;
        }
        for (let i = 0; i < shades.length; i++) {
            let shade = shades[i];
            let room = _rooms.find(x => x.roomId === shade.roomId) || { roomId: 0, name: '' };
            divCfg += `<div class="somfyShade shade-draggable" draggable="true" data-roomid="${shade.roomId}" data-mypos="${shade.myPos}" data-shadeid="${shade.shadeId}" data-remoteaddress="${shade.remoteAddress}" data-tilt="${shade.tiltType}" data-shadetype="${shade.shadeType}" data-flipposition="${shade.flipPosition ? 'true' : 'false'}"><div class="drag-handle"><svg class="icon-svg"><use href=#svg-drag></use></svg></div><div class="shade-name"><div class="cfg-room">${esc(room.name)}</div><div class="name-text">${esc(shade.name)}</div></div><div class="idRemoteAddress"><span class="AddrId-label">${tr("ID")}</span><span class="shade-address">${shade.remoteAddress}</span></div><span class="vr"></span><div class="divEditDelete-svg" ${a11yBtn(trf('A11Y_EDIT', shade.name))} onclick="somfy.openEditShade(${shade.shadeId});"><svg class="icon-svg"><use href=#svg-edit></use></svg></div><div class="divEditDelete-svg" ${a11yBtn(trf('A11Y_DELETE', shade.name))} onclick="somfy.deleteShade(${shade.shadeId});"><svg class="icon-svg"><use href=#svg-close></use></svg></div></div>`;
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
        shadeControls.querySelectorAll('.somfyShadeCtl').forEach(d => this.renderTileState(d));
        this.checkEmptyState();
        // Long-press handling for the shade command buttons.  Mouse and touch share
        // the same handlers so the two input methods behave identically: a tap sends
        // the command, holding 2s triggers the secondary action (set My / tilt).
        // While armed, an accent ring grows on the button (.lp-hold) so the user can
        // see that keeping it pressed does something.
        let btns = shadeControls.querySelectorAll('.cmd-button');
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
            let elShade = event.currentTarget.closest('.somfyShadeCtl');
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
            let items = list.querySelectorAll('.shade-draggable');
            let order = [];
            for (let i = 0; i < items.length; i++) order.push(parseInt(items[i].getAttribute('data-shadeid'), 10));
            // Home groups the shades by room, so it is rebuilt from the new order.
            putJSONBusy('/shadeSortOrder', order, () => this.updateShadeList());
        });
    }
    // Shade types whose motor has no travel position (a pulse or a toggle).
    isPulseType(shadeType) { return [5, 9, 10, 14, 15, 16].includes(parseInt(shadeType, 10)); }
    // Window coverings: "open/close all" must never move a garage door or a gate.
    isCoveringType(shadeType) { return [0, 1, 2, 3, 4, 7, 8].includes(parseInt(shadeType, 10)); }
    // Types drawn as a slatted apron in the tile; the others keep their own icon.
    isApronType(shadeType) { return [0, 1, 4].includes(parseInt(shadeType, 10)); }
    tileHtml(shade, roomId) {
        const st = this.shadeTypes.find(x => x.type === shade.shadeType) || { type: shade.shadeType, ico: 'svg-window-shade' };
        const isLightOn = (shade.flags & 0x08);
        const isSunOn = (shade.flags & 0x01);
        const pulse = this.isPulseType(shade.shadeType);
        const p = shade.flipPosition ? 100 - shade.position : shade.position;
        const viz = this.isApronType(shade.shadeType)
            ? `<span class="shutter"></span>`
            : `<svg class="somfy-shade-icon" data-shadeid="${shade.shadeId}" aria-hidden="true" style="--shade-position:${p}; --fpos:${p}%"><use href="#${st.ico}"></use></svg>`;
        const tiltTitle = shade.tiltType !== 0 ? ` title="${tr('TT_HOLD_TILT')}"` : '';
        return `<article class="somfyShadeCtl tile${pulse ? ' is-pulse' : ''}" style="${roomId === 0 || roomId === shade.roomId ? '' : 'display:none'}" aria-labelledby="shName${shade.shadeId}" data-shadeid="${shade.shadeId}" data-roomid="${shade.roomId}" data-direction="${shade.direction}" data-remoteaddress="${shade.remoteAddress}" data-position="${shade.position}" data-target="${shade.target}" data-mypos="${shade.myPos}" data-mytiltpos="${shade.myTiltPos}" data-shadetype="${shade.shadeType}" data-tilt="${shade.tiltType}" data-tiltposition="${shade.tiltPosition}" data-flipposition="${shade.flipPosition ? 'true' : 'false'}" data-windy="${(shade.flags & 0x10) === 0x10 ? 'true' : 'false'}" data-sunny="${(shade.flags & 0x20) === 0x20 ? 'true' : 'false'}">
        <div class="tile-head">
        <div class="tile-id">
        <h3 class="tile-name shadectl-name" id="shName${shade.shadeId}">${esc(shade.name).replace(/_/g, '_<wbr>')}</h3>
        <span class="status tile-status"><span class="dot pulse" aria-hidden="true"></span><span class="val-pos"></span></span>
        </div>
        <span class="tile-pct"><span class="pct-num"></span><small aria-hidden="true"> %</small><span class="sr-only"> ${tr('HOME_PCT_OPEN')}</span></span>
        </div>
        <button type="button" class="viz shade-viz" data-shadeid="${shade.shadeId}" aria-label="${esc(trf('A11Y_SET_POS', shade.name))}" ${pulse ? 'disabled' : ''} onclick="event.stopPropagation(); somfy.openSetPosition(${shade.shadeId});">
        ${viz}
        <span class="viz-flags"><span class="badge warn indicator indicator-sun"><svg aria-hidden="true"><use href="#indic-sun"></use></svg>${tr('VR_SUN')}</span><span class="badge danger indicator indicator-wind"><svg aria-hidden="true"><use href="#indic-wind"></use></svg>${tr('VR_WIND')}</span></span>
        </button>
        <span class="tile-tools">
        <div class="button-light cmd-button" ${a11yBtn(trf('A11Y_CMD_LIGHT', shade.name))} data-cmd="light" data-shadeid="${shade.shadeId}" data-on="${isLightOn ? 'true' : 'false'}" style="${!shade.light ? 'display:none' : ''}"><svg aria-hidden="true"><use href="#svg-lightbulb"></use></svg></div>
        ${shade.sunSensor ? `<div class="button-sunflag cmd-button" ${a11yBtn(trf('A11Y_CMD_SUN', shade.name))} data-cmd="sunflag" data-shadeid="${shade.shadeId}" data-on="${isSunOn ? 'true' : 'false'}"><svg aria-hidden="true"><use href="#svg-sun"></use></svg></div>` : ''}
        ${pulse ? '' : `<div class="button-my" ${a11yBtn(trf('A11Y_SET_MY', shade.name))} title="${tr('TT_HOLD_MY')}" onclick="event.stopPropagation(); somfy.openSetMyPosition(${shade.shadeId});"><svg aria-hidden="true"><use href="#svg-favori"></use></svg></div>`}
        </span>
        <div class="cmd-row shadectl-buttons" data-shadeType="${shade.shadeType}">
        <div class="btn button-outline cmd-button" ${a11yBtn(trf('A11Y_CMD_UP', shade.name))} data-cmd="up" data-shadeid="${shade.shadeId}"${tiltTitle}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></svg></div>
        <div class="btn btn-stack button-outline cmd-button cmd-my" role="button" tabindex="0" data-cmd="my" data-shadeid="${shade.shadeId}" title="${tr('TT_HOLD_MY')}"><span class="my-label">My</span><span class="btn-sub val-my"></span><span class="sr-only">${esc(trf('A11Y_CMD_MY', shade.name))}</span></div>
        <div class="btn button-outline cmd-button" ${a11yBtn(trf('A11Y_CMD_DOWN', shade.name))} data-cmd="down" data-shadeid="${shade.shadeId}"${tiltTitle}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></div>
        <div class="btn button-outline cmd-button cmd-toggle" role="button" tabindex="0" data-cmd="toggle" data-shadeid="${shade.shadeId}">${tr('BT_TRIGGER')}<span class="sr-only"> ${esc(shade.name)}</span></div>
        </div>
        <div class="tile-foot">
        <span class="val-tilt small muted"></span>
        </div>
        </article>`;
    }
    // Paints the live state of one tile from its data-* attributes (kept current by
    // procShadeState): open percentage, apron height, status line, My / Stop label.
    renderTileState(d) {
        const flip = makeBool(d.getAttribute('data-flipposition'));
        const num = (a, dflt) => { const v = parseInt(d.getAttribute(a), 10); return isNaN(v) ? dflt : v; };
        const pos = num('data-position', 0), target = num('data-target', pos), myPos = num('data-mypos', -1);
        const dir = num('data-direction', 0);
        const open = shadeOpenness(pos, flip);
        const pulse = d.classList.contains('is-pulse');
        const moving = dir !== 0;
        d.classList.toggle('is-moving', moving);
        const pct = d.querySelector('.pct-num');
        if (pct) pct.textContent = open;
        d.querySelector('.tile-pct')?.toggleAttribute('hidden', pulse);
        const sh = d.querySelector('.shutter');
        if (sh) sh.style.height = (100 - open) + '%';
        const myOpen = myPos >= 0 ? shadeOpenness(myPos, flip) : -1;
        let status;
        if (moving) status = `${tr(dir < 0 ? 'ST_OPENING' : 'ST_CLOSING')} · ${trf('ST_TOWARDS', shadeOpenness(target, flip))}`;
        else if (pulse) status = '';
        else if (myOpen >= 0 && open === myOpen && open !== 0 && open !== 100) status = tr('ST_AT_MY');
        else status = open <= 0 ? tr('POS_CLOSED') : open >= 100 ? tr('POS_OPEN') : tr('ST_PARTIAL');
        const s = d.querySelector('.val-pos');
        if (s) s.textContent = status;
        const lbl = d.querySelector('.my-label');
        if (lbl) lbl.textContent = moving ? tr('BT_STOP_MY') : 'My';
        const vm = d.querySelector('.val-my');
        if (vm) vm.textContent = moving ? '' : (myOpen >= 0 ? `${myOpen} %` : '—');
        const tilt = parseInt(d.getAttribute('data-tilt'), 10) || 0;
        const vt = d.querySelector('.val-tilt');
        if (vt) {
            const tp = num('data-tiltposition', -1), mt = num('data-mytiltpos', -1);
            vt.textContent = tilt ? `${tr('SHADE_TILT')}${tp >= 0 ? tp + ' %' : '—'}${mt >= 0 ? ` · ${tr('SHADE_MY_TILT')}${mt} %` : ''}` : '';
        }
    }
    // "3 volets · 2 ouverts" under the Home title and next to each room heading.
    updateHomeSummary() {
        const describe = (tiles) => {
            const shades = tiles.filter(t => !t.classList.contains('is-pulse'));
            const open = shades.filter(t => shadeOpenness(parseInt(t.getAttribute('data-position'), 10) || 0, makeBool(t.getAttribute('data-flipposition'))) > 0).length;
            return { total: tiles.length, open: open, shades: shades.length };
        };
        const all = describe(Array.from(document.querySelectorAll('#divShadeControls .somfyShadeCtl')));
        const sum = get('homeSummary');
        if (sum) sum.textContent = all.total ? `${trf(all.total === 1 ? 'HOME_DEVICES_1' : 'HOME_DEVICES_N', all.total)} · ${this.openText(all.open, all.shades)}` : '';
        document.querySelectorAll('.room-sec').forEach(sec => {
            const d = describe(Array.from(sec.querySelectorAll('.somfyShadeCtl')));
            const el = sec.querySelector('.room-sec-sum');
            if (el) el.textContent = `· ${this.openText(d.open, d.shades)}`;
        });
        document.querySelectorAll('.room-pill').forEach(p => {
            const rId = parseInt(p.getAttribute('data-roomid'), 10);
            const n = rId === 0 ? all.total : document.querySelectorAll(`#divShadeControls .somfyShadeCtl[data-roomid="${rId}"]`).length;
            const c = p.querySelector('.chip-count');
            if (c) c.textContent = n ? ` ${n}` : '';
        });
    }
    openText(open, total) {
        if (open === 0) return tr('HOME_ALL_CLOSED');
        if (open === total) return tr('HOME_ALL_OPEN');
        return open === 1 ? tr('HOME_ONE_OPEN') : trf('HOME_N_OPEN', open);
    }
    // "Open all / Close all" of a room: one command per window covering of the section;
    // the radio task queues them, so they go out as a burst of contiguous trains.
    roomCommand(roomId, cmd) {
        const tiles = Array.from(document.querySelectorAll(`.room-sec[data-roomid="${roomId}"] .somfyShadeCtl`))
            .filter(t => this.isCoveringType(t.getAttribute('data-shadetype')));
        tiles.forEach(t => this.sendCommand(parseInt(t.getAttribute('data-shadeid'), 10), cmd));
        const room = _rooms.find(r => r.roomId === roomId);
        this.announce(trf(cmd === 'up' ? 'LIVE_ROOM_OPEN' : 'LIVE_ROOM_CLOSE', room && roomId !== 0 ? room.name : tr('HOME_UNASSIGNED')));
    }
    announce(msg) {
        const el = get('homeLive');
        if (!el) return;
        el.textContent = '';
        setTimeout(() => { el.textContent = msg; }, 50);
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
        // Arrow presses are discrete moves, so each one would post the whole order. Coalesce
        // a held key into a single write once the user stops moving the row.
        let kbTimer = null;
        const persist = () => {
            if (kbTimer) clearTimeout(kbTimer);
            kbTimer = setTimeout(() => { kbTimer = null; if (typeof cb === 'function') cb(list); }, 400);
        };
        list.querySelectorAll(cl).forEach(it => {
            let h = it.querySelector('.drag-handle');
            if (h) {
                h.addEventListener('touchstart', (e) => start(e, it), { passive: true });
                h.addEventListener('mousedown', (e) => start(e, it));
                // The pointer drag had no keyboard equivalent, which left the order of the
                // list unreachable without a mouse or a touchscreen. The handle becomes a
                // real button and the arrows move the row through the same callback the
                // drop uses, so both paths persist identically.
                h.setAttribute('role', 'button');
                h.setAttribute('tabindex', '0');
                h.setAttribute('aria-label', tr('A11Y_REORDER'));
                h.addEventListener('keydown', (e) => {
                    const up = e.key === 'ArrowUp', down = e.key === 'ArrowDown';
                    if (!up && !down) return;
                    e.preventDefault();
                    const items = Array.prototype.slice.call(list.querySelectorAll(cl));
                    const i = items.indexOf(it), j = up ? i - 1 : i + 1;
                    if (i < 0 || j < 0 || j >= items.length) return;
                    if (up) list.insertBefore(it, items[j]);
                    else list.insertBefore(items[j], it);
                    h.focus();
                    persist();
                });
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
                divCfg += `<div class="somfyGroup group-draggable" draggable="true" data-roomid="${group.roomId}" data-groupid="${group.groupId}" data-remoteaddress="${group.remoteAddress}"><div class="drag-handle"><svg class="icon-svg"><use href=#svg-drag></use></svg></div> <div class="group-name"><div class="cfg-room">${esc(room.name)}</div><div class="name-text">${esc(group.name)}</div></div><div class="idRemoteAddress"><span class="AddrId-label">${tr("ID")}</span><span class="group-address">${group.remoteAddress}</span></div><span class="vr"></span><div class="divEditDelete-svg" ${a11yBtn(trf('A11Y_EDIT', group.name))} onclick="somfy.openEditGroup(${group.groupId});"><svg class="icon-svg"><use href=#svg-edit></use></svg></div><div class="divEditDelete-svg" ${a11yBtn(trf('A11Y_DELETE', group.name))} onclick="somfy.deleteGroup(${group.groupId});"><svg class="icon-svg" style="color: var(--danger-color, red);"><use href=#svg-close></use></svg></div></div>`;
                const members = typeof group.linkedShades !== 'undefined' ? group.linkedShades.length : 0;
                divCtl += `<div class="somfyGroupCtl gtile" style="${roomId === 0 || roomId === room.roomId ? '' : 'display:none'}" data-groupId="${group.groupId}" data-roomid="${group.roomId}" data-remoteaddress="${group.remoteAddress}">
                <div class="gtile-text">
                <span class="gtile-name groupctl-name">${esc(group.name)}</span>
                <span class="small muted">${room.roomId ? esc(room.name) + ' · ' : ''}${trf(members === 1 ? 'GROUP_MEMBERS_1' : 'GROUP_MEMBERS_N', members)}</span>
                </div>
                <div class="gtile-buttons groupctl-buttons">
                <div class="button-sunflag cmd-button" ${a11yBtn(trf('A11Y_CMD_SUN', group.name))} data-cmd="sunflag" data-groupid="${group.groupId}" data-on="${(group.flags & 0x01) ? 'true' : 'false'}" style="${!group.sunSensor ? 'display:none' : ''}"><svg aria-hidden="true"><use href="#svg-sun"></use></svg></div>
                <div class="btn btn-icon cmd-button" ${a11yBtn(trf('A11Y_CMD_UP', group.name))} data-cmd="up" data-groupid="${group.groupId}"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></svg></div>
                <div class="btn cmd-button" role="button" tabindex="0" data-cmd="my" data-groupid="${group.groupId}">My<span class="sr-only">${esc(trf('A11Y_CMD_MY', group.name))}</span></div>
                <div class="btn btn-icon cmd-button" ${a11yBtn(trf('A11Y_CMD_DOWN', group.name))} data-cmd="down" data-groupid="${group.groupId}"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></div>
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
        let btns = groupControls.querySelectorAll('.cmd-button');
        for (let i = 0; i < btns.length; i++) {
            btns[i].addEventListener('click', (event) => {
                let groupId = parseInt(event.currentTarget.getAttribute('data-groupid'), 10);
                let cmd = event.currentTarget.getAttribute('data-cmd');
                const g = (this.groups || []).find(x => x.groupId === groupId);
                if (cmd === 'sunflag') {
                    if (makeBool(event.currentTarget.getAttribute('data-on')))
                        this.sendGroupCommand(groupId, 'flag');
                    else
                        this.sendGroupCommand(groupId, 'sunflag');
                }
                else {
                    this.sendGroupCommand(groupId, cmd);
                    if (g) this.announce(trf('LIVE_CMD_SENT', g.name));
                }
            }, true);
        }
        this.setListDraggable(get('divGroupList'), '.group-draggable', (list) => {
            let items = list.querySelectorAll('.group-draggable');
            let order = [];
            for (let i = 0; i < items.length; i++) order.push(parseInt(items[i].getAttribute('data-groupid'), 10));
            putJSONBusy('/groupSortOrder', order, () => this.updateGroupList());
        });
    }
    // --- Position panel ---------------------------------------------------------
    // One panel for both things the tile leads to: moving the shade (tap on the apron)
    // and recording its My position (star button, or My held 2 s). It replaces two
    // sliders as wide as the tile, about 1.3 px per % on a phone, with a tall apron to
    // pull, presets and 1 % steps. Values read as % open, like the tile; the API keeps
    // its own orientation and shadeOpenness, its own inverse, converts both ways.
    // Tilt-only shades drive their tilt with the apron, in the API's own scale.
    closeShadePositioners() { this.closePosPanel(); }
    openSetPosition(shadeId) { this.openPosPanel(shadeId, 'move'); }
    openSetMyPosition(shadeId) { this.openPosPanel(shadeId, 'my'); }
    posShade(shadeId) {
        const d = document.querySelector(`.somfyShadeCtl[data-shadeid="${shadeId}"]`);
        if (!d) return null;
        const num = (a, dflt) => { const v = parseInt(d.getAttribute(a), 10); return isNaN(v) ? dflt : v; };
        const flip = makeBool(d.getAttribute('data-flipposition'));
        const tiltType = num('data-tilt', 0);
        const pos = num('data-position', 0), tilt = num('data-tiltposition', 0), myPos = num('data-mypos', -1);
        const s = {
            d, flip, tiltType,
            tiltOnly: tiltType === 3,
            name: d.querySelector('.tile-name')?.textContent || '',
            status: d.querySelector('.val-pos')?.textContent || '',
            moving: num('data-direction', 0) !== 0 || num('data-tiltdirection', 0) !== 0,
            tilt: tilt,
            myTilt: num('data-mytiltpos', -1)
        };
        // The main axis: the travel, or the tilt of a tilt-only shade.
        if (s.tiltOnly) Object.assign(s, { cur: tilt, target: num('data-tilttarget', tilt), my: s.myTilt });
        else Object.assign(s, {
            cur: shadeOpenness(pos, flip),
            target: shadeOpenness(num('data-target', pos), flip),
            my: myPos >= 0 ? shadeOpenness(myPos, flip) : -1
        });
        return s;
    }
    openPosPanel(shadeId, tab) {
        if (typeof shadeId === 'undefined') return;
        const s = this.posShade(shadeId);
        if (!s || this.isPulseType(s.d.getAttribute('data-shadetype'))) return;
        this.closePosPanel();
        const hasTilt = !s.tiltOnly && s.tiltType > 0;
        const el = document.createElement('div');
        el.className = 'pos-scrim';
        el.setAttribute('data-shadeid', shadeId);
        // data-nodirty: the panel drives the shade live, nothing in it is a setting to save.
        // The two modes are a segmented control (aria-pressed), not tabs: the body below
        // is the same slider either way, only what happens on release changes.
        el.setAttribute('data-nodirty', '');
        el.innerHTML = `
        <div class="pos-sheet" tabindex="-1">
        <div class="pos-grabber" aria-hidden="true"></div>
        <div class="pos-head">
        <div class="pos-head-text"><h2 class="pos-title">${esc(s.name)}</h2><span class="pos-state" aria-live="polite"></span></div>
        <button type="button" class="pos-close" aria-label="${esc(tr('BT_CLOSE'))}"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
        </div>
        <div class="pos-tabs" role="group">
        <button type="button" class="pos-tab" data-tab="move">${esc(tr('POSP_GO_TO'))}</button>
        <button type="button" class="pos-tab" data-tab="my"><svg aria-hidden="true"><use href="#svg-favori"></use></svg>${esc(tr('POSP_MY_TAB'))}</button>
        </div>
        <div class="pos-body">
        <div class="pos-apron-wrap">
        <div class="pos-apron" role="slider" tabindex="0" aria-orientation="vertical" aria-valuemin="0" aria-valuemax="100" aria-label="${esc(trf(s.tiltOnly ? 'POSP_SLIDER_TILT' : 'POSP_SLIDER', s.name))}">
        <span class="shutter"></span>
        <span class="pos-now"><span></span></span>
        <span class="pos-grip"></span>
        <span class="pos-pin" aria-hidden="true"><svg><use href="#svg-favori"></use></svg>My</span>
        </div>
        </div>
        <div class="pos-side">
        <div class="pos-readout"><span class="pos-big"><span class="pos-val"></span><small> %</small></span><span class="pos-what">${esc(tr(s.tiltOnly ? 'POSP_TILT' : 'POSP_OPEN_PCT'))}</span></div>
        <div class="pos-chips"></div>
        <div class="pos-steps" role="group" aria-label="${esc(tr('POSP_STEPS'))}">
        <button type="button" class="pos-step" data-step="-5">−5</button>
        <button type="button" class="pos-step" data-step="-1">−1</button>
        <button type="button" class="pos-step" data-step="1">+1</button>
        <button type="button" class="pos-step" data-step="5">+5</button>
        </div>
        <p class="pos-note"></p>
        </div>
        </div>
        ${hasTilt ? `
        <div class="pos-tilt">
        <div class="pos-tilt-head"><span>${esc(tr('POSP_TILT'))}</span><span><b class="pos-tilt-val"></b> %</span></div>
        <div class="pos-tilt-ctl">
        <button type="button" class="pos-step" data-tstep="-1" aria-label="${esc(tr('POSP_TILT_MINUS'))}">−1</button>
        <input type="range" class="pos-tilt-range" min="0" max="100" step="1" aria-label="${esc(tr('POSP_TILT'))}">
        <button type="button" class="pos-step" data-tstep="1" aria-label="${esc(tr('POSP_TILT_PLUS'))}">+1</button>
        </div>
        </div>` : ''}
        <div class="pos-mybox"><p class="pos-mytext"></p><button type="button" class="pos-mybtn"></button><button type="button" class="pos-myclear">${esc(tr('POSP_CLEAR_MY'))}</button></div>
        </div>`;
        document.body.appendChild(el);
        const p = this.pos = { shadeId, el, tab: 'move', sel: 0, tilt: 0, sendT: null, tiltT: null, dragging: false };
        const q = (c) => el.querySelector(c);
        const apron = q('.pos-apron');

        // Close on a tap on the backdrop only: a drag that started inside the sheet and
        // ends over the backdrop also lands its click there.
        let downOnScrim = false;
        el.addEventListener('pointerdown', (e) => { downOnScrim = e.target === el; });
        el.addEventListener('click', (e) => { e.stopPropagation(); if (e.target === el && downOnScrim) this.closePosPanel(); });
        el.addEventListener('keydown', (e) => { if (e.key === 'Escape' || e.key === 'Esc') { e.preventDefault(); this.closePosPanel(); } });
        q('.pos-close').addEventListener('click', () => this.closePosPanel());
        el.querySelectorAll('.pos-tab').forEach(b => b.addEventListener('click', () => this.setPosTab(b.dataset.tab)));
        q('.pos-chips').addEventListener('click', (e) => {
            const b = e.target.closest('.pos-chip[data-val]');
            if (b && !b.disabled) this.setPosSel(parseInt(b.dataset.val, 10), 'now');
        });
        el.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => this.setPosSel(p.sel + parseInt(b.dataset.step, 10), 'later')));

        // The apron is tall enough for an absolute mapping: where the finger is, the
        // bottom of the apron goes. The order leaves on release only.
        const fromY = (e) => { const r = apron.getBoundingClientRect(); return 100 - Math.max(0, Math.min(100, (e.clientY - r.top) / r.height * 100)); };
        apron.addEventListener('pointerdown', (e) => {
            if (e.button > 0) return;
            p.dragging = true;
            try { apron.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
            this.setPosSel(fromY(e));
        });
        apron.addEventListener('pointermove', (e) => { if (p.dragging) this.setPosSel(fromY(e)); });
        apron.addEventListener('pointerup', () => { if (!p.dragging) return; p.dragging = false; if (p.tab === 'move') this.setPosSel(p.sel, 'now'); });
        // A cancelled drag sends nothing: put the selection back on the shade.
        apron.addEventListener('pointercancel', () => {
            p.dragging = false;
            const cur = this.posShade(shadeId);
            if (cur && p.tab === 'move') this.setPosSel(cur.moving ? cur.target : cur.cur);
        });
        apron.addEventListener('keydown', (e) => {
            const k = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 }[e.key];
            if (k) this.setPosSel(p.sel + k, 'later');
            else if (e.key === 'Home') this.setPosSel(0, 'later');
            else if (e.key === 'End') this.setPosSel(100, 'later');
            else return;
            e.preventDefault();
        });

        if (hasTilt) {
            const range = q('.pos-tilt-range');
            const setTilt = (v, how) => {
                p.tilt = Math.max(0, Math.min(100, v));
                range.value = p.tilt;
                q('.pos-tilt-val').textContent = p.tilt;
                if (p.tab !== 'move') { this.renderPosPanel(); return; }
                clearTimeout(p.tiltT); p.tiltT = null;
                if (how === 'now') this.sendTiltCommand(shadeId, p.tilt);
                else if (how === 'later') p.tiltT = setTimeout(() => { p.tiltT = null; this.sendTiltCommand(shadeId, p.tilt); }, 600);
            };
            // A pointer release sends at once; arrow keys fire "change" on every press,
            // so they are batched like the steps.
            let rangePtr = false;
            range.addEventListener('pointerdown', () => { rangePtr = true; });
            range.addEventListener('input', () => setTilt(parseInt(range.value, 10)));
            range.addEventListener('change', () => { setTilt(parseInt(range.value, 10), rangePtr ? 'now' : 'later'); rangePtr = false; });
            el.querySelectorAll('[data-tstep]').forEach(b => b.addEventListener('click', () => setTilt(p.tilt + parseInt(b.dataset.tstep, 10), 'later')));
        }

        q('.pos-mybtn').addEventListener('click', () => {
            const cur = this.posShade(shadeId);
            if (!cur || cur.moving) return;
            const pos = cur.tiltOnly ? 0 : shadeOpenness(p.sel, cur.flip);
            const tilt = cur.tiltOnly ? p.sel : (cur.tiltType > 0 ? p.tilt : 0);
            this.closePosPanel();
            this.sendShadeMyPosition(shadeId, pos, tilt);
        });
        // Clearing My is its own, confirmed action: the motor forgets its favourite
        // position, which no remote can undo. The firmware clears My when asked to
        // record the current My, after moving the shade there if it is elsewhere.
        q('.pos-myclear').addEventListener('click', () => {
            const cur = this.posShade(shadeId);
            if (!cur || cur.moving || cur.my < 0) return;
            const msg = tr('POSP_MY_CLEAR') + (cur.cur !== cur.my ? ' ' + trf('POSP_MY_CLEAR_GO', cur.my) : '');
            // In <body>, after the panel, so the question stacks above it.
            ui.promptMessage(document.body, esc(msg), () => {
                this.closePosPanel();
                if (cur.tiltOnly) this.sendShadeMyPosition(shadeId, 0, cur.my);
                else this.sendShadeMyPosition(shadeId, shadeOpenness(cur.my, cur.flip), cur.tiltType > 0 ? cur.myTilt : 0);
            });
        });

        openDialog(el);
        // The panel owns one history entry, so Back (the Android gesture above all)
        // closes it instead of leaving the page underneath.
        history.pushState({ posPanel: true }, '');
        this.setPosTab(tab);
        apron.focus();
    }
    // fromHistory: the entry was already popped (Back) or is left behind on purpose
    // (a page change); otherwise the panel's own history entry is taken back.
    closePosPanel(fromHistory) {
        const p = this.pos;
        if (!p) return;
        this.flushPosSend();
        this.pos = null;
        closeOverlay(p.el);
        if (!fromHistory && history.state && history.state.posPanel) navHistoryBack();
    }
    setPosTab(tab) {
        const p = this.pos, s = p && this.posShade(p.shadeId);
        if (!s) return;
        // A step still waiting belongs to "go to": send it before leaving that mode,
        // so nothing leaves later from the My mode, where nothing should move.
        this.flushPosSend();
        p.tab = tab;
        p.el.querySelectorAll('.pos-tab').forEach(b => b.setAttribute('aria-pressed', b.dataset.tab === tab ? 'true' : 'false'));
        // Both modes start from where the shade is (or is heading): opening on the
        // stored My would turn the main button into "clear My".
        const here = s.moving ? s.target : s.cur;
        p.sel = here;
        p.tilt = s.tilt;
        // Presets: the list set in Preferences, then My, or the current position when recording My.
        // Rebuilt per tab only, so keyboard focus survives the live updates.
        const ends = s.tiltOnly ? ['0', '100'] : [tr('POS_CLOSED'), tr('POS_OPEN')];
        const chip = (label, val, aria) => `<button type="button" class="pos-chip" data-val="${val}"${aria ? ` aria-label="${esc(aria)}"` : ''}>${label}</button>`;
        const presets = (typeof general !== 'undefined' && general.posPresets) || [0, 25, 50, 75, 100];
        let html = presets.map(v => chip(v === 0 ? esc(ends[0]) : v === 100 ? esc(ends[1]) : String(v), v)).join('');
        const star = '<svg aria-hidden="true"><use href="#svg-favori"></use></svg>';
        if (tab === 'my') html += chip(esc(tr('POSP_CURRENT')), here, trf('POSP_CURRENT_A11Y', here));
        else if (s.my >= 0) html += chip(`${star}${s.my}`, s.my, trf('POSP_GO_MY', s.my));
        else html += `<button type="button" class="pos-chip" disabled aria-label="${esc(tr('POSP_NO_MY'))}">${star}—</button>`;
        p.el.querySelector('.pos-chips').innerHTML = html;
        this.renderPosPanel();
    }
    setPosSel(v, how) {
        const p = this.pos;
        if (!p) return;
        p.sel = Math.max(0, Math.min(100, Math.round(v)));
        if (p.tab === 'move' && how) {
            clearTimeout(p.sendT); p.sendT = null;
            // Steps and keys are batched: one radio order instead of one per press.
            if (how === 'now') this.sendPosTarget(p.sel);
            else p.sendT = setTimeout(() => { p.sendT = null; this.sendPosTarget(p.sel); }, 600);
        }
        this.renderPosPanel();
    }
    sendPosTarget(v) {
        const p = this.pos, s = p && this.posShade(p.shadeId);
        if (!s || (!s.moving && v === s.cur)) return;
        if (s.tiltOnly) this.sendTiltCommand(p.shadeId, v);
        else this.sendCommand(p.shadeId, shadeOpenness(v, s.flip));
    }
    flushPosSend() {
        const p = this.pos;
        if (!p) return;
        if (p.sendT) { clearTimeout(p.sendT); p.sendT = null; this.sendPosTarget(p.sel); }
        if (p.tiltT) { clearTimeout(p.tiltT); p.tiltT = null; this.sendTiltCommand(p.shadeId, p.tilt); }
    }
    renderPosPanel() {
        const p = this.pos;
        if (!p) return;
        const s = this.posShade(p.shadeId);
        if (!s) { this.closePosPanel(); return; }
        const el = p.el, q = (c) => el.querySelector(c), v = p.sel, my = p.tab === 'my';
        q('.pos-val').textContent = v;
        q('.pos-apron .shutter').style.height = (100 - v) + '%';
        // Kept whole inside the apron at both ends (the handle is 22 px tall).
        q('.pos-grip').style.top = `clamp(11px, ${100 - v}%, calc(100% - 11px))`;
        const apron = q('.pos-apron');
        apron.setAttribute('aria-valuenow', v);
        apron.setAttribute('aria-valuetext', s.tiltOnly ? `${v} %` : trf('POSP_VALUETEXT', v));
        const now = q('.pos-now');
        now.hidden = !s.moving && s.cur === v;
        now.style.top = (100 - s.cur) + '%';
        // Near the bottom the label would fall out of the apron: put it above the line.
        now.classList.toggle('is-low', s.cur < 12);
        now.firstElementChild.textContent = trf('POSP_NOW', s.cur);
        const pin = q('.pos-pin');
        pin.hidden = s.my < 0;
        if (s.my >= 0) pin.style.top = (100 - s.my) + '%';
        const st = q('.pos-state');
        st.textContent = s.status;
        st.classList.toggle('is-moving', s.moving);
        // One chip lit at most: "Current" or My can share their value with a preset.
        let lit = false;
        el.querySelectorAll('.pos-chips .pos-chip').forEach(b => {
            const on = !lit && parseInt(b.dataset.val, 10) === v;
            if (on) lit = true;
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });

        const range = q('.pos-tilt-range');
        if (range) {
            // In "move" the tilt follows the shade, unless the slider is in use.
            if (!my && document.activeElement !== range && !p.tiltT) p.tilt = s.tilt;
            if (document.activeElement !== range) range.value = p.tilt;
            q('.pos-tilt-val').textContent = p.tilt;
        }

        q('.pos-mybox').hidden = !my;
        q('.pos-note').textContent = tr(my ? 'POSP_NOTE_MY' : 'POSP_NOTE_MOVE');
        if (my) {
            const withTilt = !s.tiltOnly && s.tiltType > 0;
            // Mirrors SomfyShade::setMyPosition: ignored while moving; asking for the
            // current My clears it (so recording it again is not offered: clearing has
            // its own confirmed button); elsewhere the shade moves first, then records.
            const same = s.my >= 0 && v === s.my && (!withTilt || p.tilt === s.myTilt);
            const here = v === s.cur && (!withTilt || p.tilt === s.tilt);
            const btn = q('.pos-mybtn');
            btn.disabled = s.moving || same;
            btn.textContent = same ? tr('POSP_IS_MY') : trf('POSP_SAVE_MY', v);
            q('.pos-myclear').hidden = s.my < 0 || s.moving;
            q('.pos-mytext').textContent = s.moving ? tr('POSP_MY_BUSY')
                : same ? tr('POSP_MY_SAME')
                : here ? tr('POSP_MY_HERE')
                : trf('POSP_MY_MOVE', v);
        }
    }
    sendShadeMyPosition(shadeId, pos, tilt) {
        if(DBG) console.log(`Sending My Position for shade id ${shadeId} to ${pos} and ${tilt}`);
        // putJSONBusy also drops its overlay when a 401 opens the login prompt.
        putJSONBusy('/setMyPosition', { shadeId: shadeId, pos: pos, tilt: tilt }, (err, response) => {
            if (err) ui.serviceError(err);
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
            ico.style.setProperty('--fpos', p + '%');
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
            if (typeof state.flipPosition !== 'undefined') d.dataset.flipposition = state.flipPosition ? 'true' : 'false';
            if (state.tiltType !== 0) {
                Object.assign(d.dataset, {
                    tiltdirection: state.tiltDirection,
                    tiltposition: state.tiltPosition,
                    tilttarget: state.tiltTarget
                });
            }
            this.renderTileState(d);
        });
        if (this.pos && this.pos.shadeId === sId) this.renderPosPanel();
        this.updateHomeSummary();
    }
    procRemoteFrame(frame) {
        const qs = (s) => get(s);
        qs('spanRssi').textContent = frame.rssi;
        qs('spanFrameCount').innerHTML = parseInt(qs('spanFrameCount').innerHTML || 0, 10) + 1;
        rfdiag.onRemoteFrame(frame);

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
                ui.errorMessage(get('divConfigPnl'), tr('ERR_ROOM_LIMIT_REACHED'));
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
    // Travel times are typed in milliseconds (the firmware unit); each field echoes
    // the value in seconds underneath, which is how people read a travel time.
    msHelpsRefresh() {
        ['fldShadeUpTime', 'fldShadeDownTime', 'fldShadeLiftTime', 'fldTiltTime'].forEach(id => {
            const f = get(id);
            if (!f) return;
            let h = get(id + 'Sec');
            if (!h) {
                h = document.createElement('p');
                h.id = id + 'Sec';
                h.className = 'help ms-sec';
                h.setAttribute('aria-live', 'off');
                f.insertAdjacentElement('afterend', h);
                f.setAttribute('aria-describedby', h.id);
                f.addEventListener('input', () => this.msHelpsRefresh());
            }
            const v = parseInt(f.value, 10);
            h.textContent = isNaN(v) ? '' : trf('MS_AS_SECONDS', (v / 1000).toLocaleString(document.documentElement.lang || 'fr', { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
        });
    }
    // Tabs of the device record (General, Travel, Sensors, Remotes, Advanced).
    shSelectTab(name) {
        document.querySelectorAll('#somfyShade .sh-tabs [data-shtab]').forEach(b => {
            const on = b.getAttribute('data-shtab') === name;
            b.classList.toggle('selected', on);
            b.setAttribute('aria-selected', on ? 'true' : 'false');
            b.tabIndex = on ? 0 : -1;
            const p = get('shp' + b.getAttribute('data-shtab'));
            if (p) p.style.display = on ? '' : 'none';
        });
    }
    bindShadeTabs() {
        const strip = document.querySelector('#somfyShade .sh-tabs');
        if (!strip) return;
        strip.addEventListener('click', (e) => {
            const b = e.target.closest('[data-shtab]');
            if (b) this.shSelectTab(b.getAttribute('data-shtab'));
        });
        strip.addEventListener('keydown', (e) => {
            const tabs = Array.from(strip.querySelectorAll('[data-shtab]')).filter(t => !t.hidden);
            const i = tabs.indexOf(document.activeElement);
            if (i < 0) return;
            let n = -1;
            if (e.key === 'ArrowRight') n = (i + 1) % tabs.length;
            else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
            else if (e.key === 'Home') n = 0;
            else if (e.key === 'End') n = tabs.length - 1;
            if (n < 0) return;
            e.preventDefault();
            tabs[n].focus();
            this.shSelectTab(tabs[n].getAttribute('data-shtab'));
        });
    }
    openEditShade(shadeId) {
        const g = get,
        isNew = shadeId === undefined,
        ico = g('icoShade'),
        btns = ['btnPairShade', 'btnUnpairShade', 'btnLinkRemote', 'hrSetRollingC', 'btnSetRollingCode'];

        if (isNew && this.shades?.length >= 30)
            return ui.errorMessage(g('divConfigPnl'), tr('ERR_DEVICE_LIMIT_REACHED'));

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
                    tiltTime: 7000, tiltType: 0, flipCommands: 0, flipPosition: 0, paired: 0, sunSensor: 0, simMy: 0, repeats: DEFAULT_REPEATS
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
            this.msHelpsRefresh();
            if (g('shEditTitle')) g('shEditTitle').textContent = isNew ? tr('SH_NEW') : shade.name;
            // A new device has no remote to link yet: its tab would be empty.
            if (g('shtabRemotes')) g('shtabRemotes').hidden = isNew;
            this.shSelectTab('General');
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
            return ui.errorMessage(g('divConfigPnl'), tr('ERR_GROUP_LIMIT_REACHED'));

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
    // "Close" of the shade, room and group records goes through the unsaved-changes
    // guard like a page change; closing also drops the flag, or the save bar would
    // stay up over the list with nothing left to save.
    closeEditor(kind) {
        const close = () => { navClearDirty(); this['showEdit' + kind](false); };
        if (navConfirmLeave(close)) close();
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
            ui.errorMessage(get('divConfigPnl'), tr('ERR_ROOM_NAME_INVALID'));
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
                        navSaved();
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
                        navSaved();
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
        settings = g('divConfigPnl');

        // Empty field, or firmware older than the UI (JSON without liftTime): 0 = original behaviour.
        if (isNaN(obj.liftTime)) obj.liftTime = 0;

        ui.clearFieldErrors(g('somfyShade'));
        // Third entry: the field the message belongs to, so the user is put in front of
        // the thing to fix instead of being told what went wrong and left to find it.
        const checks = [
            [isNaN(obj.remoteAddress) || obj.remoteAddress < 1 || obj.remoteAddress > 16777215, 'ERR_REMOTE_ADDRESS_INVALID', 'fldShadeAddress'],
            [!obj.name || obj.name.length > 20, 'ERR_DEVIVE_NAME_INVALID', 'fldShadeName'],
            [isNaN(obj.upTime) || obj.upTime < 1 || obj.upTime > 180000, 'ERR_UP_TIME_INVALID', 'fldShadeUpTime'],
            [isNaN(obj.downTime) || obj.downTime < 1 || obj.downTime > 180000, 'ERR_DOWN_TIME_INVALID', 'fldShadeDownTime'],
            [obj.liftTime < 0 || obj.liftTime > 60000, 'ERR_LIFT_TIME_INVALID', 'fldShadeLiftTime']
        ];

        const basicError = checks.find(c => c[0]);
        if (basicError) return ui.fieldError(g(basicError[2]), tr(basicError[1]));
        if (obj.proto === 8 || obj.proto === 9) {
            const isSp = [5, 14, 15, 16, 10].includes(obj.shadeType);

            if (obj.gpioUp === obj.gpioDown && !(isSp && obj.proto === 9)) {
                return ui.fieldError(g('selShadeGPIODown'), tr('ERR_GPIO_UP_DOWN_NOT_UNIQUE'));
            }
            if (!isSp && obj.proto === 9 && (obj.gpioMy === obj.gpioUp || obj.gpioMy === obj.gpioDown)) {
                return ui.fieldError(g('selShadeGPIOMy'), tr('ERR_GPIO_UP_DOWN_MY_NOT_UNIQUE'));
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
            navSaved();
        });
    }
    saveGroup() {
        const g = get,
        sId = g('spanGroupId').innerText,
        groupId = parseInt(sId, 10),
        obj = ui.fromElement(g('somfyGroup')),
        isNew = isNaN(groupId) || groupId >= 255;

        ui.clearFieldErrors(g('somfyGroup'));
        const checks = [
            [isNaN(obj.remoteAddress) || obj.remoteAddress < 1 || obj.remoteAddress > 16777215, 'ERR_REMOTE_ADDRESS_INVALID', 'fldGroupAddress'],
            [!obj.name || obj.name.length > 20, 'ERR_DEVIVE_NAME_INVALID', 'fldGroupName']
        ];
        const error = checks.find(c => c[0]);
        if (error) return ui.fieldError(g(error[2]), tr(error[1]));
        if (!isNew) obj.groupId = groupId;

        putJSONBusy(isNew ? '/addGroup' : '/saveGroup', obj, (err, group) => {
            if (err) return ui.serviceError(err);

            if(DBG) console.log("Group saved:", group);
            const msg = isNew ? tr('MSG_ADD_SUCCESS') : tr('MSG_SAVE_SUCCESS');
            ui.successMessage(msg);
            this.openEditGroup(group.groupId);
            this.updateGroupList();
            navSaved();
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
            if (err) ui.serviceError(get('divConfigPnl'), err);
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
            bindHoldKeys(btnProg, onP);
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
        document.querySelectorAll(`.somfy-shade-icon[data-shadeid="${shadeId}"], .shade-viz[data-shadeid="${shadeId}"]`).forEach(el => {
            el.classList.remove('cmd-sent');
            void el.offsetWidth;  // restart the CSS animation on rapid re-taps
            el.classList.add('cmd-sent');
            setTimeout(() => el.classList.remove('cmd-sent'), 950);
        });
        // Screen readers get the same acknowledgment the pulse gives sighted users.
        const name = document.querySelector(`#shName${shadeId}`);
        if (name) this.announce(trf('LIVE_CMD_SENT', name.textContent));
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
            bindHoldKeys(btnAction, progDown, progUp);
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
    openSelectRoom() {
        this.closeShadePositioners();
        if(DBG) console.log('Opening rooms');
        let list = get('divRoomSelector-list');
        list.style.display = 'block';
        document.body.addEventListener('click', () => {
            list.style.display = '';
        }, { once: true });
    }
}
var somfy = new Somfy();
// shades.cfg separates its fields with commas, so the firmware turns a comma in a
// shade, group or room name into a space. Drop it as it is typed instead, so the
// name that gets saved is the one on screen.
document.addEventListener('input', (e) => {
    const t = e.target;
    if (!t || !t.matches || !t.matches('#fldShadeName, #fldGroupName, #fldRoomName')) return;
    if (t.value.indexOf(',') < 0) return;
    const caret = t.selectionStart - (t.value.slice(0, t.selectionStart).split(',').length - 1);
    t.value = t.value.replace(/,/g, '');
    t.setSelectionRange(caret, caret);
}, true);
