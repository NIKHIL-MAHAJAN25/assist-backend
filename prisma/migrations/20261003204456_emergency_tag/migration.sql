-- AlterEnum
ALTER TYPE "LogEntryType" ADD VALUE 'sighting';

-- AlterTable
ALTER TABLE "patients" ADD COLUMN     "home_label" TEXT,
ADD COLUMN     "tag_code" TEXT,
ADD COLUMN     "tag_note" TEXT,
ADD COLUMN     "tag_show_home" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "emergency_contacts" (
    "id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "relation" TEXT,
    "phone" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "emergency_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "patients_tag_code_key" ON "patients"("tag_code");

-- AddForeignKey
ALTER TABLE "emergency_contacts" ADD CONSTRAINT "emergency_contacts_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

