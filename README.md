[![GitHub Release](https://img.shields.io/github/release/Pulpyyyy/ESPSomfy-RTS.svg?style=for-the-badge)](https://github.com/Pulpyyyy/ESPSomfy-RTS/releases) [![GitHub Activity](https://img.shields.io/github/last-commit/Pulpyyyy/ESPSomfy-RTS?style=for-the-badge)](https://github.com/Pulpyyyy/ESPSomfy-RTS/commits/main) [![PlatformIO](https://img.shields.io/badge/PlatformIO-Compatible-orange?style=for-the-badge&logo=platformio&logoColor=white)](https://platformio.org) [![License](https://img.shields.io/github/license/Pulpyyyy/ESPSomfy-RTS.svg?style=for-the-badge)](LICENSE) [![Project Maintenance](https://img.shields.io/badge/maintainer-Pulpyyyy-blue.svg?style=for-the-badge)](https://github.com/Pulpyyyy) [![GitHub stars](https://img.shields.io/github/stars/Pulpyyyy/ESPSomfy-RTS?style=for-the-badge&logo=github&color=blue)](https://github.com/Pulpyyyy/ESPSomfy-RTS/stargazers)

<div align="center">

  <img src="images/banniereSomfyRTS.png" alt="ESPSomfy-RTS Banner" width="100%">

  <br />
 
  <p align="center">
    Easily control and monitor your roller shutters, gates, garage doors, or any other device using the RTS 433 MHz protocol.
    <br />
    <br />
    <a href="https://github.com/Pulpyyyy/ESPSomfy-RTS/blob/main/README_fr.md"><strong>README complet en français 🇫🇷 »</strong></a>
    <br />
    <a href="https://github.com/Pulpyyyy/ESPSomfy-RTS/wiki"><strong>Explore documentation »</strong></a>
    <br />
    <br />
    <a href="https://github.com/Pulpyyyy/ESPSomfy-RTS/issues">Report Bug</a>
    ·
    <a href="https://github.com/Pulpyyyy/ESPSomfy-RTS/pulls">Request Feature</a>
  </p>
</div>

<br />

<p align="center">
  <img src="images/exemple.png" alt="ESPSomfy-RTS Screen Shot" width="100%">
</p>

## About The Project

This project serves as a comprehensive controller for Somfy RTS blinds and shades, capable of managing up to **30 individual shades** , **14 groups** and **14 rooms**.

#### Supported Protocols
* **433MHz RTx:** Full support for **RTS, RTW, RTV/L**, and **433.92MHz** protocols.
* **Frequency Constraints:** You can mix protocols as long as they reside within the same base frequency range. 
  > **Note:** You cannot operate 433.92MHz and 433.42MHz motors simultaneously on the same radio transceiver.
* **IO Home Control:** Not natively supported. However, compatibility can be achieved via the **IO Remote protocol** by interfacing with a dissected remote control. 

#### Wired Motors (Relays)
For those with "bare" motors (no built-in radio), this project includes support for **relay module configurations**. Once set up, these motors can be controlled through the interface exactly like native RTS or RTW devices.

<br />

### Why does this project exist?

**ESPSomfy-RTS** is a powerful project at its core, but I felt it needed a more modern and localized touch.

Being French (and therefore a big fan of bread and cheese), I found during my very first use that the explanations were sometimes confusing. Above all, I felt like I had to put on sunglasses every time I opened the interface! This fork is designed to save you a trip to the eye doctor and a few linguistic headaches along the way.

While keeping the **rock-solid foundations** of the original project, I have completely redesigned the user experience to be **truly responsive**: the interface is just as pleasant to use on mobile and tablet as it is on PC, and navigation is finally crystal clear for non-English speakers.

This project aims to make managing your RTS 433 MHZ devices as beautiful as it is functional.

<br />

## Migration & Updates

If you are migrating from **rstrouse/ESPSomfy-RTS** or upgrading from an older version of this fork, please read the following:

#### From rstrouse to this Fork (v2.5.0+)
* **Data Compatibility:** You can restore a `.backup` file from the original project. Your shades, groups, and remote addresses will be successfully migrated.
* **⚠️ Radio Settings (Action Required):** Due to the new GPIO Selector in v2.5.0, radio pin assignments are **not** automatically restored from older backup files. 
* **Warning Message:** You will see a compatibility alert during the restore process. After the import, you **must** manually verify and re-assign your GPIO pins in the **Radio tab**.

#### Upgrading from v2.4.8 to v2.5.0
* **Direct Update:** Your existing settings are automatically migrated and preserved during the update process. 
* **⚠️ Automatic Backup Note:** The backup file created by the system *just before* the update is still in the old format. 
* **Restoring after Update:** If you ever need to restore that specific pre-update backup onto v2.5.0+, you will trigger the "Incomplete Compatibility" alert and will need to re-assign your Radio GPIOs manually.

> [!TIP]
> After a successful update to v2.5.0, we recommend creating a **new backup** immediately. This new file will include the updated GPIO mapping and won't trigger any warnings in the future.

## Home Assistant

This firmware is designed to run with **[ESPSomfy-RTS Enhanced](https://github.com/Pulpyyyy/ESPSomfy-RTS-enhanced)**, the matching Home Assistant integration.

The API is unchanged, so the official ESPSomfy-RTS-HA integration keeps working: your entities, names and dashboards are preserved. One difference matters though — this fork announces itself over SSDP as `urn:schemas-pulpyyyy-org:device:Somfy:1`, which only the Enhanced integration listens for. With the official integration the device is no longer discovered automatically and has to be added by IP.

## Project ESPSomfy-RTS Roadmap

Want to know what's coming next, check current release progress, or see completed features? We use GitHub Projects to maintain a live, up-to-date roadmap.

[![ESPSomfy-RTS Roadmap](https://img.shields.io/badge/View_Live-Roadmap_🗣️-238636?style=for-the-badge&logo=github)](https://github.com/users/Pulpyyyy/projects/2)

> 💡 **Click the badge above** to track real-time development, active milestones (`v2.5.3`, `v3.0.0`), and submit features or bug fixes directly into our workflow columns.

<br />

## 🛠️ Troubleshooting & Factory Reset

If you lose access to the web interface (network configuration error or forgotten password), a manual reset procedure is available via (**Power Cycles**).

> [!IMPORTANT]
>The procedure depends on your firmware version. A two-tier system was introduced in **v2.5.1** to allow resetting the network without losing all your configurations (which is not the case if you are using version **2.5.0**).

### Summary of procedures

* **Version v2.5.1+ :**
    * **3 Cycles :** Resets Wi-Fi configuration and disables security settings.
    * **6 Cycles :** Full Factory Reset (**Full Wipe**).
* **Version v2.5.0 :**
    * **4 Cycles :** Full Factory Reset (**Full Wipe**).

### 📖 Complete documentation
To view detailed instructions and cycle diagrams, please visit the dedicated page:

👉 **[View the Factory Reset page](https://github.com/Pulpyyyy/ESPSomfy-RTS/wiki/Factory-Reset)**

> [!TIP]
> Always use these procedures as a last resort. If the interface is still accessible, use the **Restore** button in the system settings instead.

---

## 📸 Screenshots

### 📱 Mobile View (Dark Mode)
<p align="center">
  <img src="https://github.com/Pulpyyyy/ESPSomfy-RTS/blob/main/images/dark-mobile00.png?raw=true" width="23%" />
  <img src="https://github.com/Pulpyyyy/ESPSomfy-RTS/blob/main/images/dark-mobile01.png?raw=true" width="23%" />
  <img src="https://github.com/Pulpyyyy/ESPSomfy-RTS/blob/main/images/dark-mobile02.png?raw=true" width="23%" />
  <img src="https://github.com/Pulpyyyy/ESPSomfy-RTS/blob/main/images/dark-mobile03.png?raw=true" width="23%" />
</p>

### 💻 Desktop View (Dark Mode)
<p align="center">
  <img src="https://github.com/Pulpyyyy/ESPSomfy-RTS/blob/main/images/dark00.png?raw=true" width="80%" /><br><br>
  <img src="https://github.com/Pulpyyyy/ESPSomfy-RTS/blob/main/images/dark02.png?raw=true" width="80%" /><br><br>
  <img src="https://github.com/Pulpyyyy/ESPSomfy-RTS/blob/main/images/dark03.png?raw=true" width="80%" />
</p>

<br>

<details>
<summary><b>✨ Click here to see Light Mode versions</b></summary>
  
### 📱 Mobile View 
<p align="center">
  <img src="https://github.com/Pulpyyyy/ESPSomfy-RTS/blob/main/images/clair-mobile00.png?raw=true" width="23%" />
  <img src="https://github.com/Pulpyyyy/ESPSomfy-RTS/blob/main/images/clair-mobile01.png?raw=true" width="23%" />
  <img src="https://github.com/Pulpyyyy/ESPSomfy-RTS/blob/main/images/clair-mobile02.png?raw=true" width="23%" />
  <img src="https://github.com/Pulpyyyy/ESPSomfy-RTS/blob/main/images/clair-mobile03.png?raw=true" width="23%" />
</p>

### 💻 Desktop View  
<p align="center">
  <img src="https://github.com/Pulpyyyy/ESPSomfy-RTS/blob/main/images/clair00.png?raw=true" width="80%" /><br><br>
  <img src="https://github.com/Pulpyyyy/ESPSomfy-RTS/blob/main/images/clair02.png?raw=true" width="80%" /><br><br>
  <img src="https://github.com/Pulpyyyy/ESPSomfy-RTS/blob/main/images/clair03.png?raw=true" width="80%" />
</p>
</details>
    
---

## 📚 Documentation & Resources

Since this is a fork, you can rely on the extensive original documentation for technical hardware details and integrations:

* 📖 **[Configuring the Software](https://github.com/rstrouse/ESPSomfy-RTS/wiki/Configuring-the-Software)**
* ⚙️ **[Installing the Firmware](https://github.com/rstrouse/ESPSomfy-RTS/wiki/Installing-the-Firmware)**
* 🔄 **[How to Update ESPSomfy RTS](https://github.com/rstrouse/ESPSomfy-RTS/wiki/Updating-ESPSomfy-RTS)**
* 🔌 **[Integrations](https://github.com/Pulpyyyy/ESPSomfy-RTS/wiki/Intégrations)**

---

## 📶 Fallback Access Point (Wi‑Fi)

If the device cannot join your Wi‑Fi (first boot, wrong password, network down), it opens a **fallback access point** so you can (re)configure it:

* **SSID**: the device hostname (`ESPSomfyRTS` by default).
* **Password (WPA2)**: `espsomfy`

Connect to that network and open `http://192.168.4.1` to set up Wi‑Fi. The AP password only guards joining the network; the configuration and control are still protected by your PIN/password if one is set.

---

## 🙏 Credits
Special thanks to [rstrouse](https://github.com/rstrouse) for the incredible work on the original ESPSomfy-RTS project, to [xkain](https://github.com/xkain) whose fork this one builds on, and to [y-streibel-uiris](https://github.com/y-streibel-uiris) for the HTTPS WebSocket implementation.
