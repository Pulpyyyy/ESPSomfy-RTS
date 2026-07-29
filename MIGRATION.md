# Migrating from ESPSomfy-RTS v2.x (rstrouse / xkain)

This guide walks you through moving an existing ESPSomfy-RTS v2.x device
(original project by rstrouse, or the xkain fork) to this firmware. The
whole point of the procedure is that **you keep everything**: shades,
rooms, groups, remote addresses and — critically — **rolling codes**, so
your shades never need to be re-paired.

The backup format is versioned field by field since the original
project. Restoring an old backup on this firmware has been **verified
end-to-end with a real v2.5.6-format backup**: every field is read
back exactly, and the fields introduced by this fork get neutral
defaults (`liftTime` 0 = disabled, `curveGain` 0 = no correction).
Backups from any 2.x release are accepted.

## Before you start

- A computer with a USB cable that can reach the device (the partition
  change is the one step that cannot be done over the air).
- [esptool](https://github.com/espressif/esptool) installed
  (`pip install esptool`), or any ESP32 flashing tool you are used to.
- 10 minutes.

## Step 1 — Back up your current configuration

In your **current** (v2.x) web UI:

1. Open the settings page and locate the **Backup** section.
2. Download the backup file (`*.backup`) and keep it somewhere safe.

This file contains your shades, rooms, groups, linked remotes,
repeaters and rolling codes. It is the only thing you need to carry
over. **Do not skip this step.**

## Step 2 — Flash the v3.x onboard image over USB

The v3.x firmware uses a larger application partition (1.69 MB per OTA
slot instead of 1.31 MB), which leaves room for future updates. A
partition table cannot be changed over the air, hence this single USB
flash. Every later update is a classic OTA again.

1. Download `SomfyController.onboard.esp32.bin` (or the variant
   matching your board) from the
   [releases page](https://github.com/Pulpyyyy/ESPSomfy-RTS/releases).
2. Connect the device over USB and flash the image at offset 0:

   ```
   esptool.py -p <PORT> write_flash 0x0 SomfyController.onboard.esp32.bin
   ```

   Replace `<PORT>` with your serial port (`COM5`, `/dev/ttyUSB0`, ...).

The device boots with a blank configuration.

## Step 3 — First boot and network setup

With a blank configuration the device starts its own WiFi access
point:

1. On a phone or laptop, join the network **`ESPSomfyRTS`**
   (WPA2 password: **`espsomfy`** — fixed and documented on purpose,
   it only guards joining the AP).
2. Open **http://192.168.4.1** in a browser.
3. Enter your home WiFi credentials and save. The device reboots and
   joins your network; the access point disappears.
4. Find the device's new address (your router's DHCP client list, or
   the address you had reserved for it) and open the web UI there.

If you use a PIN or password on the UI, set it now — a fresh install
starts unsecured.

## Step 4 — Restore your backup

In the **new** web UI:

1. Go to the backup/restore section of the settings.
2. Upload the backup file from step 1.
3. Select at least **Shades** (rooms, groups and repeaters are part of
   it). Restoring network settings is optional — you just configured
   them, keeping the fresh ones is recommended.
4. Start the restore. The device reboots.

After the reboot every shade is back — names, rooms, sort order,
remote addresses and rolling codes included. Nothing needs to be
re-paired: press a paired remote and the frame counter moves on from
where it left off.

## Step 5 — Verify, then make a new backup

1. Check that all shades are listed and respond.
2. Immediately create a **new** backup from this firmware. The new
   file uses the current format (per-shade `liftTime` and `curveGain`
   are included) and is the one to keep from now on.

> **Going back?** Keep the *old* v2.x backup file. A backup written by
> this firmware uses a newer record layout that a v2.x device rejects
> (safely — its size check refuses the file). To return to v2.x, flash
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
  VPN or overlay network, this is almost always a path-MTU problem —
  full-size TCP segments are dropped silently. Lower the tunnel MTU
  (e.g. 1380 instead of 1420) or run the migration from a machine on
  the same LAN as the device.
- **"Not a valid file" when uploading**: the UI checks file *content*
  (magic bytes), not the file name. Make sure you selected the backup
  file for a restore, the `littlefs` image for a UI update, and the
  firmware image for a firmware update.
- **The update is refused with a size error**: the firmware verifies
  images against the real OTA slot size before writing — this is the
  guard working, not a bug. Check you downloaded the image matching
  your partition layout.
