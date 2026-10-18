-- CreateTable
CREATE TABLE "memories" (
    "id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "image_url" TEXT NOT NULL,
    "caption" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "creator_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "memories_patient_id_created_at_idx" ON "memories"("patient_id", "created_at");
