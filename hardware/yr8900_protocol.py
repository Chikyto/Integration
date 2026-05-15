#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Protocolo de comunicación con lector RFID YR8900
timing_system/hardware/yr8900_protocol.py
"""

import socket
import logging
from enum import Enum
from typing import List, Dict, Optional

from config import ReaderConfig, ProtocolError

logger = logging.getLogger(__name__)

class CommandCodes(Enum):
    """Códigos de comando según protocolo YR8900"""
    RESET = 0x70
    GET_FIRMWARE_VERSION = 0x72
    SET_READER_ADDRESS = 0x73
    SET_WORK_ANTENNA = 0x74
    GET_WORK_ANTENNA = 0x75
    SET_OUTPUT_POWER = 0x76
    GET_OUTPUT_POWER = 0x77
    SET_FREQUENCY_REGION = 0x78
    GET_FREQUENCY_REGION = 0x79
    SET_BEEPER_MODE = 0x7A
    GET_READER_TEMPERATURE = 0x7B
    GET_RF_PORT_RETURN_LOSS = 0x7E
    SET_ANT_CONNECTION_DETECTOR = 0x62
    GET_ANT_CONNECTION_DETECTOR = 0x63
    INVENTORY = 0x8B
    FAST_SWITCH_INVENTORY = 0x8A

class ErrorCodes(Enum):
    """Códigos de error del protocolo YR8900"""
    COMMAND_SUCCESS = 0x10
    COMMAND_FAIL = 0x11
    MCU_RESET_ERROR = 0x20
    CW_ON_ERROR = 0x21
    ANTENNA_MISSING = 0x22
    WRITE_FLASH_ERROR = 0x23
    READ_FLASH_ERROR = 0x24
    SET_OUTPUT_POWER_ERROR = 0x25
    TAG_INVENTORY_ERROR = 0x31
    TAG_READ_ERROR = 0x32
    TAG_WRITE_ERROR = 0x33
    TAG_LOCK_ERROR = 0x34
    TAG_KILL_ERROR = 0x35
    NO_TAG_ERROR = 0x36
    INVENTORY_OK_BUT_ACCESS_FAIL = 0x37
    BUFFER_IS_EMPTY_ERROR = 0x38
    ACCESS_OR_PASSWORD_ERROR = 0x40
    PARAMETER_INVALID = 0x41

class YR8900Protocol:
    """Manejo del protocolo de comunicación YR8900"""
    
    def __init__(self, config: ReaderConfig):
        self.config = config
        self._packet_head = 0xA0
    
    def calculate_checksum(self, packet: List[int]) -> int:
        """
        Calcula checksum según protocolo YR8900
        Checksum = (~sum(packet) + 1) & 0xFF
        """
        return (~sum(packet) + 1) & 0xFF
    
    def create_packet(self, cmd: CommandCodes, data: List[int] = None) -> bytes:
        """
        Crea paquete de comando según protocolo
        Formato: [HEAD][LEN][ADDR][CMD][DATA...][CHECKSUM]
        """
        if data is None:
            data = []
        
        # Construir paquete sin checksum
        packet = [
            self._packet_head,
            len(data) + 3,  # Length = data + addr + cmd + checksum (sin head y len)
            self.config.reader_address,
            cmd.value
        ]
        packet.extend(data)
        
        # Calcular y agregar checksum
        checksum = self.calculate_checksum(packet)
        packet.append(checksum)
        
        logger.debug(f"Paquete creado [{cmd.name}]: {[hex(b) for b in packet]}")
        
        return bytearray(packet)
    
    def parse_response(self, response: bytes) -> Dict:
        """
        Parsea respuesta del lector
        Returns: Dict con estructura de la respuesta
        """
        if not response or len(response) < 5:
            return {
                "valid": False,
                "error": "Respuesta muy corta o vacía",
                "raw": response.hex() if response else ""
            }
        
        try:
            head = response[0]
            length = response[1]
            address = response[2]
            cmd = response[3]
            data = list(response[4:-1]) if len(response) > 5 else []
            checksum = response[-1]
            
            # Validación básica
            if head != self._packet_head:
                return {
                    "valid": False,
                    "error": f"HEAD inválido: 0x{head:02X}",
                    "raw": response.hex()
                }
            
            result = {
                "valid": True,
                "head": head,
                "length": length,
                "address": address,
                "cmd": cmd,
                "data": data,
                "checksum": checksum,
                "raw": response.hex()
            }
            
            # Verificar si hay código de error en los datos
            if data and data[0] in [e.value for e in ErrorCodes]:
                error_code = ErrorCodes(data[0])
                result["error_code"] = error_code
                result["success"] = (error_code == ErrorCodes.COMMAND_SUCCESS)
            else:
                result["success"] = True
            
            logger.debug(f"Respuesta parseada: CMD=0x{cmd:02X}, Data={[hex(d) for d in data]}")
            
            return result
            
        except Exception as e:
            logger.error(f"Error parseando respuesta: {e}")
            return {
                "valid": False,
                "error": str(e),
                "raw": response.hex()
            }
    
    def send_command(self, cmd: CommandCodes, data: List[int] = None, 
                    timeout: float = None) -> Dict:
        """
        Envía comando al lector y recibe respuesta
        
        Args:
            cmd: Código de comando
            data: Datos del comando (opcional)
            timeout: Timeout en segundos (usa config.timeout si no se especifica)
            
        Returns:
            Dict con la respuesta parseada
        """
        timeout = timeout or self.config.timeout
        
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
                sock.settimeout(timeout)
                
                # Conectar
                sock.connect((self.config.host, self.config.port))
                logger.debug(f"Conectado a {self.config.host}:{self.config.port}")
                
                # Enviar comando
                packet = self.create_packet(cmd, data)
                sock.send(packet)
                logger.debug(f"Comando enviado: {cmd.name}")
                
                # Recibir respuesta
                response = sock.recv(1024)
                logger.debug(f"Respuesta recibida: {len(response)} bytes")
                
                # Parsear respuesta
                result = self.parse_response(response)
                
                if not result.get("valid"):
                    logger.warning(f"Respuesta inválida para {cmd.name}: {result.get('error')}")
                
                return result
                
        except socket.timeout:
            logger.error(f"Timeout en comando {cmd.name} después de {timeout}s")
            return {
                "valid": False,
                "error": "Timeout",
                "timeout": timeout
            }
            
        except ConnectionRefusedError:
            logger.error(f"Conexión rechazada a {self.config.host}:{self.config.port}")
            return {
                "valid": False,
                "error": "Conexión rechazada"
            }
            
        except Exception as e:
            logger.error(f"Error en comando {cmd.name}: {e}")
            return {
                "valid": False,
                "error": str(e)
            }
    
    def get_error_description(self, error_code: ErrorCodes) -> str:
        """Retorna descripción legible del código de error"""
        descriptions = {
            ErrorCodes.COMMAND_SUCCESS: "Comando exitoso",
            ErrorCodes.COMMAND_FAIL: "Comando falló",
            ErrorCodes.ANTENNA_MISSING: "Antena no conectada",
            ErrorCodes.TAG_INVENTORY_ERROR: "Error en inventario de tags",
            ErrorCodes.NO_TAG_ERROR: "No se detectaron tags",
            ErrorCodes.PARAMETER_INVALID: "Parámetro inválido",
        }
        return descriptions.get(error_code, f"Error desconocido: 0x{error_code.value:02X}")