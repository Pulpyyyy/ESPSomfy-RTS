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
    appVersion = 'v3.4.1-beta.1';
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
