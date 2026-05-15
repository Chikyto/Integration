const buildAlertEmailSubject = (hospitalName, severityLabel) =>
  `[STEH] Alerta ${severityLabel} - ${hospitalName}`;

const buildAlertEmailHtml = ({ hospitalName, alertType, message, deviceName, zoneName, detectedAt, severityLabel }) => `
  <div style="font-family:Arial,sans-serif;line-height:1.5;color:#1f2937">
    <h2 style="margin:0 0 16px;color:#b91c1c">Alerta ${severityLabel} en STEH</h2>
    <p>Se detectó un evento que requiere revisión inmediata.</p>
    <table style="border-collapse:collapse;margin:16px 0">
      <tr><td style="padding:6px 12px 6px 0"><strong>Hospital</strong></td><td>${hospitalName}</td></tr>
      <tr><td style="padding:6px 12px 6px 0"><strong>Equipo</strong></td><td>${deviceName}</td></tr>
      <tr><td style="padding:6px 12px 6px 0"><strong>Tipo</strong></td><td>${alertType}</td></tr>
      <tr><td style="padding:6px 12px 6px 0"><strong>Zona</strong></td><td>${zoneName}</td></tr>
      <tr><td style="padding:6px 12px 6px 0"><strong>Fecha</strong></td><td>${detectedAt}</td></tr>
    </table>
    <p><strong>Detalle:</strong> ${message}</p>
    <p>Ingresar al panel para revisar la alerta y tomar acción.</p>
  </div>
`;

const buildAlertEmailText = ({ hospitalName, alertType, message, deviceName, zoneName, detectedAt, severityLabel }) =>
  [
    `Alerta ${severityLabel} en STEH`,
    `Hospital: ${hospitalName}`,
    `Equipo: ${deviceName}`,
    `Tipo: ${alertType}`,
    `Zona: ${zoneName}`,
    `Fecha: ${detectedAt}`,
    `Detalle: ${message}`,
  ].join("\n");

module.exports = {
  buildAlertEmailHtml,
  buildAlertEmailSubject,
  buildAlertEmailText,
};
