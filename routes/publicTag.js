const express = require('express');
const { getPublicTag, postSighting } = require('../controllers/tagController');

// No auth on purpose: these are what a stranger's phone calls after tapping the NFC sticker.
const router = express.Router();

router.get('/public/tag/:code', getPublicTag);
router.post('/public/tag/:code/sighting', postSighting);

module.exports = router;
