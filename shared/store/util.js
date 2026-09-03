'use strict';
/** Only these device fields are ever exposed through the IDS / dashboard. */
function publicDeviceFields(d) {
  return {
    deviceId: d.deviceId,
    deviceName: d.deviceName,
    kemPublicKey: d.kemPublicKey,
    sigPublicKey: d.sigPublicKey,
    attestation: d.attestation,
    addedAt: d.addedAt,
  };
}
module.exports = { publicDeviceFields };
