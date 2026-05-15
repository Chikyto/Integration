const express = require("express");
const authMiddleware = require("../../middlewares/auth.middleware");
const roleMiddleware = require("../../middlewares/role.middleware");
const { createTagRfidBulk, getTagRfids, updateTagRfid } = require("./tag-rfid.controller");

const router = express.Router();

router.post("/bulk", authMiddleware, roleMiddleware("admin"), createTagRfidBulk);
router.get("/", authMiddleware, getTagRfids);
router.patch("/:id", authMiddleware, roleMiddleware("admin"), updateTagRfid);

module.exports = router;
