import prisma from './db.js';

const user = await prisma.user.create({
  data: { phoneNumber: '+40722510399', name: 'Test' },
});
console.log(user);