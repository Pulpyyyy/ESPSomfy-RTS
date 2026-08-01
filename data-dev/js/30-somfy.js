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
