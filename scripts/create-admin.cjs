const path = require('path');
const bcrypt = require(path.resolve(__dirname, '../services/auth-service/node_modules/bcrypt'));
const { PrismaClient: AuthPrisma } = require(path.resolve(__dirname, '../services/auth-service/node_modules/@prisma/client'));
const { PrismaClient: WalletPrisma } = require(path.resolve(__dirname, '../services/wallet-service/node_modules/@prisma/client'));

const authDb = new AuthPrisma({
  datasources: {
    db: {
      url: 'postgresql://postgres:8932ce4c6b28dba8c13430d3317b1e51e4f8838c6b02824423f9b57b69d56d4a@localhost:5432/auth_service?schema=public'
    }
  }
});

const walletDb = new WalletPrisma({
  datasources: {
    db: {
      url: 'postgresql://postgres:8932ce4c6b28dba8c13430d3317b1e51e4f8838c6b02824423f9b57b69d56d4a@localhost:5432/wallet_service?schema=public'
    }
  }
});

async function main() {
  const username = process.argv[2] || 'admin';
  const email = process.argv[3] || 'admin@finvault.com';
  const rawPassword = process.argv[4] || 'Admin@123456';

  console.log(`Creating/updating admin user: username=${username}, email=${email}`);
  const hashedPassword = await bcrypt.hash(rawPassword, 10);

  const adminUser = await authDb.user.upsert({
    where: { email },
    update: {
      username,
      password: hashedPassword,
      role: 'ADMIN',
      firstName: 'System',
      lastName: 'Admin'
    },
    create: {
      username,
      email,
      password: hashedPassword,
      role: 'ADMIN',
      firstName: 'System',
      lastName: 'Admin'
    }
  });

  console.log('✅ Admin user created/updated successfully:');
  console.log({
    id: adminUser.id,
    username: adminUser.username,
    email: adminUser.email,
    role: adminUser.role,
    password: rawPassword
  });

  // Ensure admin has a wallet in wallet_service
  const wallet = await walletDb.wallet.upsert({
    where: {
      userId_ownerType: {
        userId: adminUser.id,
        ownerType: 'USER'
      }
    },
    update: {
      status: 'ACTIVE'
    },
    create: {
      userId: adminUser.id,
      ownerType: 'USER',
      currency: 'VND',
      balance: 10000000.00,
      status: 'ACTIVE'
    }
  });

  console.log('✅ Admin wallet status in wallet_service:');
  console.log({
    walletId: wallet.id,
    userId: wallet.userId,
    balance: wallet.balance,
    status: wallet.status
  });
}

main()
  .catch(console.error)
  .finally(async () => {
    await authDb.$disconnect();
    await walletDb.$disconnect();
  });

