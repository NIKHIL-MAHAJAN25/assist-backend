-- The watch gets its own command queue: commands carry the device they are for.
ALTER TABLE "device_commands" ADD COLUMN "target" TEXT NOT NULL DEFAULT 'phone';

CREATE INDEX "device_commands_patient_id_target_status_idx" ON "device_commands"("patient_id", "target", "status");
