-- CreateTable
CREATE TABLE "ai_jobs" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "patient_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "avoid_provider" TEXT,
    "provider" TEXT,
    "worker_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "ai_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_jobs_status_created_at_idx" ON "ai_jobs"("status", "created_at");
