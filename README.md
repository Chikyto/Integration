# STEH — Sistema de Trackeo de Equipos Hospitalarios

Servicio headless para mini-PC industrial. Conecta lectores RFID YR8900 via TCP,
detecta tags de equipos médicos en zonas físicas del hospital y envía las
detecciones al backend en tiempo real mediante la Agent API. Sin interfaz
gráfica.

---

## Arquitectura del sistema completo

```
Lector YR8900 (TCP)  ──┐
Lector YR8900 (TCP)  ──┤── mini-PC (este servicio) ──► Backend ◄── PC Frontend
Lector YR8900 (TCP)  ──┘                                             └── Lector USB
                                                                         (alta de activos)
```

- **Este servicio**: trackeo continuo de zonas, persistencia offline, envío al backend.
- **PC Frontend**: alta de activos médicos (lector USB), UI del sistema completo.

---

## Requisitos

- Python 3.10+
- Red con acceso a los lectores YR8900 (IP estática por lector)
- Acceso HTTP al backend
- Una credencial de agente emitida por el backend

```bash
pip install requests colorama
```

---

## Configuración de zonas

Cada lector YR8900 es una zona. Crear un archivo JSON en `config/zones/`
copiando `config/zones/zone_ejemplo.json`:

```bash
cp config/zones/zone_ejemplo.json config/zones/zone_uci.json
```

Editar los campos obligatorios:

```json
{
  "zone_id":   "zone_uci_planta2",
  "zone_name": "UCI - Planta 2",
  "reader": {
    "host": "192.168.1.10",
    "port": 4001
  },
  "antennas": {
    "1": { "enabled": true, "name": "Puerta Entrada", "location": "door_in" },
    "2": { "enabled": true, "name": "Pasillo Central", "location": "corridor" }
  },
  "backend_url": "http://backend-host/api/agent/events",
  "power_dbm": 27,
  "scan_interval_ms": 200
}
```

| Campo | Descripción |
|---|---|
| `zone_id` | Identificador único de la zona (sin espacios) |
| `zone_name` | Nombre legible para logs |
| `reader.host` | IP del lector YR8900 en la red del hospital |
| `reader.port` | Puerto TCP (default: 4001) |
| `antennas` | Dict de puerto (1-4) → config de antena |
| `backend_url` | URL completa del endpoint del agente, ej. `/api/agent/events` |
| `power_dbm` | Potencia RF global (0-33 dBm, recomendado 27) |
| `scan_interval_ms` | Pausa entre rotaciones de antenas (ms) |

Se puede tener **cualquier cantidad de archivos JSON** en `config/zones/` —
el sistema arranca un hilo por cada zona habilitada (`enabled: true`).

## Configuración del dispositivo y token

`config/device.json` define la identidad local de la mini-PC y la URL del
backend. El token del agente no se guarda en el JSON: se carga desde la
variable de entorno indicada en `auth_token_env`.

Ejemplo:

```json
{
  "hospital_id": "hospital_test",
  "device_id": "minipc-dev-01",
  "backend_url": "http://localhost:3000/api/agent/events",
  "auth_token_env": "RFID_BACKEND_TOKEN"
}
```

El valor de `RFID_BACKEND_TOKEN` debe salir del backend, creando una credencial
de agente en `POST /api/agent/credentials`. El formato esperado es:

```text
agt_xxxxxxxx.secret_generado
```

Para desarrollo local, crear un archivo `.env` en la raiz del proyecto:

```env
RFID_BACKEND_TOKEN=agt_xxxxxxxx.secret_generado
```

Hay una plantilla lista en `.env.example`.

---

## Arrancar el sistema

```bash
python main.py
```

Al arrancar, el servicio ahora informa explicitamente si:
- encontro el token de agente
- el token fue validado contra `/api/agent/health`
- el backend respondio `401` o `403`

### Salida en consola esperada

