# Migrating from ESPSomfy-RTS v2.x (rstrouse / xkain)

This guide walks you through moving an existing ESPSomfy-RTS v2.x device
(original project by rstrouse, xkain fork or cjkas fork) to this
firmware. The
whole point of the procedure is that **you keep everything**: shades,
rooms, groups, remote addresses and, critically, **rolling codes**, so
your shades never need to be re-paired.

The backup format is versioned field by field since the original
project. Restoring an old backup on this firmware has been **verified
end-to-end with real xkain 2.5.6 and cjkas format backups**: every
field is read back exactly, and the fields introduced by this fork get
neutral defaults (`liftTime` 0 = disabled, `curveGain` 0 = no
correction). Backups from any 2.x release are accepted.

> **Coming from the original project (rstrouse, 2.4.x) or the cjkas
> fork**: their radio record uses another layout (shorter in
> rstrouse's, different under the same version number in cjkas'); the
> firmware detects this and keeps the current radio settings instead
> of restoring corrupted values. Set the radio up by hand after the
> restore (step 5): everything else (shades, rooms, groups, repeaters,
> rolling codes) restores normally. The rstrouse format is recognised
> by the code but has not been checked with a real backup yet.

## Before you start

- A computer with a USB cable that can reach the device (the partition
  change is the one step that cannot be done over the air).
- [esptool](https://github.com/espressif/esptool) installed
  (`pip install esptool`), or any ESP32 flashing tool you are used to.
- 10 minutes.

## Step 1: Back up your current configuration

In your **current** (v2.x) web UI:

1. Open the settings page and locate the **Backup** section.
2. Download the backup file (`*.backup`) and keep it somewhere safe.

This file contains your shades, rooms, groups, linked remotes,
repeaters and rolling codes. It is the only thing you need to carry
over. **Do not skip this step.**

## Step 2: Flash the v3.x onboard image over USB

The v3.x firmware uses a larger application partition (1.69 MB per OTA
slot instead of 1.31 MB), which leaves room for future updates. A
partition table cannot be changed over the air, hence this single USB
flash. Every later update is a classic OTA again.

> Already moved your device to v3.x or later over the air, without a
> USB flash? It then keeps the old partition table, and its **Updates
> and backup** page shows **Manual action required**: current images
> no longer fit. Follow this guide the same way (the step 1 backup is
> then in **Device › Updates and backup › Backup**).

**Easiest: from the browser** (Chrome or Edge): open the
[flash page](https://pulpyyyy.github.io/ESPSomfy-RTS/), plug the device
in over USB, pick your board and click Install. Nothing to install on
the computer.

**Or with esptool:**

1. Download `SomfyController.onboard.esp32.bin.zip` (or the variant
   matching your board: `esp32wrover`, `esp32c3`, `esp32s2`,
   `esp32s3_4mb`, `esp32s3_8mb`) from the
   [releases page](https://github.com/Pulpyyyy/ESPSomfy-RTS/releases)
   and unzip it. Every archive contains a file named
   `SomfyController.onboard.bin`.
2. Connect the device over USB and flash the image at offset 0:

   ```
   esptool.py -p <PORT> write_flash 0x0 SomfyController.onboard.bin
   ```

   Replace `<PORT>` with your serial port (`COM5`, `/dev/ttyUSB0`, ...).

The device boots with a blank configuration.

## Step 3: First boot and network setup

With a blank configuration the device starts its own WiFi access
point:

1. On a phone or laptop, join the network **`ESPSomfyRTS`**
   (WPA2 password **`espsomfy`**, fixed and documented on purpose,
   it only guards joining the AP).
2. Open **http://192.168.4.1** in a browser.
3. In **Device › Network**, press **Scan Wi-Fi**, pick your network,
   enter its password and save. The device reboots and
   joins your network; the access point disappears.
4. Find the device's new address (your router's DHCP client list, or
   the address you had reserved for it) and open the web UI there.

If you use a PIN or password on the UI, set it now in **Device ›
Security**: a fresh install starts unsecured.

## Step 4: Restore your backup

In the **new** web UI:

1. Open **Device › Updates and backup** and press **Restore System**.
2. Choose the backup file from step 1.
3. Keep **Restore devices and groups** ticked (shades, rooms and
   groups) and, if you use any, tick **Restore repeaters**: repeaters
   are a separate option, unticked by default. Tick **Restore radio
   settings** too: after the flash the radio is **disabled**; without
   this option you will have to set it up and turn it on yourself
   (step 5). Restoring network settings is optional: you just
   configured them, keeping the fresh ones is recommended. Wi-Fi and
   MQTT passwords are never part of a backup.
4. Start the restore. The device reboots.

After the reboot every shade is back: names, rooms, sort order,
remote addresses and rolling codes included. Nothing needs to be
re-paired: press a paired remote and the frame counter moves on from
where it left off.

## Step 5: Verify, then make a new backup

1. Check that all shades are listed and respond.
2. Open each shade, **Advanced** tab, and check its **Command
   repeats**: an old backup may bring back 0, and shades then miss
   orders, especially when several are sent at once. Set at least 2
   (3 or 4 for a distant shade). Do the same for groups.
3. Open **Device › Radio**: the radio must be enabled, with the right
   pins and frequency. If it is not (radio option not ticked, or a
   backup from the original rstrouse project or the cjkas fork, whose
   radio is not carried over),
   choose your board in **GPIO Assignment**, turn the radio on and
   save.
4. Immediately create a **new** backup from this firmware. The new
   file uses the current format (per-shade `liftTime` and `curveGain`
   are included) and is the one to keep from now on.

> **Going back?** Keep the *old* v2.x backup file. A backup written by
> this firmware uses a newer record layout that a v2.x device rejects
> (safely: its size check refuses the file). To return to v2.x, flash
> the old onboard image and restore the old backup file.

## Home Assistant

The HTTP/WebSocket API is unchanged: the official ESPSomfy-RTS-HA
integration keeps working, entities and dashboards are preserved. This
fork announces itself under a different SSDP URN, so auto-discovery
only works with the companion
[ESPSomfy-RTS Enhanced](https://github.com/Pulpyyyy/ESPSomfy-RTS-enhanced)
integration; with the official one, add the device by IP address.

## Troubleshooting

- **The restore (or any upload) stalls or ends with an empty reply**
  while regular pages load fine: if you reach the device through a
  VPN or overlay network, this is almost always a path-MTU problem:
  full-size TCP segments are dropped silently. Lower the tunnel MTU
  (e.g. 1380 instead of 1420) or run the migration from a machine on
  the same LAN as the device.
- **"This file is not a valid ... file" when uploading**: the UI checks file *content*
  (magic bytes), not the file name. Make sure you selected the backup
  file for a restore, the `littlefs` image for a UI update, and the
  firmware image for a firmware update.
- **The update is refused with a size error**: the firmware verifies
  images against the real OTA slot size before writing: this is the
  guard working, not a bug. Check you downloaded the image matching
  your partition layout.
