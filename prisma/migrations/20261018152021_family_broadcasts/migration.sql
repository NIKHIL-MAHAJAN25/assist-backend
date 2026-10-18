-- CreateTable
CREATE TABLE "family_broadcasts" (
    "id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "from_user_id" TEXT NOT NULL,
    "sender_name" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "family_broadcasts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "family_broadcasts_patient_id_created_at_idx" ON "family_broadcasts"("patient_id", "created_at");