```
2026-04-20T14:30:00 [INFO    ] Sistema de Trackeo de Equipos Médicos RFID — Iniciando
2026-04-20T14:30:00 [INFO    ] Zonas activas: 2
2026-04-20T14:30:01 [INFO    ] [zone_uci] Puerto 1 ✓ antena OK (RL=18 dB)
2026-04-20T14:30:01 [WARNING ] [zone_uci] Puerto 2 ✗ SIN antena física (RL=0 dB) — ¿cable desconectado?
2026-04-20T14:30:02 [INFO    ] TAG AABB1234     | raw:E28068940000401A4A950818  | UCI - Planta 2                 | Antena 1 — Puerta Entrada
2026-04-20T14:30:03 [INFO    ] Backend OK 201: tag=AABB1234 zone=zone_uci
```

Paleta de colores por tipo de evento:

| Evento | Color |
|---|---|
| `TAG` detectado | verde · ID cyan · zona amarillo · antena magenta · raw gris |
| `✓` antena OK | verde |
| `✗` antena ausente | rojo brillante |
| `Backend OK` | verde |
| `Backend HTTP 4xx/5xx` | rojo brillante |
| `Timeout` de red | amarillo brillante |
| `Sin conexión` (offline) | azul |
| `Sync:` resumen | cyan |

### Detener

```
Ctrl+C
```

El sistema hace shutdown ordenado: detiene los scanners, espera que el
SyncWorker envíe las detecciones pendientes y cierra.

---

## Persistencia offline

Si el backend no está disponible, las detecciones se almacenan en `detections.db`
(SQLite local). El `SyncWorker` reintenta el envío cada 5 segundos.

Cada registro tiene un `sync_status`:

| Estado | Descripción |
|---|---|
| `pending` | recién detectado, esperando envío |
| `synced` | enviado correctamente al backend |
| `failed` | falló al menos un intento, se reintentará |

Solo se reenvían los `pending` y `failed` — no hay datos duplicados al recuperar la conexión.

**Buffer automático:** cuando los registros `synced` superan 1000, se eliminan
los 200 más antiguos. Esto mantiene el archivo `.db` pequeño sin depender de fechas
(útil si el reloj del mini-PC se desincroniza).

Para ver cuántas detecciones están pendientes de envío:

```bash
python -c "from src.data.database import DetectionDB; print(DetectionDB().count_pending(), 'pendientes')"
```

---

## Diagnóstico y troubleshooting

### Ver logs detallados (DEBUG)

Editar `main.py`, cambiar:
```python
build_console_handler()
# por:
build_console_handler(level=logging.DEBUG)
```

### El lector no responde

1. Verificar que la IP en el JSON de zona sea correcta.
2. `ping <ip-del-lector>` desde la mini-PC.
3. El sistema reintenta la conexión automáticamente cada 10 segundos.

### Una antena no detecta tags

1. Verificar el cableado físico de la antena.
2. El sistema mide return loss al iniciar — ver logs `[INFO] Puerto X: RL=...dB`.
3. Un return loss < 8 dB indica antena no conectada o mal conectada.

---

## Estructura del proyecto

```
tracker-intra/
├── main.py                        # Entry point
├── config/
│   ├── zone_config.py             # Dataclasses: ZoneConfig, ReaderConfig, AntennaConfig
│   ├── zone_loader.py             # Carga archivos JSON de zonas
│   ├── exceptions.py              # Excepciones del sistema
│   └── zones/
│       └── zone_ejemplo.json      # Plantilla de configuración de zona
├── hardware/
│   ├── yr8900_protocol.py         # Protocolo binario YR8900 (TCP)
│   ├── reader_manager.py          # API alto nivel del lector
│   └── antenna_detection.py       # Detección física de antenas
├── src/
│   ├── core/
│   │   ├── models.py              # DetectionEvent, StoredDetection, SyncStatus
│   │   ├── tag_parser.py          # Extracción de EPC estable
│   │   └── zone_scanner.py        # Loop continuo de escaneo por zona
│   ├── data/
│   │   └── database.py            # SQLite local (buffer offline)
│   ├── network/
│   │   ├── backend_client.py      # HTTP POST al backend
│   │   └── sync_worker.py         # Hilo de reintento de pendientes
│   └── utils/
│       └── console.py             # Formatter de consola con colores
└── docs/
    └── BACKEND_API.md             # Contrato API para el equipo de backend
```

---

## Contrato con el backend

Este cliente está alineado con la Agent API del backend (`/api/agent/events`)
usando `Authorization: Bearer <tokenId>.<secret>`.
