/**
 * Namespace Socket.IO para agentes RFID (/agent).
 *
 * Permite comunicación bidireccional entre el backend y las mini-PC:
 *   - Agente → Backend : agent_hello, agent_response
 *   - Backend → Agente : command  { type, commandId, payload }
 *
 * Autenticación: mismo mecanismo que la Agent API HTTP
 *   (Bearer <tokenId>.<secret> validado contra agentCredential).
 */

const { randomUUID } = require("crypto");
const agentService = require("../modules/agent/agent.service");
const { createInfraAlert, resolveInfraAlert } = require("../modules/alerts/alert.service");
const logger = require("../utils/logger");

// agentId → socket activo
const buildAgentConnectionKey = ({ hospitalId, agentId }) => {
  return `${hospitalId}:${agentId}`;
};

const connectedAgents = new Map();

// ------------------------------------------------------------------
// Inicialización del namespace
// ------------------------------------------------------------------

const initAgentNamespace = (io) => {
  const ns = io.of("/agent");

  // Middleware de autenticación con token de agente
  ns.use(async (socket, next) => {
    const authHeader = socket.handshake.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return next(new Error("Token requerido"));
    }

    const token = authHeader.slice("Bearer ".length).trim();

    try {
      socket.data.agent = await agentService.authenticateAgentToken(token);
      next();
    } catch (err) {
      next(new Error(err.message || "Token invalido"));
    }
  });

  ns.on("connection", (socket) => {
    const { agentId, hospitalId, name } = socket.data.agent;
    const connectionKey = buildAgentConnectionKey({ hospitalId, agentId });

    // Registrar el nuevo socket primero, luego desconectar el viejo.
    // Este orden garantiza que el disconnect handler del socket viejo
    // encuentre el nuevo ID en connectedAgents y no borre la entrada.
    const existing = connectedAgents.get(connectionKey);
    connectedAgents.set(connectionKey, socket);
    if (existing && existing.id !== socket.id) {
      existing.disconnect(true);
    }

    logger.info("agent_ws_connected", {
      agentId,
      hospitalId,
      agentName: name,
      socketId: socket.id,
    });

    // Auto-resolver alerta de desconexión previa si existía
    resolveInfraAlert({ hospitalId, agentId, alertType: "agent_disconnected" }).catch((err) =>
      logger.warn("infra_alert_resolve_failed", { agentId, hospitalId, err: err.message }),
    );

    // Agente se presenta con sus zonas activas
    socket.on("agent_hello", (data) => {
      logger.info("agent_hello", {
        agentId,
        deviceId: data?.deviceId,
        zones: data?.zones,
      });
    });

    // Agente responde a un comando enviado desde el backend
    socket.on("agent_response", (data) => {
      logger.info("agent_response", {
        agentId,
        commandId: data?.commandId,
        status: data?.status,
      });
    });

    socket.on("disconnect", (reason) => {
      // Solo borrar si sigue siendo el mismo socket (evitar race en reconexión)
      if (connectedAgents.get(connectionKey)?.id === socket.id) {
        connectedAgents.delete(connectionKey);

        // Crear alerta de infraestructura por desconexión del agente
        createInfraAlert({
          hospitalId,
          agentId,
          alertType: "agent_disconnected",
          message: `Agente "${name}" desconectado (${reason})`,
          metadata: { agentName: name, disconnectReason: reason },
        }).catch((err) =>
          logger.warn("infra_alert_create_failed", { agentId, hospitalId, err: err.message }),
        );
      }
      logger.info("agent_ws_disconnected", { agentId, hospitalId, reason });
    });
  });

  logger.info("agent_namespace_ready", { namespace: "/agent" });
  return ns;
};

// ------------------------------------------------------------------
// API de envío de comandos (para usar desde controllers u otros módulos)
// ------------------------------------------------------------------

/**
 * Envía un comando a un agente conectado.
 *
 * @param {string} agentId  - ID del agente destino
 * @param {string} type     - Nombre del comando (ej. "ping", "get_status")
 * @param {object} payload  - Datos opcionales del comando
 * @returns {string|null}   commandId generado, o null si el agente no está conectado
 */
const sendCommand = ({ hospitalId, agentId }, type, payload = {}) => {
  const socket = connectedAgents.get(buildAgentConnectionKey({ hospitalId, agentId }));
  if (!socket?.connected) {
    return null;
  }

  const commandId = randomUUID();
  socket.emit("command", { type, commandId, payload });

  logger.info("agent_command_sent", { hospitalId, agentId, type, commandId });
  return commandId;
};

/**
 * @returns {boolean} true si el agente tiene conexión WS activa
 */
const isAgentConnected = ({ hospitalId, agentId }) => {
  const socket = connectedAgents.get(buildAgentConnectionKey({ hospitalId, agentId }));
  return !!(socket?.connected);
};

/**
 * @returns {string[]} Lista de agentIds conectados en este momento
 */
const getConnectedAgents = ({ hospitalId } = {}) => {
  return Array.from(connectedAgents.values())
    .filter((socket) => {
      if (!socket?.connected) {
        return false;
      }

      if (!hospitalId) {
        return true;
      }

      return socket.data.agent?.hospitalId === hospitalId;
    })
    .map((socket) => ({
      agentId: socket.data.agent.agentId,
      hospitalId: socket.data.agent.hospitalId,
      name: socket.data.agent.name,
      socketId: socket.id,
    }));
};

module.exports = {
  initAgentNamespace,
  sendCommand,
  isAgentConnected,
  getConnectedAgents,
};
