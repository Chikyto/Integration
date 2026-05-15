const express = require("express");
const authMiddleware = require("../../middlewares/auth.middleware");
const roleMiddleware = require("../../middlewares/role.middleware");
const { getAlerts, resolveAlert } = require("./alert.controller");

const router = express.Router();

router.get("/", authMiddleware, getAlerts);
router.patch("/:id/resolve", authMiddleware, roleMiddleware("admin"), resolveAlert);

module.exports = router;
