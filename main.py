#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Sistema de Trackeo de Equipos Médicos RFID — Punto de entrada.

Arranca un ZoneScanner por cada zona en config/zones/, almacena detecciones
en SQLite y las envía al backend via HTTP. Sin interfaz gráfica.

Configuración: archivos JSON en config/zones/ (ver zone_ejemplo.json).
Logs: consola con colores (colorama) + tracker.log
"""

import logging
import signal
import sys
import threading
from pathlib import Path
from typing import List

# Carga variables de entorno desde .env (si existe) antes de cualquier config
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # python-dotenv opcional; usar variables de entorno del sistema

from config import load_all_zones, ZoneConfig
from config.device_config import load_device_config, DEVICE_CONFIG_PATH
from config.zone_loader import save_zone_config
from src.core.models import DetectionEvent, HardwareEvent
from src.core.zone_scanner import ZoneScanner
from src.data.database import DetectionDB
from src.network.backend_client import BackendClient
from src.network.sync_worker import SyncWorker
from src.network.temperature_worker import TemperatureWorker
from src.network.command_worker import CommandWorker
from src.utils.console import build_console_handler

# ------------------------------------------------------------------
# Configuración de logging: colores en consola + archivo plano
# ------------------------------------------------------------------

_file_handler = logging.FileHandler("tracker.log", encoding="utf-8")
_file_handler.setFormatter(logging.Formatter(
    "%(asctime)s [%(levelname)-8s] %(name)s: %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
))

logging.basicConfig(
    level=logging.INFO,
    handlers=[
        build_console_handler(),
        _file_handler,
    ],
)
logger = logging.getLogger(__name__)

# ------------------------------------------------------------------
# Directorio de configuración de zonas
# ------------------------------------------------------------------

ZONES_DIR = Path("config/zones")


# ------------------------------------------------------------------
# Lógica principal
# ------------------------------------------------------------------

def build_on_detection_callback(db: DetectionDB, clients: dict, zone_configs: dict):
    """
    Construye el callback que se registra en cada ZoneScanner.

    El callback:
        1. Almacena la detección en SQLite (bloqueante, rápido — disco local).
        2. Dispara el envío al backend en un hilo daemon para no bloquear el
           loop de escaneo. Si falla, SyncWorker reintentará.
        3. Si la zona/antena es crítica o de salida, también envía la alerta
           en un hilo separado para no añadir latencia al ciclo de escaneo.

    Args:
        db:           base de datos local compartida.
        clients:      dict {zone_id: BackendClient} con un cliente por zona.
        zone_configs: dict {zone_id: ZoneConfig} para leer category e is_exit.

    Returns:
        Función on_detection(event: DetectionEvent) -> None.
    """
    def on_detection(event: DetectionEvent) -> None:
        stored = db.store_detection(event)

        client = clients.get(event.zone_id)
        if not client:
            return

        # Envío al backend en hilo separado — el loop de escaneo no espera.
        def _send_event():
            if client.post_detection(event):
                db.mark_synced([stored.db_id])
            else:
                logger.debug(
                    "Backend no disponible para %s — detección #%d en cola",
                    event.zone_id, stored.db_id,
                )

        threading.Thread(target=_send_event, daemon=True).start()

        # Alerta dedicada cuando la clasificación efectiva es critical o exit.
        # La antena puede sobreescribir la clasificación de la zona.
        zone_cfg = zone_configs.get(event.zone_id)
        if zone_cfg:
            antenna_cfg = zone_cfg.antennas.get(event.antenna_port)
            effective_category = (
                antenna_cfg.category
                if antenna_cfg is not None and antenna_cfg.category is not None
                else zone_cfg.category
            )
            effective_is_exit = (
                antenna_cfg.is_exit
                if antenna_cfg is not None and antenna_cfg.is_exit is not None
                else zone_cfg.is_exit
            )
            if effective_category == "critical" or effective_is_exit:
                def _send_alert():
                    client.post_alert(
                        zone_id=event.zone_id,
                        tag_id=event.tag_id,
                        zone_name=event.zone_name,
                        category=effective_category,
                        is_exit=effective_is_exit,
                        antenna_port=event.antenna_port,
                        antenna_name=event.antenna_name,
                    )
                threading.Thread(target=_send_alert, daemon=True).start()

    return on_detection


_INFRA_EVENT_TYPES = frozenset({
    "antenna_disconnected", "antenna_ok",
    "reader_offline", "reader_online",
    "temperature_high", "temperature_ok",
})


def build_on_hardware_event_callback(clients: dict):
    """
    Construye el callback para eventos de hardware (ej. antena desconectada).

    Eventos de infraestructura (antenna_*, reader_*) se envían a
    POST /api/agent/infra-events para que el backend cree/resuelva alertas.
    Otros eventos se envían al endpoint genérico de eventos RFID.
    Si el backend no está disponible, el evento se descarta (no se persiste).
    """
    def on_hardware_event(event: HardwareEvent) -> None:
        client = clients.get(event.zone_id)
        if not client:
            return
        if event.event_type in _INFRA_EVENT_TYPES:
            def _send():
                client.post_infra_event(event)
            threading.Thread(target=_send, daemon=True).start()
        else:
            client.post_hardware_event(event)

    return on_hardware_event


def build_on_config_update_callback(
    zones_ref: list,
    scanner_threads_ref: list,
    on_detection,
    on_hardware_event,
    zone_configs_ref: dict,
):
    """
    Construye el callback que aplica una nueva config enviada por el backend.

    Cuando el admin guarda config desde el front, el backend pushea via WS.
    Este callback:
        1. Escribe los JSON de zona nuevos en config/zones/.
        2. Detiene los scanners actuales.
        3. Recarga las zonas desde disco.
        4. Arranca los nuevos scanners.

    Args:
        zones_ref:          lista mutable de ZoneConfig activas (se reemplaza in-place).
        scanner_threads_ref: lista mutable de (ZoneScanner, Thread) activos.
        on_detection:       callback de detección compartido.
        on_hardware_event:  callback de hardware compartido.
        zone_configs_ref:   dict mutable {zone_id: ZoneConfig} actualizado in-place
                            para que on_detection use la clasificación más reciente.
    """
    def on_config_update(config: dict) -> dict:
        zones_data = config.get("zones", [])
        if not zones_data:
            logger.warning("update_config: payload sin zonas — ignorado")
            return {"applied": False, "reason": "payload sin zonas"}

        logger.info("update_config: aplicando %d zona(s) nuevas...", len(zones_data))

        # 1. Escribir JSON de zonas y eliminar los de zonas que ya no existen
        try:
            new_zone_ids = {
                z.get("zone_id", "").strip()
                for z in zones_data
                if z.get("zone_id", "").strip()
            }
            for stale in ZONES_DIR.glob("*.json"):
                if stale.stem not in new_zone_ids:
                    stale.unlink()
                    logger.info("update_config: JSON eliminado (zona borrada): %s", stale.name)
            for zone_data in zones_data:
                save_zone_config(ZONES_DIR, zone_data)
        except Exception as exc:
            logger.error("update_config: error escribiendo JSONs: %s", exc)
            return {"applied": False, "reason": str(exc)}

        # 2. Detener scanners actuales
        for scanner, _ in scanner_threads_ref:
            scanner.stop()
        scanner_threads_ref.clear()

        # 3. Recargar zonas desde disco
        try:
            new_zones = load_all_zones(ZONES_DIR)
        except Exception as exc:
            logger.error("update_config: error recargando zonas: %s", exc)
            return {"applied": False, "reason": str(exc)}

        zones_ref.clear()
        zones_ref.extend(new_zones)

        # Actualizar el dict de configuraciones para que on_detection refleje
        # la nueva clasificación (category, is_exit) de cada zona.
        zone_configs_ref.clear()
        zone_configs_ref.update({z.zone_id: z for z in new_zones})

        # 4. Arrancar nuevos scanners
        new_threads = start_scanners(new_zones, on_detection, on_hardware_event)
        scanner_threads_ref.extend(new_threads)

        logger.info("update_config: %d zona(s) activas tras actualización", len(new_zones))
        return {"applied": True, "zones": [z.zone_id for z in new_zones]}

    return on_config_update


def start_scanners(
    zones: List[ZoneConfig],
    on_detection,
    on_hardware_event=None,
) -> List[tuple]:
    """
    Inicia un ZoneScanner y un Thread por cada zona habilitada.

    Args:
        zones:        lista de ZoneConfig a iniciar.
        on_detection: callback compartido entre todos los scanners.

    Returns:
        Lista de tuplas (ZoneScanner, Thread) para poder detenerlos.
    """
    scanner_threads = []
    for zone in zones:
        scanner = ZoneScanner(
            zone_config=zone,
            on_detection=on_detection,
            on_hardware_event=on_hardware_event,
        )
        thread = threading.Thread(
            target=scanner.start,
            name=f"Scanner-{zone.zone_id}",
            daemon=True,
        )
        scanner_threads.append((scanner, thread))
        thread.start()
        logger.info("Zona iniciada: %s (%s)", zone.zone_name, zone.zone_id)
    return scanner_threads


def main() -> int:
    """
    Punto de entrada principal del sistema de trackeo.

    Returns:
        0 si terminó normalmente, 1 si hubo error fatal en el arranque.
    """
    logger.info("=" * 60)
    logger.info("Sistema de Trackeo de Equipos Médicos RFID — Iniciando")
    logger.info("=" * 60)

    # 1. Configuración del dispositivo
    try:
        device = load_device_config(DEVICE_CONFIG_PATH)
    except Exception as exc:
        logger.error("No se pudo cargar config/device.json: %s", exc)
        return 1

    # 2. Cliente HTTP (necesario para descargar config remota si no hay JSONs)
    db = DetectionDB()
    if db.count_pending():
        logger.info("Detecciones pendientes en DB al arrancar: %d", db.count_pending())

    client = BackendClient(device_config=device)

    if client.has_auth_token():
        logger.info("Token de agente cargado para el backend.")
    else:
        logger.warning(
            "No se encontro token de agente. Defini RFID_BACKEND_TOKEN "
            "en el entorno o en un archivo .env."
        )

    auth_ok, auth_message = client.auth_diagnostic()
    if auth_ok:
        logger.info("Agent API OK: %s", auth_message)
    else:
        logger.warning("Agent API no validada al arranque: %s", auth_message)

    # 3. Cargar zonas — si no hay JSONs locales, descargar config del backend
    json_files = list(ZONES_DIR.glob("*.json")) if ZONES_DIR.is_dir() else []
    if not json_files:
        logger.info("Sin JSONs locales — descargando config desde el backend...")
        remote = client.fetch_runtime_config()
        if remote:
            ZONES_DIR.mkdir(parents=True, exist_ok=True)
            for zone_data in remote.get("zones", []):
                save_zone_config(ZONES_DIR, zone_data)
            logger.info("Config descargada: %d zona(s)", len(remote.get("zones", [])))
        else:
            logger.error(
                "No hay JSONs locales ni config remota disponible. "
                "Configure el agente desde el front antes de iniciar."
            )
            return 1

    try:
        zones = load_all_zones(ZONES_DIR)
    except Exception as exc:
        logger.error("No se pudieron cargar las zonas: %s", exc)
        return 1

    logger.info("Zonas activas: %d", len(zones))
    for zone in zones:
        logger.info(
            "  [%s] %s — %d antenas — %s:%d",
            zone.zone_id, zone.zone_name,
            len(zone.get_enabled_antennas()),
            zone.reader.host, zone.reader.port,
        )

    # 4. Callbacks: detecciones de tag + eventos de hardware
    clients      = {zone.zone_id: client for zone in zones}
    zone_configs = {zone.zone_id: zone for zone in zones}
    on_detection      = build_on_detection_callback(db, clients, zone_configs)
    on_hardware_event = build_on_hardware_event_callback(clients)

    # 5. Workers de fondo
    sync_worker = SyncWorker(db=db, client=client)
    sync_worker.start()

    temp_worker = TemperatureWorker(zones=zones, on_hardware_event=on_hardware_event)
    temp_worker.start()

    # 6. Scanner por zona + CommandWorker
    scanner_threads: list = []
    on_config_update = build_on_config_update_callback(
        zones_ref=zones,
        scanner_threads_ref=scanner_threads,
        on_detection=on_detection,
        on_hardware_event=on_hardware_event,
        zone_configs_ref=zone_configs,
    )
    command_worker = CommandWorker(
        device_config=device,
        db=db,
        zones=zones,
        on_config_update=on_config_update,
    )
    command_worker.start()

    scanner_threads.extend(start_scanners(zones, on_detection, on_hardware_event))

    # 7. Manejo de señales de parada
    stop_event = threading.Event()

    def handle_signal(signum, frame):
        logger.info("Señal de parada recibida (%d). Cerrando...", signum)
        stop_event.set()

    signal.signal(signal.SIGINT,  handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    logger.info("Sistema en ejecución. Presione Ctrl+C para detener.")
    # On Windows, threading.Event.wait() blocks in native code and never
    # receives SIGINT unless we return to the Python interpreter periodically.
    try:
        while not stop_event.wait(timeout=1.0):
            pass
    except KeyboardInterrupt:
        logger.info("Ctrl+C recibido. Cerrando...")

    # 8. Cierre ordenado
    logger.info("Deteniendo scanners...")
    for scanner, thread in scanner_threads:
        scanner.stop()
    sync_worker.stop()
    temp_worker.stop()
    command_worker.stop()

    logger.info("Sistema detenido correctamente.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
