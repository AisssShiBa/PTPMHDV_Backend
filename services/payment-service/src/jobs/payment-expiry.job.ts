import { P2pService } from '../services/p2p.service';
import { WalletClient } from '../clients/wallet.client';
export const startPaymentExpiryJob = () => {
  const service = new P2pService(new WalletClient());
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await service.recover(); } catch { console.error('[Payment] Recovery retry'); }
    finally { running = false; }
  };
  setInterval(() => void tick(), 2000);
  void tick();
};
