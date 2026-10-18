-- CreateTable
CREATE TABLE "device_commands" (
    "id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_by" TEXT NOT NULL,
    "sender_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMP(3),
    "done_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3) NOT NULL,
    "error" TEXT,

    CONSTRAINT "device_commands_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "device_commands_patient_id_status_idx" ON "device_commands"("patient_id", "status");
