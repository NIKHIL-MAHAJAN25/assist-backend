require('dotenv').config();
const bcrypt = require('bcryptjs');
const prisma = require('../config/prisma');

async function main() {
  const patient = await prisma.patient.create({
    data: { name: 'Demo Patient', dob: new Date('1950-01-01') },
  });

  const passwordHash = await bcrypt.hash('caregiver123', 10);
  const caregiver = await prisma.user.create({
    data: {
      name: 'Demo Caregiver',
      email: 'caregiver@example.com',
      passwordHash,
      role: 'family_caregiver',
      patientId: patient.id,
    },
  });

  console.log('Seeded patient:', patient.id);
  console.log('Seeded caregiver login: caregiver@example.com / caregiver123 (user id', caregiver.id, ')');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
