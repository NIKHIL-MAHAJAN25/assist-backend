-- AlterTable
ALTER TABLE "patients" ADD COLUMN     "bedtime_story_at" TEXT DEFAULT '21:00';

-- CreateTable
CREATE TABLE "watch_rules" (
    "id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "creator_name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "label" TEXT NOT NULL,
    "repeat" TEXT NOT NULL DEFAULT 'once',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_fired_at" TIMESTAMP(3),
    "fired_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watch_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "family_events" (
    "id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "ref_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "family_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "watch_rules_patient_id_active_idx" ON "watch_rules"("patient_id", "active");

-- CreateIndex
CREATE INDEX "family_events_patient_id_created_at_idx" ON "family_events"("patient_id", "created_at");
