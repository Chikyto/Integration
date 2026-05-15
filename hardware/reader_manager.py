#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Gestión de alto nivel del lector RFID YR8900
timing_system/hardware/reader_manager.py
"""

import logging
from typing import Dict, Optional, Tuple

from config import ReaderConfig, ReaderConnectionError, AntennaError
from .yr8900_protocol import YR8900Protocol, CommandCodes
from .antenna_detection import AntennaDetector

logger = logging.getLogger(__name__)

class ReaderManager:
    """Gestor principal del lector YR8900"""
    
    def __init__(self, config: ReaderConfig):
        self.config = config
        self.protocol = YR8900Protocol(config)
        self.antenna_detector = AntennaDetector(self.protocol)
        
        self.is_connected = False
        self.firmware_version = None
        self.current_antenna = None
    
    def test_connection(self) -> bool:
        """
        Prueba conexión básica con el lector
        
        Returns:
            True si la conexión es exitosa
            
        Raises:
            ReaderConnectionError: Si hay error de conexión
        """
        try:
            logger.info("Probando conexión con YR8900...")
            
            result = self.protocol.send_command(CommandCodes.GET_FIRMWARE_VERSION)
            
            if not result.get("valid"):
                self.is_connected = False
                raise ReaderConnectionError(
                    f"Respuesta inválida: {result.get('error')}"
                )
            
            if not result.get("data") or len(result["data"]) < 2:
                self.is_connected = False
                raise ReaderConnectionError(
                    "Datos de firmware incompletos"
                )
            
            # Obtener versión del firmware
            major, minor = result["data"][0], result["data"][1]
            self.firmware_version = f"{major}.{minor}"
            self.is_connected = True
            
            logger.info(f"✓ Conectado - Firmware v{self.firmware_version}")
            return True
            
        except ReaderConnectionError:
            self.is_connected = False
            raise
        except Exception as e:
            logger.error(f"Error de conexión: {e}")
            self.is_connected = False
            raise ReaderConnectionError(f"Error conectando al lector: {str(e)}")
    
    def get_current_antenna(self) -> Optional[int]:
        """
        Obtiene la antena actualmente activa
        
        Returns:
            Número de puerto (1-8) o None si hay error
        """
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
        """
        Cambia a una antena específica
        
        Args:
            port: Número de puerto (1-8)
            
        Returns:
            True si el cambio fue exitoso
        """
        if not 1 <= port <= 8:
            raise ValueError(f"Puerto fuera de rango: {port} (1-8)")
        
        try:
            logger.info(f"Cambiando a antena puerto {port}")
            
            result = self.protocol.send_command(
                CommandCodes.SET_WORK_ANTENNA,
                [port - 1]
            )
            
            if not result.get("valid"):
                logger.error(f"Error cambiando a puerto {port}")
                return False
            
            self.current_antenna = port
            logger.info(f"✓ Cambiado a antena puerto {port}")
            return True
            
        except Exception as e:
            logger.error(f"Error cambiando antena: {e}")
            return False
    
    def set_output_power(self, power_dbm: int) -> bool:
        """
        Configura potencia de salida RF
        
        Args:
            power_dbm: Potencia en dBm (0-33)
            
        Returns:
            True si la configuración fue exitosa
        """
        if not 0 <= power_dbm <= 33:
            raise ValueError(f"Potencia fuera de rango: {power_dbm} (0-33 dBm)")
        
        try:
            logger.info(f"Configurando potencia: {power_dbm} dBm")
            
            result = self.protocol.send_command(
                CommandCodes.SET_OUTPUT_POWER,
                [power_dbm]
            )
            
            if not result.get("valid"):
                logger.error(f"Error configurando potencia")
                return False
            
            logger.info(f"✓ Potencia configurada: {power_dbm} dBm")
            return True
            
        except Exception as e:
            logger.error(f"Error configurando potencia: {e}")
            return False
    
    def get_output_power(self) -> Optional[int]:
        """
        Obtiene la potencia de salida actual
        
        Returns:
            Potencia en dBm o None si hay error
        """
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
        """
        Obtiene temperatura interna del lector
        
        Returns:
            Temperatura en grados Celsius o None si hay error
        """
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
        """
        Escanea todas las antenas físicamente conectadas
        
        Returns:
            Dict con resultados: {puerto: (conectada, return_loss)}
            
        Raises:
            ReaderConnectionError: Si el lector no está conectado
        """
        if not self.is_connected:
            raise ReaderConnectionError(
                "Lector no conectado. Ejecute test_connection() primero"
            )
        
        logger.info("Iniciando escaneo de antenas físicas...")
        results = self.antenna_detector.scan_all_ports()
        logger.info(f"Escaneo completado: {len([r for r in results.values() if r[0]])}/8 antenas detectadas")
        
        return results
    
    def verify_antenna(self, port: int) -> bool:
        """
        Verifica que una antena específica esté bien conectada
        
        Args:
            port: Puerto a verificar (1-8)
            
        Returns:
            True si la antena está correctamente conectada
        """
        if not self.is_connected:
            raise ReaderConnectionError("Lector no conectado")
        
        return self.antenna_detector.verify_antenna_connection(port)
    
    def get_system_status(self) -> Dict:
        """
        Obtiene estado completo del sistema
        
        Returns:
            Dict con información del estado
        """
        status = {
            "connected": self.is_connected,
            "firmware_version": self.firmware_version,
            "current_antenna": self.get_current_antenna(),
            "power_dbm": self.get_output_power(),
            "temperature_c": self.get_reader_temperature()
        }
        
        return status