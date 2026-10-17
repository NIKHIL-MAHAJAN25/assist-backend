const prisma = require('../config/prisma');
const { analyzeFrame } = require('../services/geminiService');
const { uploadFrame } = require('../services/cloudinaryService');
const { decideFor } = require('../services/decisionService');

// Phase 0: single Gemini call, no short-term memory context, no agentic decision layer.
// agent_decision stays null until Phase 1 wires up the two-step decision layer (ai-prompting-patterns.md §3).
async function ingestFrame(req, res) {
  const { device_id, image, captured_at } = req.body;
  if (!device_id || !image) return res.status(400).json({ error: 'device_id and image are required' });

  const device = req.device;
  const analysis = await analyzeFrame({ base64Image: image });
  const imagePublicId = await uploadFrame(image);

  const logEntry = await prisma.logEntry.create({
    data: {
      patientId: device.patientId,
      deviceId: device.id,
      entryType: 'frame',
      timestamp: captured_at ? new Date(captured_at) : new Date(),
      payload: analysis,
      requiresAttention: analysis.requires_attention,
      imagePublicId,
    },
  });

  const decision = await decideFor(logEntry.id);
  const requiresAttention = decision?.decided_by === 'drex' ? decision.drex.notify || logEntry.requiresAttention : logEntry.requiresAttention;
  res.status(201).json({ log_entry_id: logEntry.id, requires_attention: requiresAttention });
}

module.exports = { ingestFrame };
