#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
API de alto nivel del lector RFID YR8900 (TCP).

Uso desde ZoneScanner:
    protocol = YR8900Protocol(zone_config.reader)
    manager  = ReaderManager(protocol)
    manager.test_connection()
    manager.set_output_power(zone_config.power_dbm)
"""

import logging
from typing import Dict, Optional, Tuple, Union

from config import ReaderConnectionError, AntennaError
from .yr8900_protocol import YR8900Protocol, CommandCodes
from .antenna_detection import AntennaDetector

logger = logging.getLogger(__name__)

class ReaderManager:
    """
    Gestor principal del lector YR8900.

    Acepta cualquier protocolo que implemente send_command() — tanto
    YR8900Protocol (TCP) como YR8900SerialProtocol (USB/serial).
    El protocolo lo crea connection_factory.create_protocol() antes de
    instanciar ReaderManager.
    """

    def __init__(self, protocol):
        """Args: protocol creado por hardware.connection_factory.create_protocol()."""
        self.protocol = protocol
        self.antenna_detector = AntennaDetector(self.protocol)

        self.is_connected = False
        self.firmware_version = None
        self.current_antenna = None
    
    def test_connection(self) -> bool:
        """Verifica conexión con el lector y obtiene versión de firmware.

        Returns:
            True si la conexión es exitosa.
        Raises:
            ReaderConnectionError: si no hay respuesta o los datos son inválidos.
        """
        try:
            logger.info("Probando conexión con YR8900...")
            
            result = self.protocol.send_command(CommandCodes.GET_FIRMWARE_VERSION)
            
            if not result.get("valid"):
                self.is_connected = False
                raise ReaderConnectionError(f"Respuesta inválida: {result.get('error')}")
            if not result.get("data") or len(result["data"]) < 2:
                self.is_connected = False
                raise ReaderConnectionError("Datos de firmware incompletos")
            major, minor = result["data"][0], result["data"][1]
            self.firmware_version = f"{major}.{minor}"
            self.is_connected = True
            logger.info("✓ Conectado - Firmware v%s", self.firmware_version)
            return True
        except ReaderConnectionError:
            self.is_connected = False
            raise
        except Exception as e:
            self.is_connected = False
            raise ReaderConnectionError(f"Error conectando al lector: {e}")
    
    def get_current_antenna(self) -> Optional[int]:
        """Retorna el puerto de antena activo (1-8), o None si hay error."""
        try:
            result = self.protocol.send_command(CommandCodes.GET_WORK_ANTENNA)
            
            if result.get("valid") and result.get("data"):
                antenna_port = result["data"][0] + 1  # Convertir de base 0 a base 1
                self.current_antenna = antenna_port
                logger.debug(f"Antena actual: {antenna_port}")
                return antenna_port
            
            logger.warning("No se pudo obtener antena actual")
            return None
            
        except Exception as e:
            logger.error(f"Error obteniendo antena actual: {e}")
            return None
    
    def set_antenna(self, port: int) -> bool:
        """Activa el puerto de antena indicado (1-8). Retorna True si exitoso."""
        if not 1 <= port <= 8:
            raise ValueError(f"Puerto fuera de rango: {port} (1-8)")
        
        try:
            result = self.protocol.send_command(
                CommandCodes.SET_WORK_ANTENNA,
                [port - 1]
            )

            if not result.get("valid"):
                logger.warning("Error cambiando a puerto de antena %d", port)
                return False

            self.current_antenna = port
            logger.debug("Antena activa: puerto %d", port)
            return True
            
        except Exception as e:
            logger.error(f"Error cambiando antena: {e}")
            return False
    
    def set_output_power(self, power_dbm: int) -> bool:
        """Configura la potencia RF de salida (0-33 dBm). Retorna True si exitoso."""
        if not 0 <= power_dbm <= 33:
            raise ValueError(f"Potencia fuera de rango: {power_dbm} (0-33 dBm)")
        
        try:
            result = self.protocol.send_command(CommandCodes.SET_OUTPUT_POWER, [power_dbm])
            if not result.get("valid"):
                return False
            logger.info("✓ Potencia configurada: %d dBm", power_dbm)
            return True
        except Exception as e:
            logger.error("Error configurando potencia: %s", e)
            return False
    
    def get_output_power(self) -> Optional[int]:
        """Retorna la potencia RF actual en dBm, o None si hay error."""
        try:
            result = self.protocol.send_command(CommandCodes.GET_OUTPUT_POWER)
            
            if result.get("valid") and result.get("data"):
                power = result["data"][0]
                logger.debug(f"Potencia actual: {power} dBm")
                return power
            
            return None
            
        except Exception as e:
            logger.error(f"Error obteniendo potencia: {e}")
            return None
    
    def get_reader_temperature(self) -> Optional[int]:
        """Retorna la temperatura interna del lector en °C, o None si hay error."""
        try:
            result = self.protocol.send_command(CommandCodes.GET_READER_TEMPERATURE)
            
            if result.get("valid") and result.get("data") and len(result["data"]) >= 2:
                sign = result["data"][0]  # 0x00=minus, 0x01=plus
                temp = result["data"][1]
                
                temperature = temp if sign == 0x01 else -temp
                logger.debug(f"Temperatura: {temperature}°C")
                return temperature
            
            return None
            
        except Exception as e:
            logger.error(f"Error obteniendo temperatura: {e}")
            return None
    
    def scan_antennas(self) -> Dict[int, Tuple[bool, int]]:
        """Escanea los 8 puertos de antena. Retorna {puerto: (conectada, return_loss)}."""
        if not self.is_connected:
            raise ReaderConnectionError(
                "Lector no conectado. Ejecute test_connection() primero"
            )
        
        logger.info("Iniciando escaneo de antenas físicas...")
        results = self.antenna_detector.scan_all_ports()
        logger.info(f"Escaneo completado: {len([r for r in results.values() if r[0]])}/8 antenas detectadas")
        
        return results
    
    def verify_antenna(self, port: int) -> bool:
        """Verifica que el puerto indicado (1-8) tenga una antena conectada."""
        if not self.is_connected:
            raise ReaderConnectionError("Lector no conectado")
        
        return self.antenna_detector.verify_antenna_connection(port)
    
    def get_system_status(self) -> Dict:
        """Retorna un dict con el estado completo: conexión, firmware, antena, potencia, temperatura."""
        status = {
            "connected": self.is_connected,
            "firmware_version": self.firmware_version,
            "current_antenna": self.get_current_antenna(),
            "power_dbm": self.get_output_power(),
            "temperature_c": self.get_reader_temperature()
        }
        
        return status