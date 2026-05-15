const INACTIVITY_THRESHOLD_MINUTES = 30;

const buildAlertsForEvent = ({ device, lastEvent, event }) => {
  const alerts = [];
  const isOutsideExpectedZone =
    device.expectedLocation && event.location !== device.expectedLocation;
  const wasAlreadyOutsideSameZone =
    lastEvent &&
    lastEvent.location === event.location &&
    lastEvent.location !== device.expectedLocation;

  if (isOutsideExpectedZone && !wasAlreadyOutsideSameZone) {
    alerts.push({
      alertType: "outside_zone",
      message: `Dispositivo fuera de zona esperada: ${device.expectedLocation}`,
      status: "open",
      metadata: {
        expectedLocation: device.expectedLocation,
        receivedLocation: event.location,
      },
      hospitalId: device.hospitalId,
      deviceId: device.id,
      eventId: event.id,
    });
  }

  if (lastEvent) {
    const diffMs = event.timestamp.getTime() - lastEvent.timestamp.getTime();
    const diffMinutes = diffMs / (1000 * 60);

    if (diffMinutes > INACTIVITY_THRESHOLD_MINUTES) {
      alerts.push({
        alertType: "inactivity",
        message: `Dispositivo sin actividad por ${Math.floor(diffMinutes)} minutos`,
        status: "open",
        metadata: {
          thresholdMinutes: INACTIVITY_THRESHOLD_MINUTES,
          inactiveMinutes: Math.floor(diffMinutes),
          previousTimestamp: lastEvent.timestamp,
          currentTimestamp: event.timestamp,
        },
        hospitalId: device.hospitalId,
        deviceId: device.id,
        eventId: event.id,
      });
    }
  }

  return alerts;
};

module.exports = { buildAlertsForEvent };
