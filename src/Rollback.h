#ifndef ROLLBACK_H
#define ROLLBACK_H

// Application-level OTA rollback. The Arduino bootloader is not built with
// CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE, so validation is handled here.
// After an OTA, markPending() sets an NVS marker; checkBoot() counts boots
// while the firmware is not validated and switches back to the previous
// application partition if the new firmware never survives one minute.
class OTARollback {
  public:
    static void markPending(); // Call right before the post-OTA firmware reboot.
    static void checkBoot();   // Call as early as possible in setup().
    static void markValid();   // Call after one minute of healthy operation.
};
#endif
