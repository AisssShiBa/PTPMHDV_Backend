ALTER TABLE "Wallet" ADD CONSTRAINT "wallet_held_balance_check" CHECK ("heldBalance" >= 0 AND "heldBalance" <= "balance");
