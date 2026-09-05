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

const app = express();

app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' })); // frames arrive as base64 in the JSON body

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api', authRoutes);
app.use('/api', ingestionRoutes);
app.use('/api', logEntryRoutes);
app.use('/api', geofenceZoneRoutes);
app.use('/api', enrolledFaceRoutes);
app.use('/api', quizRoutes);
app.use('/api', recallRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
