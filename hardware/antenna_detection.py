#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Detección de antenas físicas mediante medición de return loss.

Return loss (pérdida de retorno) es la relación en dB entre la potencia
enviada a la antena y la potencia reflejada de vuelta.
    - Antena bien conectada: return loss alto (≥ 8 dB típicamente).
    - Puerto sin antena:      return loss bajo o cero.

El YR8900 expone el comando GET_RF_PORT_RETURN_LOSS (0x7E) que mide
el return loss en el puerto activo a una frecuencia dada (0x21 = 915 MHz).

Uso típico al iniciar una zona:
    detector = AntennaDetector(protocol)
    results  = detector.scan_all_ports(range(1, 5))  # puertos 1-4
    connected = [p for p, (ok, _) in results.items() if ok]
"""

import time
import logging
from typing import Dict, Tuple

from config import AntennaError
from .yr8900_protocol import YR8900Protocol, CommandCodes

logger = logging.getLogger(__name__)

class AntennaDetector:
    """Detector de antenas físicamente conectadas"""
    
    def __init__(self, protocol: YR8900Protocol):
        self.protocol = protocol
        self.return_loss_threshold = 8  # dB mínimo para considerar antena conectada
        self.test_frequency = 0x21  # Parámetro de frecuencia 915 MHz
    
    def set_threshold(self, threshold_db: int):
        """Configura el umbral de return loss para detección"""
        if not 0 <= threshold_db <= 50:
            raise ValueError(f"Umbral fuera de rango: {threshold_db} (0-50 dB)")
        
        self.return_loss_threshold = threshold_db
        logger.info(f"Umbral de return loss configurado: {threshold_db} dB")
    
    def detect_physical_antenna(self, port: int) -> Tuple[bool, int]:
        """
        Detecta si hay una antena física conectada en el puerto
        
        Args:
            port: Número de puerto (1-8)
            
        Returns:
            Tuple (conectada: bool, return_loss: int)
            
        Raises:
            AntennaError: Si hay error en la detección
        """
        if not 1 <= port <= 8:
            raise AntennaError(f"Puerto fuera de rango: {port} (debe ser 1-8)")
        
        try:
            logger.debug(f"Iniciando detección física en puerto {port}")
            
            # Paso 1: Cambiar a la antena específica
            set_result = self.protocol.send_command(
                CommandCodes.SET_WORK_ANTENNA,
                [port - 1]  # Convertir a índice base 0
            )
            
            if not set_result.get("valid"):
                raise AntennaError(
                    f"Error cambiando a puerto {port}: {set_result.get('error')}"
                )
            
            # Pausa para estabilización
            time.sleep(0.5)
            
            # Paso 2: Medir return loss
            rl_result = self.protocol.send_command(
                CommandCodes.GET_RF_PORT_RETURN_LOSS,
                [self.test_frequency],
                timeout=3.0
            )
            
            if not rl_result.get("valid"):
                raise AntennaError(
                    f"Error midiendo return loss puerto {port}: {rl_result.get('error')}"
                )
            
            if not rl_result.get("data"):
                raise AntennaError(
                    f"Sin datos de return loss para puerto {port}"
                )
            
            # Obtener valor de return loss
            return_loss = rl_result["data"][0]
            
            # Determinar si está conectada
            is_connected = return_loss >= self.return_loss_threshold
            
            status = "CONECTADA" if is_connected else "NO CONECTADA"
            logger.info(
                f"Puerto {port}: RL={return_loss}dB, {status} "
                f"(umbral={self.return_loss_threshold}dB)"
            )
            
            return is_connected, return_loss
            
        except AntennaError:
            raise
        except Exception as e:
            logger.error(f"Error inesperado detectando puerto {port}: {e}")
            raise AntennaError(f"Error en detección puerto {port}: {str(e)}")
    
    def scan_all_ports(self, ports_to_scan: range = None) -> Dict[int, Tuple[bool, int]]:
        """
        Escanea todos los puertos especificados
        
        Args:
            ports_to_scan: Rango de puertos a escanear (default: 1-8)
            
        Returns:
            Dict con resultados: {puerto: (conectada, return_loss)}
        """
        if ports_to_scan is None:
            ports_to_scan = range(1, 9)  # Puertos 1-8
        
        logger.info(f"Iniciando escaneo de puertos: {list(ports_to_scan)}")
        
        results = {}
        
        for port in ports_to_scan:
            try:
                logger.info(f"Escaneando puerto {port}...")
                is_connected, return_loss = self.detect_physical_antenna(port)
                results[port] = (is_connected, return_loss)
                
                # Pausa entre mediciones
                time.sleep(0.5)
                
            except AntennaError as e:
                logger.error(f"Error en puerto {port}: {e}")
                results[port] = (False, 0)
            except Exception as e:
                logger.error(f"Error inesperado en puerto {port}: {e}")
                results[port] = (False, 0)
        
        # Resumen
        connected_ports = [p for p, (conn, _) in results.items() if conn]
        disconnected_ports = [p for p, (conn, _) in results.items() if not conn]
        
        logger.info(f"Escaneo completado:")
        logger.info(f"  Conectadas: {connected_ports}")
        logger.info(f"  No conectadas: {disconnected_ports}")
        logger.info(f"  Total: {len(connected_ports)}/{len(results)} antenas detectadas")
        
        return results
    
    def verify_antenna_connection(self, port: int, min_return_loss: int = None) -> bool:
        """
        Verifica que una antena esté bien conectada
        
        Args:
            port: Puerto a verificar
            min_return_loss: Return loss mínimo esperado (opcional)
            
        Returns:
            True si la antena cumple los requisitos
        """
        threshold = min_return_loss or self.return_loss_threshold
        
        try:
            is_connected, return_loss = self.detect_physical_antenna(port)
            
            if not is_connected:
                logger.warning(f"Puerto {port}: Antena no detectada (RL={return_loss}dB)")
                return False
            
            if return_loss < threshold:
                logger.warning(
                    f"Puerto {port}: Return loss bajo (RL={return_loss}dB < {threshold}dB)"
                )
                return False
            
            logger.info(f"Puerto {port}: Verificación exitosa (RL={return_loss}dB)")
            return True
            
        except Exception as e:
            logger.error(f"Error verificando puerto {port}: {e}")
            return False