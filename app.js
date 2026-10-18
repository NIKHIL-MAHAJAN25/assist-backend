const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const authRoutes = require('./routes/auth');
const ingestionRoutes = require('./routes/ingestion');
const logEntryRoutes = require('./routes/logEntries');
const geofenceZoneRoutes = require('./routes/geofenceZones');
const enrolledFaceRoutes = require('./routes/enrolledFaces');
const quizRoutes = require('./routes/quiz');
const recallRoutes = require('./routes/recall');
const patientRoutes = require('./routes/patients');
const publicTagRoutes = require('./routes/publicTag');
const accountRoutes = require('./routes/accounts');
const internalRoutes = require('./routes/internal');
const path = require('path');

const app = express();
// Behind Tailscale Funnel / a proxy: trust X-Forwarded-* so req.ip and https links are right.
app.set('trust proxy', true);

app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' })); // frames arrive as base64 in the JSON body

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// The page an NFC sticker opens. Short path so the URL fits small tags: /t/<code>.
app.get('/t/:code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'tag.html')));

// Natural-voice audio for the patient's phone (services/voiceService.js). Unguessable hashed names.
app.use('/tts', express.static(require('./services/voiceService').AUDIO_DIR, { maxAge: '30d', immutable: true }));

app.use('/api', authRoutes);
app.use('/api', ingestionRoutes);
app.use('/api', logEntryRoutes);
app.use('/api', geofenceZoneRoutes);
app.use('/api', enrolledFaceRoutes);
app.use('/api', quizRoutes);
app.use('/api', recallRoutes);
app.use('/api', patientRoutes);
app.use('/api', publicTagRoutes);
app.use('/api', accountRoutes);
app.use('/internal', internalRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
